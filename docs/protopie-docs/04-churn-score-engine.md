# 04 — Churn Score Engine

> The score is `Σ (sub_score_factor × max_points_factor)` over the active factors of the current config, clamped to `[0, max_score]`. Sub-score for each factor = `LEAST(raw_value / goal_value, 1)` in the linear case.

## Scoring ownership (v1 architecture, locked)

> **Backend computes the score. dbt does NOT.**

The split:

1. **dbt** (in the data-modeling repo) computes the per-Account *measured values* — `pct_users_with_starting_action`, `starting_actions_per_user`, etc. — and exposes them in `mart_account_usage_90d`. dbt never knows the weights or the formula.
2. **Backend** (Protopie module) reads `mart_account_usage_90d` via Lightdash's `WarehouseClient`, loads the active scoring config + factors from Postgres, applies the weights, writes `protopie_churn_score` rows in Postgres.
3. **dbt staging** *then* surfaces those Postgres score rows back as a Lightdash explore (`mart_churn_score_latest`) for dashboards. This is a one-way trip — Postgres → Redshift → Lightdash UI.

This is **deliberately asymmetric**. Computing the score in dbt requires weights to live in the warehouse (or be passed in as Jinja vars), which makes weight tuning a dbt deploy. Computing in the backend lets sales adjust weights via the API and trigger a recompute job without touching the data platform. Once the deferred "good to have" arrives (Salesforce join, alerting), the same boundary holds: dbt enriches data, backend computes derived metrics that need configurability.

> ⚠ Do NOT compute the score in dbt SQL — even as a "convenience model". If you do, dashboards will silently disagree with the backend score. The only correct source of "the current churn score for Account X" is `protopie_churn_score` in Postgres → `mart_churn_score_latest` in the warehouse via staging.

## Two history models — choose one

| Model | What it means | Pros | Cons |
|-------|---------------|------|------|
| **As-was history** | Past `protopie_churn_score` rows keep their `config_uuid`. Score trend = the rubric in effect on each scored date. | Faithful audit. "Account X scored 65 on March 10" remains true forever. | Rubric changes show up as discontinuities in trend charts. |
| **Recomputed history** | Changing weights triggers a backfill that rewrites past scored dates against the new config. | Trend charts are smooth and use a single rubric. | Rewrites history; harder to defend "why did this score change". |

**v1 default: as-was.** Dashboards filter to the latest `config_uuid` for "current state" tiles but can show the trend across configs for "long-range" tiles. Admin tooling exposes an explicit "Recompute history with new rubric" action that creates a new run against the new config across all past dates — opt-in, not automatic.

## Split of responsibilities

```
┌─────────────────────────────────────────────────────────────────────┐
│ WAREHOUSE (dbt)                                                     │
│                                                                     │
│   raw.amplitude_events                                              │
│        │                                                            │
│        ▼                                                            │
│   stg_amplitude__events                                             │
│        │                                                            │
│        ▼                                                            │
│   int_account_user_event_counts                                     │
│   (per Account × user × event × 90d-window aggregates)              │
│        │                                                            │
│   dim_churn_score_event_groups (seed)  ──┐                          │
│                                          ▼                          │
│   int_account_event_group_counts                                    │
│   (per Account × user × factor_key — OR semantics resolved)         │
│        │                                                            │
│        ▼                                                            │
│   mart_account_usage_90d                                            │
│   (per Account: total_users, per-factor raw values)                 │
└──────────────┬──────────────────────────────────────────────────────┘
               │                                  ↑
               │   (Redshift SELECT via warehouse client) │
               ▼                                  │
┌─────────────────────────────────────────────────────────────────────┐
│ BACKEND (Lightdash, Protopie module)                                │
│                                                                     │
│   ChurnScoreService.recomputeAll()                                  │
│      1. Load active config + factors → protopie_churn_score_configs │
│         + protopie_churn_score_factors                              │
│      2. For each Account, fetch its usage row from mart_…           │
│      3. Apply scoring function (linear / stepwise) per factor       │
│      4. Sum sub-scores → total_score (+ score_percent, risk_band)   │
│      5. Apply overrides from protopie_account_overrides             │
│      6. Upsert protopie_churn_score (with factor_scores JSONB)      │
│      7. Optionally write protopie_churn_score_factor_results        │
│      8. Write protopie_churn_score_runs row (status, watermark)     │
└─────────────────────────────────────────────────────────────────────┘
```

**Why split.** dbt is good at heavy SQL aggregation against the warehouse. The backend is good at applying configurable weights and writing to Postgres. Trying to do all of this in dbt alone makes weight changes require a dbt run; doing all of it in the backend means giant SQL queries that aren't reusable in other dashboards.

## dbt models — pre-existing pieces we build on

The data-modeling repo already provides everything we need on the warehouse side:

| Existing model | What it gives us |
|---------------|-------------------|
| `stg_amplitude_protopie_all_events` (incremental, partition-pruned via Redshift Spectrum) | All Amplitude events — `event_type`, `user_id`, `event_time`, `event_properties`, `client_upload_time`. **No `team_id`** — must be joined via `event_properties` or via user→team mapping. |
| `dim_product_all_events` (incremental, `lightdash`-tagged) | Unified Amplitude + Cloud event log: `event_source`, `event_time`, `event_name`, `event_id`, `user_id`, `device_group`. Already joined to teams/pies/users in `meta`. |
| `dim_product_all_event_properties` | Extracted event properties including `pie_id`, `team_id`. The link between events and Accounts. |
| `dim_team_summary` (`lightdash`-tagged) | Accounts: `team_id`, `namespace`, `url` (`cloud_url`), `max_seats`, `plan_type`, `plan_id`, `start_date`, `end_date`, seat counts. |
| `dim_enterprise_summary` (`lightdash`-tagged) | Enterprise Cloud customers, keyed by `namespace`; joined to MRR, contracted seats. |
| `dim_latest_plan` | Per-user current paid plan — source of `plan_tier` (Pro vs Pro Plus Plus). |
| `stg_all_teams_users`, `stg_all_users` | Team-user membership and active-user state. |

This is significant — the **mart layer that powers the Account 360 dashboard is already half-built**. Our Protopie additions only need to compute (a) the 90-day usage aggregates *per team* needed by the score and (b) the score itself. The dashboards reuse the existing dims via the Lightdash `meta.joins` already declared on those models.

## dbt models — new (Protopie additions)

### `dim_churn_score_event_groups` (seed) — declarative OR semantics

The Notion brief calls for *event groups*: "Starting Action" is a single factor whose actual value is computed by OR-ing across four Amplitude event names. Hard-coding event lists inside the mart SQL works for v1 but rots quickly when sales tunes the rubric. Instead, ship a small **dbt seed** that maps `event_name → factor_key`:

```csv
# dbt/seeds/protopie/dim_churn_score_event_groups.csv
factor_key,event_name
starting_action,Studio - App - Launched
starting_action,Cloud - Studio - Launched
starting_action,session_start
starting_action,Cloud - Page - Entered
activation,Studio - Login - Completed
activation,editor_activated
pie_action,Studio - Pie - Created
pie_action,Studio - Pie - Opened
pie_action,Studio - Pie - Saved
pie_action,Studio - Plugin - Imported
pie_action,Studio - Preview - Opened
ai_usage,Studio - AI - Prompt Sent
ai_usage,Studio - AI Panel - Panel Toggled
trigger_response,Studio - Response Interaction - Added
trigger_response,Studio - Trigger Interaction - Added
```

A `dbt test` (`unique_combination_of_columns: [factor_key, event_name]`) keeps it sane. A parity test compares this CSV against the `event_group.events[]` arrays in `protopie_churn_score_factors` — when sales edits a factor's events via the backend API, CI fails until the seed is updated. This is the **one** explicit drift gate between the operational (Postgres) rubric and the analytical (dbt) event lists.

### `int_protopie_account_bridge` (intermediate — Account identity reconciliation)

Before any usage aggregation, we materialize a canonical bridge mapping every key candidate to the Account identity. This is the **single source of truth** for "what team does this event/Salesforce row/form submission belong to?"

```sql
-- models/intermediate/protopie/int_protopie_account_bridge.sql
{{ config(materialized='table', tags=['protopie']) }}

with teams as (
    select
        team_id,
        namespace,
        url           as cloud_url,
        deleted_at
    from {{ ref('dim_team_summary') }}
    where deleted_at is null
),
-- (placeholder) when Salesforce dim ships, left-join it on namespace or cloud_url
sf as (
    select null::varchar as salesforce_account_id, null::varchar as namespace
    where 1 = 0
),
bridge as (
    select
        t.team_id                                    as account_key,
        t.namespace,
        t.cloud_url,
        coalesce(sf.salesforce_account_id, null)     as salesforce_account_id
    from teams t
    left join sf on sf.namespace = t.namespace
)
select * from bridge
```

**What this gives us:**

1. A single place where Account-key alternatives are reconciled. Every other model joins to this bridge instead of inventing its own mapping logic.
2. A clear failure mode: if `team_id` ever stops being unique or globally addressable (e.g., Enterprise installs that don't surface in `dim_team_summary`), this model fails dbt's `unique(account_key)` test and we discover it before downstream dashboards break.

### Validation queries (run before declaring v1 done)

```sql
-- 1. No duplicate team_id in the bridge
SELECT account_key, COUNT(*) FROM int_protopie_account_bridge
GROUP BY 1 HAVING COUNT(*) > 1;
-- Expected: 0 rows.

-- 2. Every event with a team_id resolves to a known team
SELECT COUNT(*) AS orphan_events
FROM dim_product_all_event_properties ep
LEFT JOIN int_protopie_account_bridge b
    ON ep.team_id = b.account_key
WHERE ep.team_id IS NOT NULL AND b.account_key IS NULL;
-- Expected: 0. If > 0, list the team_ids and decide whether they're (a) deleted teams, (b) Enterprise installs missing from dim_team_summary, or (c) data bugs.

-- 3. How many events have NO team_id at all (excluded from per-Account aggregates)?
SELECT
    DATE_TRUNC('month', e.event_time) AS month,
    SUM(CASE WHEN ep.team_id IS NULL THEN 1 ELSE 0 END)::float / COUNT(*) AS pct_unattributed
FROM dim_product_all_events e
LEFT JOIN dim_product_all_event_properties ep ON e.event_id = ep.event_id
WHERE e.event_time >= dateadd(day, -90, current_date)
GROUP BY 1 ORDER BY 1;
-- Expected: high pct for pre-signup events ('Studio - App - Launched' often has no team_id),
-- low pct for in-team events. If pct > 30% for any factor's event group, the score may be biased.

-- 4. Enterprise customers — confirm all are represented
SELECT es.namespace
FROM dim_enterprise_summary es
LEFT JOIN int_protopie_account_bridge b ON b.namespace = es.namespace
WHERE b.account_key IS NULL;
-- Expected: 0 rows. Otherwise we have Enterprise customers without team_id mapping.
```

Run these as part of the Phase 1 acceptance check and add them as automated dbt tests on the bridge model.

### `int_protopie_team_user_event_counts` (intermediate)

Counts events per user per team (Account) over the rolling 90-day window. Joins the unified event log to event properties to recover `team_id`. Redshift dialect.

```sql
-- models/intermediate/protopie/int_protopie_team_user_event_counts.sql
{{ config(materialized='table', tags=['protopie', 'lightdash']) }}

with events as (
    select
        e.event_name,
        e.event_time,
        e.user_id,
        ep.team_id
    from {{ ref('dim_product_all_events') }} e
    left join {{ ref('dim_product_all_event_properties') }} ep
        on e.event_id = ep.event_id
    where e.event_time >= dateadd(day, -90, current_timestamp)
      and ep.team_id is not null
)
select
    team_id,
    user_id,
    event_name,
    count(*)                         as event_count,
    min(event_time)                  as first_event_at,
    max(event_time)                  as last_event_at,
    count(distinct trunc(event_time)) as active_days
from events
group by 1, 2, 3
```

**Why join via event properties.** Amplitude doesn't directly stamp `team_id` on every event; `dim_product_all_event_properties` extracts it from `event_properties` JSON. Some events (e.g., signup before joining a team) won't have a `team_id` — they are excluded from per-Account aggregates, which is correct for churn analysis.

### `mart_account_usage_90d` (mart)

One row per team (Account), with the metrics every scoring factor needs. **This is the table the backend reads at score-compute time.** The SQL **joins the `dim_churn_score_event_groups` seed** instead of hard-coding event names — sales tuning factor membership only requires editing the seed CSV and re-running dbt. Redshift dialect — no `safe_divide`, use `nullif`.

#### How formula factors map to dbt event groups

Each row in the seed has `(factor_key, event_name)`. A factor like "starting_action" has 4 event rows; "ai_usage" has 2. The mart pivots these into one column per factor by joining the intermediate event counts to the seed and conditionally aggregating:

```
seed.factor_key='starting_action' → mart.users_with_starting_action, .starting_action_events
seed.factor_key='activation'      → mart.activated_users
seed.factor_key='pie_action'      → mart.users_with_pie_action, .pie_action_events
seed.factor_key='ai_usage'        → mart.users_with_ai_usage
seed.factor_key='trigger_response' → mart.users_with_trigger_response, .trigger_response_events
```

The `active_days` factor doesn't use the seed — it's a count of distinct event dates per Account regardless of event name, computed directly in the intermediate model.

```sql
-- models/marts/warehouse/protopie/daily/mart_account_usage_90d.sql
{{ config(
    materialized='table',
    tags=['protopie', 'lightdash'],
    meta={
        "label": "[Protopie] Account Usage (90d)",
        "joins": [
            {
                "join": "dim_team_summary",
                "label": "Team Summary",
                "sql_on": "${mart_account_usage_90d.team_id} = ${dim_team_summary.team_id}"
            },
            {
                "join": "dim_enterprise_summary",
                "label": "Enterprise Summary",
                "sql_on": "${dim_team_summary.namespace} = ${dim_enterprise_summary.namespace}"
            }
        ]
    }
) }}

with
    base as (
        select * from {{ ref('int_protopie_team_user_event_counts') }}
    ),
    groups as (
        select factor_key, event_name from {{ ref('dim_churn_score_event_groups') }}
    ),
    -- Join events to factors via the seed, then aggregate per (team, factor).
    -- One event can belong to multiple factors via separate seed rows.
    base_with_factor as (
        select
            b.team_id,
            b.user_id,
            b.event_count,
            b.active_days,
            g.factor_key
        from base b
        inner join groups g on b.event_name = g.event_name
    ),
    per_factor as (
        select
            team_id,
            factor_key,
            count(distinct user_id)     as users_with_event,
            sum(event_count)            as events_total
        from base_with_factor
        group by 1, 2
    ),
    -- Pivot the long-form per_factor table back to the wide shape the backend expects
    factors as (
        select
            b.team_id,
            count(distinct b.user_id) as total_users,

            max(case when pf.factor_key = 'starting_action'   then pf.users_with_event end) as users_with_starting_action,
            max(case when pf.factor_key = 'starting_action'   then pf.events_total end)     as starting_action_events,
            max(case when pf.factor_key = 'activation'        then pf.users_with_event end) as activated_users,
            max(case when pf.factor_key = 'pie_action'        then pf.users_with_event end) as users_with_pie_action,
            max(case when pf.factor_key = 'pie_action'        then pf.events_total end)     as pie_action_events,
            max(case when pf.factor_key = 'ai_usage'          then pf.users_with_event end) as users_with_ai_usage,
            max(case when pf.factor_key = 'trigger_response'  then pf.users_with_event end) as users_with_trigger_response,
            max(case when pf.factor_key = 'trigger_response'  then pf.events_total end)     as trigger_response_events,

            max(b.active_days) as max_active_days_any_user
        from base b
        left join per_factor pf on pf.team_id = b.team_id
        group by b.team_id
    ),
    final as (
        select
            team_id,
            total_users,
            users_with_starting_action,
            starting_action_events,
            activated_users,
            pie_action_events,
            users_with_pie_action,
            users_with_ai_usage,
            users_with_trigger_response,
            trigger_response_events,
            max_active_days_any_user,

            users_with_starting_action::numeric / nullif(total_users, 0)   as pct_users_with_starting_action,
            starting_action_events::numeric    / nullif(total_users, 0)    as starting_actions_per_user,
            activated_users::numeric           / nullif(total_users, 0)    as pct_activated_users,
            pie_action_events::numeric         / nullif(total_users, 0)    as pie_actions_per_user,
            users_with_pie_action::numeric     / nullif(total_users, 0)    as pct_users_with_pie_action,
            users_with_ai_usage::numeric       / nullif(total_users, 0)    as pct_users_with_ai_usage,
            users_with_trigger_response::numeric / nullif(total_users, 0)  as pct_users_with_trigger_response,
            trigger_response_events::numeric   / nullif(total_users, 0)    as trigger_response_per_user,
            max_active_days_any_user                                       as active_days
        from factors
    )
select * from final
```

The `meta.joins` block lets Lightdash auto-wire this mart to `dim_team_summary` and `dim_enterprise_summary` — sales filtering by Account name, plan tier, CSM owner, MRR, license dates all comes for free through these existing joins.

**Note.** The event-list grouping is now declarative: the dbt seed `dim_churn_score_event_groups` is the single source of truth on the analytical side, and the parity test compares it against `protopie_churn_score_factors.event_group` on the operational side. Sales tuning a factor's events via the API still requires a CSV update in dbt — captured by the parity test failing in CI.

## Backend: scoring function

```ts
// packages/backend/src/protopie/services/ChurnScoreService.ts — sketch
type AccountUsageRow = {
    team_id: string;            // the Account key in the warehouse
    pct_users_with_starting_action: number;
    starting_actions_per_user: number;
    pct_activated_users: number;
    pie_actions_per_user: number;
    pct_users_with_pie_action: number;
    pct_users_with_ai_usage: number;
    pct_users_with_trigger_response: number;
    trigger_response_per_user: number;
    active_days: number;
};

type Rule = {
    rule_key: string;          // 'pct_users_with_starting_action'
    weight: number;            // e.g. 5
    goal_numeric: number;      // e.g. 0.5
    scoring_function: 'linear' | 'step';
    step_thresholds?: Array<{ threshold: number; points: number }>;
};

function subScore(rule: Rule, actualValue: number): number {
    if (rule.scoring_function === 'linear') {
        return Math.min(actualValue / rule.goal_numeric, 1) * rule.weight;
    }
    // step: sorted descending by threshold; first match wins
    const sorted = [...(rule.step_thresholds ?? [])]
        .sort((a, b) => b.threshold - a.threshold);
    const matched = sorted.find((s) => actualValue >= s.threshold);
    return matched ? matched.points : 0;
}

export function scoreAccount(usage: AccountUsageRow, rules: Rule[]): ChurnScore {
    const factorScores: Record<string, { actual: number; goal: number; subScore: number }> = {};
    let total = 0;

    for (const rule of rules) {
        const actual = usage[ruleToColumn(rule.rule_key)];   // map rule_key → AccountUsageRow column
        const s = subScore(rule, actual);
        factorScores[rule.rule_key] = { actual, goal: rule.goal_numeric, subScore: s };
        total += s;
    }
    return {
        accountKey: usage.team_id,       // teams.team_id is our canonical account_key
        totalScore: Math.min(total, 100),
        factorScores,
    };
}
```

`ruleToColumn` is a deterministic map living in `packages/common/src/protopie/churn/constants.ts`. Adding a new rule requires three coordinated changes:

1. New row in `protopie_churn_score_factors` (under the active `config_uuid` — or bump the config to a new `version` to preserve audit).
2. New column in `mart_account_usage_90d.sql`.
3. New entry in the `ruleToColumn` map.

The parity test in step 1's dbt section guards drift.

## The scheduler task

Lightdash uses Graphile Worker. Periodic tasks are added to `SchedulerWorker.ts`. We add a single task: `protopie.recomputeChurnScore`.

```ts
// packages/backend/src/protopie/scheduler/tasks.ts
export enum ProtopieTaskName {
    RECOMPUTE_CHURN_SCORE = 'protopie.recomputeChurnScore',
}

export type RecomputeChurnScorePayload = {
    triggeredBy: 'scheduler' | 'manual' | 'mcp';
    triggeredByUser?: string;
    accountKeys?: string[];           // if set, recompute only these; otherwise all
};
```

```ts
// packages/backend/src/protopie/scheduler/recomputeChurnScore.ts
export const recomputeChurnScore: Task = async (payload, helpers) => {
    const services = getProtopieServices(helpers.serviceRepository);
    await services.churnScoreService.recomputeAll({
        triggeredBy: payload.triggeredBy,
        triggeredByUser: payload.triggeredByUser,
        accountKeys: payload.accountKeys,
    });
};
```

### Wire-up (touch point #3) — actually three coordinated edits

Lightdash's scheduler types are **registry-driven** in `@lightdash/common`. Registering a new task means three small, coordinated edits — not just one task-handler line.

**Edit 1 — `packages/common/src/types/schedulerTaskList.ts`:** Add the task name to `SCHEDULER_TASKS` (or `EE_SCHEDULER_TASKS` if EE-only) AND its payload type to `TaskPayloadMap`. Without these, TypeScript won't let the worker register the handler.

```ts
// packages/common/src/types/schedulerTaskList.ts — additions
export const SCHEDULER_TASKS = {
    // … existing entries
    PROTOPIE_RECOMPUTE_CHURN_SCORE: 'protopie.recomputeChurnScore',
} as const;

export interface TaskPayloadMap {
    // … existing entries
    [SCHEDULER_TASKS.PROTOPIE_RECOMPUTE_CHURN_SCORE]: {
        projectUuid: string;
        configUuid?: string;                    // defaults to active config
        triggeredBy: 'scheduler' | 'manual' | 'mcp';
        triggeredByUser?: string;
        accountKeys?: string[];                 // empty/undef = all
    };
}
```

> If we choose to put the task in `EE_SCHEDULER_TASKS` instead, the OSS worker won't see it — desirable if Protopie ships as an EE-only feature. v1 default: put it in the **OSS** registry so the kill-switch (remove Protopie) leaves clean OSS code.

**Edit 2 — `packages/backend/src/scheduler/SchedulerWorker.ts`:** Register the handler:

```ts
// One import + one entry in the task handler map
import { recomputeChurnScore } from '../protopie/scheduler/recomputeChurnScore';
import { SCHEDULER_TASKS } from '@lightdash/common';

// inside taskList:
[SCHEDULER_TASKS.PROTOPIE_RECOMPUTE_CHURN_SCORE]: recomputeChurnScore,
```

**Edit 3 — `packages/backend/src/ee/scheduler/SchedulerWorker.ts` (CommercialSchedulerWorker):** If your deployment uses the commercial worker, add the same entry there too. Lightdash's commercial worker extends the OSS one but maintains its own task map — both need the handler. (Confirm in your deployment whether the commercial worker is in use; if not, skip this edit.)

**Retry semantics.** Graphile Worker default is exponential backoff with up to 25 attempts. We configure:

```ts
// packages/backend/src/protopie/scheduler/recomputeChurnScore.ts
export const recomputeChurnScore: Task = async (payload, helpers) => {
    helpers.logger.info(`Recomputing churn score`, { payload });
    const services = getProtopieServices(helpers.serviceRepository);
    await services.churnScoreService.recomputeAll(payload);
};
recomputeChurnScore.maxAttempts = 3;             // override default 25; fail fast and page on-call
```

On final failure, an entry lands in `graphile_worker.jobs` with `last_error` and Lightdash's existing scheduler-alerting picks it up (see [13-operational-runbook.md](./13-operational-runbook.md)).

### Cron schedule

Use Graphile Worker's `crontab` to run the task **daily at 02:00 UTC**:

```
0 2 * * * protopie.recomputeChurnScore ?fill=4h&max=4 {"triggeredBy":"scheduler"}
```

Cron is registered in the same `SchedulerWorker.ts` extension or via a `crontab.txt` file (whichever Lightdash already uses — check there first; do not add a parallel cron system).

### Manual trigger endpoints

For ops, expose two endpoints (under `/api/v1/protopie/churn/`):

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/recompute` | Admin | Enqueue a full recompute now |
| POST | `/recompute/:accountKey` | Admin | Recompute one Account |

Both call `SchedulerClient.addJob(ProtopieTaskName.RECOMPUTE_CHURN_SCORE, payload)`.

## Reading warehouse data from the backend

Use Lightdash's existing warehouse client abstraction (`WarehouseClient`, resolved via `ProjectService.getWarehouseClient(projectUuid)`) — never connect to Redshift directly with a side-channel credential.

```ts
// inside ChurnScoreService.recomputeAll():
const warehouseClient = await this.projectService.getWarehouseClient(this.config.projectUuid);
const result = await warehouseClient.runQuery(`
    SELECT * FROM \`${this.config.usageMartTable}\`
`);
const usageRows: AccountUsageRow[] = result.rows;
```

The mart table name (`mart_account_usage_90d` fully qualified) and the `projectUuid` are config — set via env at the moment, see [09-implementation-roadmap.md](./09-implementation-roadmap.md). Long term, store these in a Protopie config table or in `lightdashConfig`.

## Score versioning in practice

Each recompute creates **one row per Account per `scored_for_date` per `config_uuid`** in `protopie_churn_score`. The unique constraint enforces this.

Default dashboards filter to "the config that was active on `scored_for_date`" — i.e., the as-was view. The Account 360 dashboard reads `latest score for Account X` (the row with the most recent `scored_for_date` for that Account). Score-trend tiles can either:

- **Single-rubric view (default):** `WHERE config_uuid = <current active config>` — the trend line shows scores as they would have been under today's rubric. *Only works if backfill ran with the new config.*
- **As-was view (audit):** `WHERE account_key = X ORDER BY scored_for_date` — uses whatever config was active each day. Discontinuities possible.

At ~hundreds of Accounts × 365 days × 2-3 config versions per year = well under a million rows. Negligible.

## Reconciliation against ChurnZero (pre-cutover)

Before turning ChurnZero off, run side-by-side reconciliation long enough to cover a weight-tuning cycle and let unusual events surface. The bar: top-30 at-risk Accounts and overall risk band counts must agree to within stated tolerance. Specifically:

1. Compare account count per `plan_tier` between CZ exports and `dim_account`.
2. Compare active-user count per Account in the last 90 days.
3. For each factor, compare `raw_value` (the measured number on the Account side).
4. For each factor, compare `points_awarded`.
5. Compare `total_score` and `risk_band`.
6. Document known/expected differences (event mapping, identity mapping, formula linear vs CZ stepwise).

If reconciliation surfaces a factor that diverges by >10pt average, fix the dbt mart before declaring parity. The fix is *always* in dbt or factor config — never by adjusting `protopie_churn_score` rows directly.

## Overrides

After computing the base score, apply overrides:

```ts
const overrides = await this.accountOverrideModel.getActiveByAccount(usage.account_key);
let finalScore = baseScore;
for (const o of overrides) {
    if (o.override_type === 'force_score') {
        finalScore = o.override_value.score;
        break;
    }
    if (o.override_type === 'exclude') {
        return null;   // skip Account
    }
}
```

Overrides are created via the same form system — they're just a special form key (`account_override_create`) that writes to `protopie_account_overrides` instead of `protopie_form_submissions`. Or, simpler, expose dedicated endpoints `POST /api/v1/protopie/churn/overrides`.

## Observability

- Every run inserts one row in `protopie_churn_score_runs`. Sentry transaction wraps `recomputeAll()`.
- A Lightdash internal dashboard (or simple SQL query) shows: runs per day, p95 duration, success/failure.
- If a run fails, the next nightly run retries (Graphile Worker default retry). After 3 failures the task pages on-call (Lightdash's existing scheduler alerting).

## Performance budget

- **Accounts**: ~500 (current customer count, low hundreds).
- **Per-Account compute**: <10ms (memory-only after warehouse read).
- **Warehouse read**: one SELECT over `mart_account_usage_90d` (~500 rows).
- **Postgres writes**: ~500 inserts in a single transaction.

Target: **< 30 seconds end-to-end**. Plenty of room.

## Test plan

- **Unit**: `scoreAccount()` with synthetic inputs covering each rule, the linear-clamp behavior, and the step function.
- **Integration**: full `recomputeAll()` against a small fixture in a local Postgres + DuckDB-backed warehouse stub (Lightdash uses DuckDB for some tests).
- **dbt**: parity test comparing `protopie_churn_score_factors.event_group->>'events'` (Postgres) against `dim_churn_score_event_groups` (seed).
- **Smoke**: a CI job that runs `recomputeChurnScore` against a frozen fixture warehouse and asserts the final scores match a golden file.
