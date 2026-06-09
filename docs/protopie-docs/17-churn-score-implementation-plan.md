# 17 — Churn Score: Implementation Plan (review draft)

> **Status:** implementation started. Backend schema, service/API, scheduler hook, and a minimal rubric/scores UI are in progress from this plan.
>
> **Goal:** ship a churn score that calculates a 0–100 number per **enterprise customer** (team), driven by an **editable rubric** that sales can adjust. Manual recompute first; scheduled nightly recompute as the natural next step.

---

## 1. What the Notion page says — formula recap

Sales currently runs a 10-factor weighted score in ChurnZero. From the Notion page tables:

| Weight | Factor name | Goal (per 90 days) | Source events |
|--------|------------|---------------------|----------------|
| 5  | % users with starting action | ≥ 50% | `Studio - App - Launched`, `Cloud - Studio - Launched`, `session_start`, `Cloud - Page - Entered` |
| 5  | # starting actions per user | ≥ 20 | (same events) |
| 10 | % activated / logged-in users | ≥ 50% | `Studio - Login - Completed`, `editor_activated` |
| 10 | # pie creation / save actions per user | ≥ 20 | `Studio - Pie - Created`, `Studio - Pie - Opened`, `Studio - Pie - Saved`, `Studio - Plugin - Imported`, `Studio - Preview - Opened` |
| 10 | % users with pie creation / save action | ≥ 50% | (same events) |
| 10 | % users with AI feature usage | ≥ 50% | `Studio - AI - Prompt Sent`, `Studio - AI Panel - Panel Toggled` |
| 15 | % users with Trigger or Response action | ≥ 50% | `Studio - Response Interaction - Added`, `Studio - Trigger Interaction - Added` |
| 15 | # trigger/response actions per user | ≥ 20 | (same events) |
| 10 | Number of Messages Received | ≥ 5 | editable event mapping; defaults empty until data source is finalized |
| 10 | Active days | ≥ 10 | — (any event timestamp counts) |
| **100** | | | |

**Formula (per factor, linear partial credit):**

```
points_awarded = LEAST(actual_value / goal_value, 1) * max_points
```

**Per-Account roll-up. Active factors sum to *100*.** We store **two** score values so neither the rubric editor nor downstream dashboards have to reason about which max applies if sales later changes weights:

```
total_points     = SUM(points_awarded over active factors)          // raw, 0 → max_points (100 today)
max_points       = SUM(max_points over active factors)              // 100 today; changes if sales adds factors
score_percent    = total_points / max_points                         // 0 → 1
normalized_score = score_percent * 100                               // 0 → 100, the user-facing number
risk_band        = CASE
    WHEN score_percent ≥ thresholds.low    THEN 'low'                // defaults: 0.75 / 0.50
    WHEN score_percent ≥ thresholds.medium THEN 'medium'
    ELSE 'high'
END
```

The Notion page's two referenced anchors both reinforce the linear-prorate form (one is the rubric screenshot, one is the "12 events per user → 7 points" example, which is just `LEAST(12 / goal, 1) * weight` in disguise). No step-wise function yet.

> **Weights can sum to any value, not just 100.** Sales is allowed to add a factor or change a weight that pushes the sum below or above 100. The rubric editor **does not reject** non-100 sums — it shows the current `SUM(max_points)` next to the save button and uses that as the normalization denominator. The user-facing `normalized_score` is always 0–100 regardless of how weights drift. See §9.

---

## 2. Scope (what's in v1, what's deferred)

### In scope (v1 — this plan)

- **Per enterprise customer** (rows in `dim_enterprise_summary`, joined to `dim_team_summary` by `namespace`).
- **One active rubric per project** at a time; versioned in Postgres so weight changes don't rewrite history.
- **Sales-editable rubric**: factors (name, max_points, goal_value, goal_unit, events[], aggregation, window_days).
- **Linear partial-credit formula only** (one switch in the schema for future step-wise).
- **Manual recompute endpoint** that an admin / sales lead triggers from the rubric editor page.
- **Daily snapshot table** `protopie_churn_score`: one row per (account_key, scored_for_date, config_uuid).
- **Per-factor breakdown** stored inline as JSONB on each score row (sufficient for dashboards; no separate `factor_results` table in v1).
- **dim_team_summary.team_id is the account key.** `namespace` / `cloud_url` carried alongside for display + Salesforce join later.

### Deferred to v1.1

- Scheduled nightly recompute (Graphile Worker cron). v1 ships the **task handler** but the cron line is optional — sales can hit the recompute button.
- Per-Account overrides (force score / exclude). Already in the design doc; not in this PR.
- Salesforce join (`salesforce_account_id`) — columns reserved, populated when the source exists.
- Step-wise scoring function.
- Backfill across past dates on rubric change.
- Risk-band threshold editor in UI (thresholds live in `risk_band_thresholds` JSONB on config; v1 hardcodes the editor to `0.75 / 0.50`).

### Explicit non-goals

- No re-implementation of `find_explores` / `find_fields` / `run_metric_query` — the backend uses `WarehouseClient` directly. The discovery tools are for AI agents only.
- No new MCP tool. (The score becomes visible to agents through `find_content` once we add the dashboard.)
- No automatic email logging.

---

## 3. Data sources (verified against `/Users/mamur/Documents/projects/data-modeling`)

Inputs we read at compute time, all from Redshift via `WarehouseClient`:

| Source | Why we need it |
|--------|-----------------|
| `mart.dim_product_all_events` (`event_id`, `event_time`, `event_name`, `event_source`, `user_id`) | The event log. Already unifies Amplitude + Cloud. |
| `mart.dim_product_all_event_properties` (`event_id`, `event_time`, `team_id`, `pie_id`, …) | Joins events → `team_id`. Without this we can't attribute events to Accounts. |
| `mart.dim_team_summary` (`team_id`, `namespace`, `url`, `plan_type`, `plan_id`, …) | Account identity + plan metadata. |
| `mart.dim_enterprise_summary` (`namespace`, MRR, contracted seats) | Filters to enterprise customers; carries revenue context. |
| `mart.dim_latest_plan` (`team_id`, `plan_type`, `plan_id`) | Distinguishes Pro / Pro Plus / Enterprise tiers in dashboards. |

The compute query is one big aggregation per recompute run (described in §6).

---

## 4. New Postgres tables (in addition to the 4 already shipped)

A single migration `20260514000000_create_protopie_churn_score.ts` adds 4 tables. Names follow the existing `protopie_` convention.

**Creation order (matters for FK resolution):**

1. `protopie_churn_score_configs`
2. `protopie_churn_score_factors` (FK → configs)
3. `protopie_churn_score_runs` (FK → configs)
4. `protopie_churn_score` (FK → configs, FK → runs) — must come **last** because it references both.

The `down()` migration drops them in reverse order.

### 4.1 `protopie_churn_score_configs`

One row per **version** of the rubric. Immutable once `status='active'`; edits create a new version.

| Column | Type | Notes |
|--------|------|-------|
| `config_uuid` | uuid pk | |
| `project_uuid` | uuid fk → projects | |
| `name` | text | Default `'Default Churn Score'`. |
| `version` | int | Monotonic per `(project_uuid, name)`. |
| `lookback_days` | int | Default 90. |
| `score_function` | text | `'linear'` only in v1; column reserved for `'stepwise'`. |
| `risk_band_thresholds` | jsonb | `{ low: 0.75, medium: 0.50 }`. |
| `effective_from` | timestamptz | When this version started being authoritative. |
| `effective_to` | timestamptz null | Filled when superseded. |
| `status` | text | `'draft' \| 'active' \| 'archived'`. |
| `created_by_user_uuid` | uuid fk → users null | **Nullable** — the migration seed has no real user; later edits via the API are required to fill these. |
| `updated_by_user_uuid` | uuid fk → users null | Same. |
| `created_at`, `updated_at` | timestamptz | |

Unique: `(project_uuid, name, version)`. Index on `(project_uuid, name)` where `status='active' AND effective_to IS NULL`.

### 4.2 `protopie_churn_score_factors`

The N factors that make up a config. v1 ships exactly the 9 from the Notion page.

| Column | Type | Notes |
|--------|------|-------|
| `factor_uuid` | uuid pk | |
| `config_uuid` | uuid fk → configs (cascade) | |
| `factor_key` | text | e.g. `pct_users_with_starting_action`. |
| `label` | text | UI label. |
| `max_points` | numeric(5,2) | Weight; active factors can sum to any value. The service normalizes by the active sum. |
| `goal_value` | numeric(14,4) | e.g. `0.5` for 50%, `20` for "20 per user". |
| `goal_unit` | text | `'fraction' \| 'count_per_user' \| 'days'`. |
| `aggregation` | text | `'pct_users_with_event' \| 'event_count_per_user' \| 'active_days'`. |
| `event_group` | jsonb | `{ operator: 'or', events: ['...'] }` for OR semantics. Empty array allowed (for `active_days`). |
| `step_thresholds` | jsonb null | Reserved for step-wise later. |
| `sort_order` | int | Display order in the UI. |

Unique: `(config_uuid, factor_key)`. Index on `(config_uuid, sort_order)`.

### 4.3 `protopie_churn_score`

One row per **score snapshot** per enterprise team. We persist both the raw points and the normalized 0–100 value so dashboards never have to re-derive them.

| Column | Type | Notes |
|--------|------|-------|
| `score_uuid` | uuid pk | |
| `project_uuid` | uuid fk → projects | |
| `account_key` | text | = `team_id` from `dim_team_summary`. |
| `namespace` | text null | From `dim_team_summary`. The enterprise rollup key — multiple `team_id` can share a `namespace`. |
| `cloud_url` | text null | From `dim_team_summary.url`. Display-facing. |
| `scored_for_date` | date | The day this score applies to. |
| `lookback_days` | int | Snapshotted from the config at compute time. |
| `config_uuid` | uuid fk → configs (restrict) | |
| `config_version` | int | Denormalized. |
| `total_points` | numeric(6,2) | Raw sum of `points_awarded` over active factors. With today's rubric, max is 100. |
| `max_points` | numeric(6,2) | Sum of `max_points` over the factors active in this config version. |
| `score_percent` | numeric(5,4) | `total_points / max_points`. 0..1. |
| `normalized_score` | numeric(6,2) | `score_percent * 100`. The user-facing 0–100 number. |
| `risk_band` | text | `'low' \| 'medium' \| 'high'` (derived from `score_percent` + thresholds). |
| `factor_scores` | jsonb | `{ factor_key: { raw, goal, points } }`. |
| `computed_at` | timestamptz | |
| `run_uuid` | uuid fk → runs (cascade) | |

Unique: `(account_key, scored_for_date, lookback_days, config_uuid)`. Indexes on `(account_key, scored_for_date DESC)` and `(project_uuid, risk_band, scored_for_date DESC)`.

### 4.4 `protopie_churn_score_runs`

Audit row per recompute invocation.

| Column | Type | Notes |
|--------|------|-------|
| `run_uuid` | uuid pk | |
| `project_uuid` | uuid fk → projects | |
| `config_uuid` | uuid fk → configs | |
| `triggered_by` | text | `'scheduler' \| 'manual' \| 'mcp'`. v1: only `'manual'`. |
| `triggered_by_user_uuid` | uuid fk → users null | |
| `status` | text | `'queued' \| 'running' \| 'completed' \| 'failed'`. |
| `started_at`, `finished_at` | timestamptz | |
| `accounts_scored` | int | |
| `error_message` | text null | |
| `created_at` | timestamptz | |

Index on `(project_uuid, created_at DESC)`.

### 4.5 Seed data (in the same migration)

Insert 1 active config + 9 factors matching the Notion rubric exactly. This guarantees the system works on day 1; sales then iterates via the editor.

- Seed rows leave `created_by_user_uuid` / `updated_by_user_uuid` as **NULL** — the migration has no real user. The first `PUT /config` call from sales fills them on the new version.
- The seed targets every existing project in the `projects` table — one default config per project. If the table is empty (fresh local dev), the seed is a no-op; the API creates a config on first read.

---

## 5. Editable rubric — the sales-facing surface

**Backend (REST, TSOA-discovered controllers under `packages/backend/src/protopie/controllers/`):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/config` | Get the active config + factors. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/config/versions` | List all versions (for history view). |
| `PUT` | `/api/v1/projects/{projectUuid}/protopie/churn/config` | Create a **new version** with edited factors. Body: `{ name, lookback_days, score_function, risk_band_thresholds, factors: [...] }`. Activates the new version atomically: marks the prior version `archived`, fills its `effective_to`. |
| `POST` | `/api/v1/projects/{projectUuid}/protopie/churn/recompute` | **Enqueue** a manual recompute as a Graphile Worker job. Returns immediately with `{ run_uuid, status: 'queued' }`. **Does not block** on the Redshift query — that would risk HTTP timeouts on slow recomputes. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/runs` | Run history (most recent first), with status. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/runs/{runUuid}` | One run's status (poll target). Returns `status`, `started_at`, `finished_at`, `accounts_scored`, `error_message`. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/scores/latest` | List latest score per Account for the active config. Filters: `risk_band`, `min_score`, `max_score`, `namespace`, `limit`, `offset`. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/scores/{accountKey}` | Score history for one Account (`account_key` = `team_id`). |

**Async recompute UX:** the rubric editor's "Recompute now" button calls `POST /recompute`, gets a `run_uuid`, and polls `GET /runs/{runUuid}` every ~2s until `status='completed'` or `'failed'`. Frontend uses TanStack Query polling with a sane stop after ~3 minutes. This is forgiving for slow Redshift days and keeps the controller out of long-request territory.

> **Why NOT reuse the existing `protopie_form_*` framework for the rubric?** Forms are sales-rep data-entry surfaces with JSONB payloads validated by Zod. The rubric needs structured, queryable columns (`max_points`, `goal_value`, `event_group`) that the scoring service joins to. Keeping it in a dedicated table makes the score query simple, the audit trail clean, and the UI honest about what it edits. The placeholder `churn_score_input` form in `forms/schemas/churnScoreInput.ts` is **deleted** as part of this work (its current "Final fields will be defined later" comment is what this plan resolves).

**Frontend (`packages/frontend/src/protopie/`):**

- New page: `ChurnScoreRubricPage` at `/projects/:projectUuid/protopie/churn/rubric`.
  - Table view of the 9 (or N) factors: editable Weight, Goal, Goal Unit, Events (multi-tag input), Aggregation (select).
  - "Save as new version" button → calls `PUT /config`.
  - "Recompute now" button → calls `POST /recompute`. Shows a toast with the run summary.
  - Version dropdown to view past rubrics (read-only).
- New page: `ChurnScoreListPage` at `/projects/:projectUuid/protopie/churn/scores`.
  - Account list sorted by `total_score` ascending.
  - Filters: risk_band, plan_tier (via Salesforce join later), search by namespace/cloud_url.
  - Row click → detail drawer showing factor breakdown.
- Nav entry already exists (`ProtopieNavButton`). Add a sub-navigation tab strip inside the Protopie home: Forms / Rubric / Scores.

**Permissions (v1, deliberately simple — no new CASL scopes):**

| Action | Allowed for |
|--------|-------------|
| `GET` rubric / scores / runs | Any project-scoped authenticated user |
| `PUT` rubric (new version) | Organization admin OR Project admin (inline check in the controller) |
| `POST` recompute | Same |

Tighten to a `protopie:churn:rules:write` scope in v1.1 if product asks. The inline check avoids editing `projectMemberAbility.ts` / `roleToScopeMapping.ts` and preserves the isolation rule.

---

## 6. The scoring service

**`packages/backend/src/protopie/services/ChurnScoreService.ts`** (new).

### 6.1 Public methods

```ts
class ChurnScoreService {
    // Read
    getActiveConfig(projectUuid): Promise<{ config, factors }>
    listVersions(projectUuid): Promise<Config[]>
    listLatestScores(projectUuid, filters): Promise<ChurnScoreRow[]>
    getAccountHistory(projectUuid, accountKey, limit): Promise<ChurnScoreRow[]>
    listRuns(projectUuid, limit): Promise<RunRow[]>
    getRun(projectUuid, runUuid): Promise<RunRow>

    // Write (synchronous, fast Postgres-only operations)
    upsertConfigAsNewVersion(user, projectUuid, payload): Promise<{ config, factors }>
    enqueueRecompute(user, projectUuid, opts: { triggeredBy }): Promise<{ runUuid, status: 'queued' }>

    // Write (called from the scheduler worker — long-running)
    executeRecompute(runUuid: string): Promise<void>
}
```

### 6.2 `enqueueRecompute()` — what the HTTP controller does

The controller is synchronous-friendly:

1. Load active config + factors (Postgres, fast).
2. Insert a `protopie_churn_score_runs` row with `status='queued'`.
3. Enqueue a Graphile Worker job `protopie.recomputeChurnScore` with payload `{ runUuid, projectUuid, triggeredByUserUuid }`. The job picks up immediately if a worker is free.
4. Return `{ run_uuid, status: 'queued' }` to the caller. No Redshift query in the request path.

### 6.3 `executeRecompute()` — what the scheduler worker does

The worker handles long-running steps that mustn't block HTTP:

1. Load the run row by `run_uuid`; transition to `status='running'`, fill `started_at`.
2. Re-load the config + factors (the row references `config_uuid` so we use that, not "latest active" — this keeps a recompute reproducible even if sales changes the rubric mid-run).
3. Resolve the `WarehouseClient` for the project via `ProjectService.getWarehouseCredentialsForProject(projectUuid)` + the `warehouseClientFromCredentials` factory.
4. Resolve the **configured** mart schema for the project. We do **not** hardcode `mart.` or `warehouse.` — those are dbt model names, not Redshift schemas. Instead we read the project's warehouse `schema`/`database` from the connection config and use `{schema}.dim_product_all_events`, `{schema}.dim_product_all_event_properties`, `{schema}.dim_team_summary`, `{schema}.dim_enterprise_summary`. For dev that's `warehouse_dev`; for prod `warehouse_prod` (both in the `prod` database — dev/prod share one Redshift cluster, separated only by schema; see [11-dbt-integration.md](./11-dbt-integration.md)). The two relation names (events + properties) can be made configurable via env or a project-level setting if the dbt schema deviates.

> **The runtime `{schema}` is whatever the Lightdash project's Redshift connection has in its `schema` field** — `getWarehouseSchema()` reads it straight off the credentials with no env override. If the dev project's connection schema is *not* `warehouse_dev` (e.g. left as a stale `warehouse_staging` that has team/enterprise dims but no recent events), every score computes to 0. Verify the connection schema before debugging the rubric.
5. **Single Redshift query** that, in one pass, returns one row per `team_id` with every metric needed by every factor. Pseudocode (interpolations explained below):

   ```sql
   WITH event_attribution AS (
       SELECT
           e.event_id,
           e.event_time,
           e.event_name,
           e.user_id,
           ep.team_id
       FROM {schema}.dim_product_all_events e
       LEFT JOIN {schema}.dim_product_all_event_properties ep ON e.event_id = ep.event_id
       WHERE ep.team_id IS NOT NULL
         AND e.event_time >= DATEADD(day, -:lookback_days, CURRENT_TIMESTAMP)
   ),
   enterprise_teams AS (
       SELECT t.team_id, t.namespace, t.url AS cloud_url
       FROM {schema}.dim_team_summary t
       INNER JOIN {schema}.dim_enterprise_summary es ON es.namespace = t.namespace
   ),
   per_account AS (
       SELECT
           et.team_id,
           et.namespace,
           et.cloud_url,
           COUNT(DISTINCT ea.user_id) AS total_users,
           -- one CASE per factor's event group; placeholders expanded per event (see below)
           COUNT(DISTINCT CASE WHEN ea.event_name IN (:starting_action_e0, :starting_action_e1, :starting_action_e2, :starting_action_e3) THEN ea.user_id END) AS users_with_starting_action,
           SUM(CASE WHEN ea.event_name IN (:starting_action_e0, :starting_action_e1, :starting_action_e2, :starting_action_e3) THEN 1 ELSE 0 END) AS starting_action_event_count,
           ...
           COUNT(DISTINCT DATE_TRUNC('day', ea.event_time)) AS active_days
       FROM enterprise_teams et
       LEFT JOIN event_attribution ea ON ea.team_id = et.team_id
       GROUP BY et.team_id, et.namespace, et.cloud_url
   )
   SELECT * FROM per_account
   ```

   **Parameterization strategy.** Do not rely on `IN (:events)` array expansion — `WarehouseClient.runQuery` accepts bindings but array→list expansion behaviour is not uniform across adapters (Redshift / Postgres / etc.). We do two things:

   1. **One bind per event.** For each factor, expand `event_group.events` into `:{factorKey}_e0, :{factorKey}_e1, …`. The SQL builder emits the right number of `?` placeholders per IN clause and the value list is bound positionally. This is uniformly safe across `WarehouseClient` implementations.
   2. **Whitelist guard on event names.** Before binding, every event name is validated against `/^[A-Za-z0-9 \-_]+$/`. Anything that fails throws a `ParameterError` at save time on `PUT /config`, so the rubric editor never persists an unsafe value. This protects against escape-via-bindings edge cases in older driver versions.

   `{schema}` is **not** a SQL parameter — it's substituted at SQL-build time after validating against an allow-list (`/^[a-z][a-z0-9_]+$/`).

6. For each per-team row, compute factor sub-scores in TypeScript via a pure function `scoreAccount(factors, accountRow)`:

   ```ts
   for (const factor of factors) {
       const actual = pickActual(factor, accountRow);
       const subScore = Math.min(actual / Math.max(factor.goalValue, 1e-9), 1) * factor.maxPoints;
       factorScores[factor.factorKey] = { raw: actual, goal: factor.goalValue, points: subScore };
       totalPoints += subScore;
       maxPoints   += factor.maxPoints;
   }
   const scorePercent = maxPoints > 0 ? totalPoints / maxPoints : 0;
   const normalizedScore = scorePercent * 100;
   ```

   `pickActual` dispatch on `aggregation`:
   - `'pct_users_with_event'` → `users_with_<factor>` / `total_users`
   - `'event_count_per_user'` → `<factor>_event_count` / `total_users`
   - `'active_days'` → `active_days` (ignores `event_group`)

7. Derive `risk_band` from `config.risk_band_thresholds`.
8. **Upsert** into `protopie_churn_score` on the unique key `(account_key, scored_for_date, lookback_days, config_uuid)`. Same-day re-runs overwrite the row.
9. Mark the run `status='completed'`, fill `finished_at` and `accounts_scored`.
10. On exception, mark `status='failed'`, write `error_message`, re-throw (Graphile Worker captures the error in `last_error`).

### 6.4 Granularity — per team, with namespace alongside

The score is computed **per `team_id`** (one Lightdash row per `dim_team_summary.team_id`). An enterprise `namespace` can have multiple teams, and rolling them up loses signal — one team's adoption tells you nothing about a sibling team. We carry `namespace` on every score row so dashboards can group / aggregate at the enterprise level when sales asks, but the storage grain is per-team.

Naming convention used in code and docs:

- `account_key` = `team_id` (the per-team grain).
- "Enterprise account" or "enterprise team" = an `account_key` whose `namespace` appears in `dim_enterprise_summary`.

A future per-namespace rollup mart can be added in dbt without changing this schema.

### 6.5 Performance

- ~500 enterprise teams × 1 query per recompute = one Redshift query. Expected runtime well under a minute on a warm warehouse.
- The CASE expansion grows with the number of factors. With 9 factors and 4 events per factor avg → 9 × 2 (DISTINCT users + SUM count) = 18 column expressions. Fine for Redshift.
- Postgres upsert: ~500 rows in one transaction. Negligible.
- Async execution via Graphile Worker means a slow recompute does **not** cause an HTTP timeout. The worker handles retries (`maxAttempts = 3`).

### 6.6 Why backend-only (not dbt)

Reaffirming what the design docs (and `CLAUDE.md`) already say: weights live in Postgres for editability. Computing in dbt means a dbt run per weight change. Backend wins on iteration speed; dbt only models the inputs.

---

## 7. Scheduler

- New task name: `protopie.recomputeChurnScore`. Payload: `{ projectUuid, triggeredBy, triggeredByUserUuid? }`.
- Registered in `@lightdash/common`'s `SCHEDULER_TASKS` + `TaskPayloadMap`, and in the OSS `SchedulerWorker.ts` task map (touch points 3a + 3b).
- v1 ships **only the handler** — no cron line. Manual recompute is the v1 trigger.
- v1.1 adds the cron entry: `0 2 * * *` (daily at 02:00 UTC).
- `maxAttempts = 3` with exponential backoff; final failure leaves an entry in `graphile_worker.jobs.last_error` plus Sentry breadcrumb.

---

## 8. Wire-up touch points

These are additive to the 7 touch points already documented; nothing is replaced.

| Touch point | Edit |
|-------------|------|
| `packages/backend/src/protopie/database/migrations/` | NEW file `20260514000000_create_protopie_churn_score.ts` with the 4 tables + seed. |
| `packages/backend/src/protopie/services/index.ts` | Register `ChurnScoreService` (it joins the existing `FormService` / `SettingsService` factory). |
| `packages/common/src/types/schedulerTaskList.ts` | Add `PROTOPIE_RECOMPUTE_CHURN_SCORE` to `SCHEDULER_TASKS` + payload type in `TaskPayloadMap`. |
| `packages/backend/src/scheduler/SchedulerWorker.ts` | One import + one entry in the OSS task handler map. |
| `packages/backend/src/ee/scheduler/SchedulerWorker.ts` | Same entry in the **commercial / EE** scheduler worker. Our deployment runs EE; without this, the task name is registered in the OSS map but the EE worker is what actually executes — the job would silently fail to dispatch. |
| `packages/backend/src/protopie/controllers/` | NEW `ChurnScoreController.ts` (TSOA — auto-discovered). |
| `packages/frontend/src/protopie/routes.tsx` | Three new lazy-loaded pages. |
| `packages/frontend/src/protopie/` | New pages, hooks, API client. |

**Zero new edits in Lightdash core** beyond the existing 7 touch points. The `SchedulerWorker.ts` (both OSS and EE), `@lightdash/common/schedulerTaskList.ts` edits are the same touch points the design docs already cataloged (touch point 3) — we just add a new entry.

---

## 9. Testing plan

| Layer | Test |
|-------|------|
| Unit (TS) | `scoreAccount(factors, accountRow)` — golden cases: all-zero inputs → `totalPoints=0, normalizedScore=0`; meet-every-goal inputs → `totalPoints=max_points, normalizedScore=100`; mixed inputs → expected mid score; over-goal inputs clamp at the factor max. |
| Unit (TS) | `scoreAccount` with `goalValue=0` does not divide by zero (clamped to 1e-9). |
| Unit (TS) | Risk-band derivation from `risk_band_thresholds` JSONB. Custom thresholds (e.g., `{ low: 0.8, medium: 0.6 }`) are honored. |
| Unit (TS) | `scoreAccount` with weights summing to **anything other than 100** still produces a 0–100 `normalizedScore`. Today's 10-factor rubric produces `normalizedScore=100` when every factor meets its goal. |
| Unit (TS) | `upsertConfigAsNewVersion` — version increments correctly; the prior version's `effective_to` is filled; **non-100 weight sums are accepted** (only the editor's UI shows a warning); duplicate `factor_key` within the same submit is rejected. |
| Integration | Fixture Redshift query mocked via `WarehouseClient` test double. Recompute writes the expected rows. |
| Integration | Async recompute end-to-end: enqueue via HTTP → worker picks up → run transitions queued → running → completed; `GET /runs/:runUuid` reflects each state. |
| Integration | Re-running recompute the same day overwrites (idempotent on the unique key). |
| API | `PUT /config` requires admin; `GET` allowed for any project member. |
| Frontend smoke | Rubric editor → Save → "Recompute now" → poll → Scores list shows updated values. |

---

## 10. Resolved questions + still-open items

### Resolved implementation decisions (2026-05-14)

- **Score is per `team_id`, with `namespace` carried alongside** for enterprise rollups. Documented in §6.4.
- **`PUT /config` is atomic create-and-activate** (current plan).
- **Empty event group for `active_days`** stays — semantics carried by the `aggregation` column.
- **`goal_value = 0` clamps to 1e-9** in `scoreAccount` (no divide-by-zero) AND the rubric editor surfaces a warning. The save itself is not rejected.
- **Non-100 weight sums are allowed.** The editor shows the current `SUM(max_points)` next to the save button; the persisted score's `normalizedScore` always renders 0–100 by dividing by the active `max_points`. The earlier "warn" vs "reject" wording is reconciled in §9.
- **Async recompute** via Graphile Worker job (not synchronous in the HTTP request). §6.2 / §6.3 / §5.
- **EE scheduler worker** inherits the OSS handler map via `super.getFullTaskList()`; no separate EE task registration is needed in the current codebase. §8.
- **Schema substitution.** No hardcoded `mart.`. Real Redshift schema (`warehouse_dev` dev / `warehouse_prod` prod, both in the `prod` database) is read from the project's warehouse connection config. §6.3.
- **Parameterization strategy.** One placeholder per event; whitelist guard on event names at save time. No reliance on `IN (:array)` expansion. §6.3.
- **Score model.** Persist both `total_points` (raw) and `normalized_score` (0–100), plus `score_percent` and `max_points`. §4.3, §1.
- **Migration table order:** configs → factors → runs → scores. §4.
- **Seeded audit user UUIDs are nullable.** §4.1, §4.5.
- **Deleting `churn_score_input` form is gated on the UI PR.** §13. PR 3 (UI) is the only place the form is removed; PRs 1 and 2 leave it untouched. The Forms page is updated in the same PR to either (a) hide the placeholder, or (b) point at the new rubric editor. The "no regression to existing protopie forms" line in §14 is updated to read: "the placeholder `churn_score_input` form is removed; no other forms are affected."

### Still open (these are the ones I'd like a sales decision on)

1. **Enterprise filter.** Score only `dim_enterprise_summary` teams (current plan) or also score self-serve teams that have a `team_id`? Self-serve scoring is cheap (it's the same query, larger result set) but might noise up the dashboards. Default: enterprise-only.
2. **Same-day overwrite.** Confirm: a second recompute on the same day overwrites the score row (audit lives in `protopie_churn_score_runs`). Alternative is to keep every recompute's row, which is rare-day-2-data but lossless. I lean overwrite.
3. **Rubric editor placement in the nav.** Current plan: a sibling page `/projects/:p/protopie/churn/rubric`. Alternative: a tab inside a unified Protopie page. Either works; cosmetic.

---

## 11. Concrete files to add

```
packages/backend/src/protopie/
├── database/migrations/
│   └── 20260514000000_create_protopie_churn_score.ts        ← migration + seed
├── models/
│   ├── ChurnScoreConfigModel.ts
│   ├── ChurnScoreFactorModel.ts
│   ├── ChurnScoreModel.ts
│   ├── ChurnScoreRunModel.ts
│   └── tableNames.ts                                         ← extend
├── services/
│   ├── ChurnScoreService.ts
│   ├── churnScore/
│   │   ├── scoreAccount.ts                                   ← pure function (unit-testable)
│   │   ├── buildAggregationQuery.ts                          ← turns factors → SQL
│   │   ├── deriveRiskBand.ts
│   │   └── churnScore.test.ts
│   └── index.ts                                              ← extend
├── controllers/
│   └── ChurnScoreController.ts                               ← TSOA, auto-discovered

packages/common/src/protopie/churnScore/
├── types.ts                                                  ← shared types
├── constants.ts                                              ← default 10-factor rubric, risk band defaults
└── index.ts

packages/common/src/types/schedulerTaskList.ts                ← +1 task name + payload
packages/backend/src/scheduler/SchedulerWorker.ts             ← +1 task handler

packages/frontend/src/protopie/
├── pages/
│   ├── ChurnScoreRubricPage.tsx
│   ├── ChurnScoreListPage.tsx
│   └── ChurnScoreAccountDetailPage.tsx
├── components/
│   ├── ChurnScoreFactorRow.tsx
│   ├── RiskBandBadge.tsx
│   └── EventGroupInput.tsx
├── hooks/
│   ├── useChurnConfig.ts
│   ├── useUpdateChurnConfig.ts
│   ├── useRecomputeChurnScore.ts
│   └── useChurnScores.ts
└── api.ts                                                    ← extend
```

**Files to delete** as part of this work — **gated on PR 3 (UI) only**, so PRs 1 and 2 can ship without breaking the existing Forms page:
- `packages/common/src/protopie/forms/schemas/churnScoreInput.ts` (placeholder)
- Its references in `forms/registry.ts` and `protopie/index.ts`
- In the same PR, update `ProtopieFormsPage` to either hide the placeholder entry or link to the new rubric editor as a "what was this for?" empty state. The UI does **not** silently lose a form.

---

## 12. PR sequence proposal (Graphite stack)

For review-friendliness, ship in three thin PRs:

1. **PR 1 — schema + types.** Migration, seed data, models, shared types in `@lightdash/common`. No service, no UI. Lint + typecheck + a migration smoke test.
2. **PR 2 — service + REST.** `ChurnScoreService`, the SQL builder, scoring math, the controller. Includes the scheduler task handler (no cron yet). Unit + integration tests for `scoreAccount`. After this PR an admin can curl the rubric and trigger recomputes.
3. **PR 3 — UI.** Rubric editor page + scores list page + Account detail drawer. Wire into nav.

If sales asks for it, **PR 4** adds the nightly cron line.

---

## 13. What I'm NOT doing in this plan (deliberate)

- No dbt model changes. The existing `dim_product_all_events`, `dim_product_all_event_properties`, `dim_team_summary`, `dim_enterprise_summary` are sufficient.
- No new MCP tools. Once the rubric + scores ship, AI agents can read scores via `find_content` and the existing API bridge; they can write rubrics via `lightdash_api_mutate` (it routes through the same controller and respects `mcp:write` + org opt-in).
- No frontend bootstrap of dashboards. The dashboards from the design doc (Account 360, Churn Score Portfolio) are content-as-code; they ship in a separate PR after PR 3.
- No reconciliation harness against ChurnZero. That's a phase-5 cutover concern, not a phase-2 backend concern.

---

## 14. Acceptance criteria (for the v1 PR set)

- A sales lead can navigate to `/projects/:projectUuid/protopie/churn/rubric`, see the 9 default factors, edit a weight or a goal, save, and see "New version v2 active. Recompute to refresh scores." inline.
- Clicking "Recompute now" returns immediately with `{ runUuid, status: 'queued' }`; the UI polls run status and then shows `accountsScored: <number-of-enterprise-teams>` when the worker completes.
- `/projects/:projectUuid/protopie/churn/scores` shows the recomputed list sorted by score ascending, with risk-band badges.
- An admin can run `curl -X POST /api/v1/projects/.../protopie/churn/recompute -H 'Authorization: ApiKey <PAT>'` and see the same effect.
- A re-run on the same day overwrites scores idempotently; the run history shows two run rows.
- Typecheck, lint, the existing protopie tests, and the new `scoreAccount` unit tests all pass.
- The placeholder `churn_score_input` form is removed in PR 3 along with the Forms-page UI update that explains its removal; no other forms are affected; MCP tools and settings are unchanged.

---

## 15. Quick decision summary

- **Dedicated tables (not a generic form)** for the rubric. → §4, §5.
- **Linear formula only** in v1; schema-reserved for stepwise. → §1, §4.2.
- **Per-project rubric** rather than org-global. → §4.1.
- **Persist both `total_points` (raw) and `normalized_score` (0–100)** so weight sums other than 100 don't break dashboards. → §1, §4.3.
- **Non-100 weight sums are allowed.** Today's default rubric sums to 100, but the editor warns instead of blocking if sales changes the total; the persisted score is always 0–100. → §1, §9, §10.
- **Per-`team_id` grain**, `namespace` carried alongside for enterprise rollups. → §6.4.
- **Same-day recompute overwrites** the row; `protopie_churn_score_runs` is the audit. → §4.3.
- **Inline admin check**, no new CASL scopes. → §5.
- **Async recompute via Graphile Worker** — HTTP enqueues, UI polls the run row. → §5, §6.2, §6.3.
- **Schema substitution** from project warehouse config; no hardcoded `mart.` / `warehouse.`. → §6.3.
- **Parameterization**: one bind per event + whitelist guard at save time. No `IN (:array)`. → §6.3.
- **Migration table order**: configs → factors → runs → scores. Seeded audit-user columns are nullable. → §4, §4.5.
- **EE scheduler worker is a touch point** alongside OSS. → §8.
- **3-PR stack**: schema → service+REST+scheduler → UI. → §12.
- **`churn_score_input` form deletion is gated on PR 3** (UI) and ships with a Forms-page update; PRs 1 and 2 leave it intact. → §11, §13, §14.
