# 00 — Context: Why we are building this

## The business problem

Protopie currently pays **~USD $30,000/year** for **ChurnZero (CZ)**, a SaaS that scores customer churn risk based on usage data, contact frequency, and account activity. The CZ subscription **expires 2026-07-30** and will not be renewed.

Of CZ's many features, the sales team uses **only three**:

1. **Churn Score** — a 0–100 risk score per Account (cloud_url tenant). ✅ *In scope for v1.*
2. **Email logging** — outbound email activity tracked against an Account. ⛔ *Out of scope for v1.* See below.
3. **Bulk email send** — outbound campaign sends. ⛔ *Out of scope.* Use a separate tool.

Result: poor ROI. The plan is to rebuild the Churn Score inside Lightdash by 2026-07-30. The CZ "activity logging" capability is **replaced — not migrated — by manual sales-rep forms** (touchpoint log, renewal notes); we do *not* attempt automatic email ingestion. Automatic email logging is a separate problem that requires Gmail/Outlook API integration, OAuth scopes, and deduplication logic — defer to v1.1 or beyond.

> **Out-of-scope clarification.** When the docs refer to "activity logging" they mean **manual touchpoint forms submitted by sales reps**, not automatic email scraping. If sales asks "where do my sent emails show up?" the answer is "they don't — log a touchpoint summary instead." This is a real product decision, not a missing requirement.

## Current ChurnZero data plumbing (to be replaced)

```
Amplitude  ──(daily CSV export)──▶  ChurnZero
Salesforce ──(CZ-native API sync)──▶  ChurnZero
                                       │
                                       ▼
                              Churn Score (0–100)
                              Account dashboards
                              Email logging UI
```

The Amplitude → ChurnZero CSV pipeline already ships per-event aggregates (e.g., `editor_activated.csv`, `PieCountMonthly.csv`) keyed on `cloud_url`. **All this raw event data is already available in our data warehouse (the dbt project that Lightdash connects to).** That is the unlock — Lightdash can compute the Churn Score directly from the warehouse without a third-party intermediary.

## The Churn Score (current rubric in CZ)

Sales has 9 active scoring factors, each weighted; they sum to **100 points**. Goals are measured over a **trailing 90-day window** per Account (`cloud_url`).

| Weight | Name | Goal (90d) | Source Amplitude events |
|--------|------|------------|-------------------------|
| 5  | % of users with starting action | 50%+ | `Studio - App - Launched`, `Cloud - Studio - Launched`, `session_start`, `Cloud - Page - Entered` |
| 5  | # of starting actions per user | 20+ | same as above |
| 10 | % of activated / logged-in users | 50%+ | `Studio - Login - Completed`, `editor_activated` |
| 10 | # of pie creation or save actions per user | 20+ | `Studio - Pie - Created`, `Studio - Pie - Opened`, `Studio - Pie - Saved`, `Studio - Plugin - Imported`, `Studio - Preview - Opened` |
| 10 | % of users with pie creation or save action | 50%+ | same as above |
| 10 | % of users with AI Feature usage | 50%+ | `Studio - AI - Prompt Sent`, `Studio - AI Panel - Panel Toggled` |
| 15 | % of users with Trigger or Response action | 50%+ | `Studio - Response Interaction - Added`, `Studio - Trigger Interaction - Added` |
| 15 | # of trigger or response actions per user | 20+ | same as above |
| 10 | Active Days | 10+ | derived from any event timestamp |
| **100** | | | |

Each factor produces a sub-score: actual / goal, clamped to `[0, 1]`, multiplied by weight. The final score is the sum. The exact functional form (linear vs. step-wise) is still open — see [10-open-questions.md](./10-open-questions.md) (C10).

## Plan tier source of truth (locked)

The Notion brief calls out Pro vs Pro Plus as needing separate visibility. The dbt warehouse already has the answer:

- **`dim_latest_plan`** (in `marts/warehouse/billing/daily/`) — current paid plan per user/team. Joins by `team_id`. **Use this as the source of `plan_tier`** for both churn dashboards and any score-config segmentation. Field: `dim_latest_plan.plan_type` (values: `'term'`, `'subscription'`, etc.) and `dim_latest_plan.plan_id` (the SKU / plan identifier).
- Map `plan_id` → friendly `plan_tier_label` (`'Pro'`, `'Pro Plus'`, `'Enterprise'`, `'Pro Plus Plus'`) in **a small dbt seed** (`seeds/protopie/dim_plan_tier_labels.csv`). The seed has columns `plan_id`, `plan_tier_label`, `is_enterprise_cloud`, etc.

Why a seed, not hard-coded CASE WHEN: sales adds new plan SKUs occasionally; updating a CSV + dbt seed run is faster than editing SQL in 5 places.

**`mart_account_usage_90d`** joins to `dim_latest_plan` via `team_id`, then to `dim_plan_tier_labels` via `plan_id`, surfacing a `plan_tier_label` dimension on every Account-scoped row. Dashboards filter on this.

Studio API and the credit plan master data are *not* the source of truth for churn dashboards. They are alternate views of the same plan space; using them risks divergence. If a discrepancy with `dim_latest_plan` surfaces, fix `dim_latest_plan` upstream.

## What sales needs to enter manually (the form system)

ChurnZero stores some data that **does not come from Amplitude or Salesforce** — sales reps log it directly into CZ. We need an equivalent in Lightdash:

- **Account touchpoints** (last call date, meeting notes summary).
- **Renewal status** annotations (at-risk reason, intervention plan).
- **Custom scoring overrides** (e.g., "force Account X to red regardless of score").

These become **schema-defined forms** in our protopie module; submissions land in Postgres and are exposed back to the warehouse for dbt to model.

See [05-forms-system.md](./05-forms-system.md).

## What external AI agents need (the MCP write tools)

Currently, Lightdash's MCP server (`packages/backend/src/ee/services/McpService/McpService.ts`) exposes **read-only** tools: `list_explores`, `find_content`, `find_fields`, `run_metric_query`, `run_sql`, etc. An external agent (Claude Code, Codex) can *read* the warehouse and *search* existing content, but **cannot create or update** charts, dashboards, or spaces via MCP.

The Protopie use case wants agents to do things like:

> "Claude, create a space called 'Churn Dashboards', then build a dashboard titled 'Account 360 — {{account}}' with the standard tiles, and save it there."

That requires new MCP tools. They are **not Protopie-specific** — they work for any Lightdash user — but we own building them as part of this initiative because nothing else in Lightdash core needs them yet.

See [07-mcp-server-extension.md](./07-mcp-server-extension.md).

## Why fork (and not contribute upstream)

Two reasons:

1. **Velocity.** Lightdash upstream review cycles are slow; we have a fixed cutover before 2026-07-30. We need to ship now and PR clean pieces back later.
2. **Custom business logic.** The churn rubric, the sales-rep forms, and the Pro Plan Plus mapping are Protopie-specific. They don't belong in upstream Lightdash.

The MCP write tools *probably* belong upstream eventually, but we'll build them in our fork first, prove them out, then PR back.

## Success criteria

| # | Criterion | Owner | Measurable |
|---|-----------|-------|------------|
| 1 | ChurnZero subscription canceled by **2026-07-30** | Esther | Procurement record |
| 2 | Sales can view per-Account Churn Score with 90-day filter | Sales | Dashboard URL exists, score values within ±5% of CZ for same period |
| 3 | Sales can log Account touchpoints via in-app form | Sales | Form submissions visible in Postgres + dbt |
| 4 | Churn Score recomputes nightly without manual intervention | Eng | Scheduler task green for 7 consecutive days |
| 5 | External agent can create a dashboard via MCP write tool | Eng | E2E test passes |
| 6 | Pro Plan vs Pro Plan Plus distinction visible in dashboards | Sales | Filter chip shows both values |

## Out of scope (explicit non-goals)

- Replicating CZ's bulk email sender.
- Building a drag-and-drop form builder UI (forms are schema-defined in code).
- Migrating historical CZ Churn Score values — we recompute fresh from warehouse data.
- Real-time (sub-minute) score updates — nightly recompute is the target; hourly is a stretch goal.
- Replacing the Amplitude → warehouse pipeline (already exists).

## References

- Notion brief: [New Usage Data & Churn Score Dashboard](https://www.notion.so/protopie/New-Usage-Data-Churn-Score-Dashboard-35945184b5da80b2aa39c168562d23aa)
- Current Amplitude dashboard draft: [app.amplitude.com/.../8o7beznh](https://app.amplitude.com/analytics/protopie/dashboard/8o7beznh)
- Lightdash MCP read-only server (existing): `packages/backend/src/ee/services/McpService/McpService.ts`
