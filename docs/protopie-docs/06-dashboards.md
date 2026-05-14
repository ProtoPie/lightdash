# 06 — Dashboards

> **Principle.** The dashboards themselves are **regular Lightdash dashboards** — not custom React pages. They live in a dedicated Lightdash space ("Protopie — Sales Ops") and are seeded via Lightdash's existing dashboard-as-code / API path. The Protopie module owns the *data* (marts, scores, submissions) and the *seeding scripts*; it does **not** own a parallel dashboard rendering layer.

## Why we don't build a bespoke dashboard UI

Lightdash already has:
- A dashboard editor with filters, tiles, dates, drilldowns.
- A chart builder over warehouse explores.
- A spaces / permissions model.
- Embedding for external consumption.

Re-implementing any of that for "Churn Score" would be wasted effort and would dilute the isolation strategy. Instead:

- Sales open `lightdash.protopie.com/projects/.../spaces/<protopie-sales-ops-uuid>`.
- They see the existing Lightdash dashboards listed.
- One click → the Usage Data Dashboard. Another → the Churn Score Dashboard.

The only Protopie-built UI is the **forms** UI ([05](./05-forms-system.md)) and the **scoring weights admin** page ([08](./08-frontend-integration.md)). Everything else is configured Lightdash content.

## Two starter dashboards

### 1. Usage Data Dashboard (Account 360)

- **Audience.** Sales reps drilling into a single Account.
- **Filter chip.** Account (`dim_team_summary.namespace` for the dropdown label, `team_id` for the under-the-hood join). One Account selected at a time. Date range default 90 days.
- **Underlying explores.** Built on `mart_account_usage_90d` (NEW), joined to the existing `dim_team_summary`, `dim_enterprise_summary`, `dim_latest_plan`, `fct_pie_usage_monthly`, `fct_team_usage_monthly`, `fct_user_usage_weekly`, `dim_product_all_events`. All the team/plan/event joins are already declared in those models' `meta.joins`.
- **Tiles** (top to bottom, left to right):
  1. **Header tile** — Account name (`dim_team_summary.namespace`), plan tier (`dim_latest_plan.plan_type`), CSM owner, license start (`dim_team_summary.start_date`), seats (`dim_team_summary.max_seats`).
  2. **Churn Score gauge** — latest `total_score` from `mart_churn_score_latest` (NEW Lightdash explore over Postgres `protopie_churn_score`) for this Account.
  3. **Active users (DAU/WAU/MAU)** — line chart over `dim_product_all_events` filtered by team.
  4. **Pie creation/save trend** — bar over `fct_pie_usage_monthly`.
  5. **Trigger/Response actions per week** — bar over `fct_user_usage_weekly`.
  6. **AI usage adoption** — line: `pct_users_with_ai_usage` over time from `mart_account_usage_90d` historical snapshots.
  7. **Active days last 90d** — big-number from `mart_account_usage_90d.active_days`.
  8. **Score factors breakdown** — table from `protopie_churn_score.factor_scores` JSONB (exposed as a Lightdash explore over Postgres).
  9. **Recent touchpoints** — table from `mart_sales_touchpoints` (NEW) filtered to this Account.
  10. **Action item** — a single Markdown tile with a link to the Protopie forms tab (`/projects/:projectUuid/protopie/forms`). The current POC form is `churn_score_input`; final sales form keys will be defined later.

### 2. Churn Score Dashboard (portfolio view)

- **Audience.** Sales managers / leadership.
- **Filters** (these are the *standard* filter set; all churn dashboards inherit them):
  - Account
  - Sales manager / CSM owner
  - Account owner (Salesforce)
  - Plan tier (Pro / Pro Plus / Enterprise)
  - License start date
  - Scored date
  - Lookback window (30 / 60 / 90 / 365 days)
  - Risk band (low / medium / high — names are configurable per score config)
- **Tiles**:
  1. **Account list** — sorted by score ascending, with score, last_touchpoint_date, MRR.
  2. **Score distribution histogram**.
  3. **Score trend over time** — line per Account (top 20 at-risk).
  4. **Accounts that worsened by ≥10 points in the last 30 days**.
  5. **Pro vs Pro Plus split** — bar of average score per tier.

## Lightdash side — dbt project YAML

The marts are exposed to Lightdash via dbt YAML with `meta.lightdash.{type: table}`. Example:

```yaml
# dbt/models/marts/protopie/_protopie_marts.yml
version: 2
models:
  - name: mart_account_usage_90d
    description: Per-Account 90-day usage aggregates for the Churn Score.
    meta:
      lightdash:
        type: table
        joins:
          - join: mart_account_metadata
            sql_on: ${mart_account_usage_90d.account_key} = ${mart_account_metadata.account_key}
    columns:
      - name: account_key
        description: Amplitude cloud_url (Protopie tenant URL)
        meta:
          dimension:
            type: string
            label: Account
      - name: pct_users_with_starting_action
        description: …
        meta:
          metric:
            type: average
            label: '% Users w/ Starting Action'
            format: percent
      # ... etc.
```

Refer to Lightdash's existing dbt model patterns for the exact YAML — copy from a working `meta.lightdash` example in the repo. **Do not** invent new YAML conventions.

### Pro / Pro Plus split

A single dimension `plan_tier` (`Pro`, `Pro Plus`, `Enterprise`, …) sourced from the Studio API mart. Add it to the join in YAML so all charts inherit the filter. This is the answer to the Notion brief's "Action needed #1": expose `plan_tier` in the explore.

## Seeding dashboards via content-as-code (`CoderService`)

Lightdash's `CoderService` (`packages/backend/src/services/CoderService/CoderService.ts`) is the canonical write path for dashboards/charts/spaces. It exposes:

- `getOrCreateSpace(user, projectUuid, spaceSlug, opts)` — idempotent space creation.
- `upsertChart(user, projectUuid, slug, ChartAsCode, opts)` — create-or-update by slug.
- `upsertSqlChart(user, projectUuid, slug, SqlChartAsCode, opts)`.
- `upsertDashboard(user, projectUuid, slug, DashboardAsCode, opts)` — tiles reference chart slugs; UUIDs resolved automatically.

It checks `manage:ContentAsCode` (an existing CASL scope), creates missing spaces, and uses `PromoteService` under the hood for safe updates. **All Protopie dashboard seeding goes through this service**, never via raw SQL or `DashboardModel.create()`.

### The bootstrap endpoint

We expose one **idempotent** bootstrap endpoint:

```
POST /api/v1/projects/:projectUuid/protopie/churn/dashboards/bootstrap
```

The handler reads YAML from `lightdash/dashboards/protopie-*.yml` + `lightdash/charts/protopie-*.yml` in the data-modeling repo and:

1. Calls `CoderService.getOrCreateSpace(projectUuid, 'protopie/sales-ops', user, /* skipSpaceCreate */ false, /* publicSpaceCreate */ false)` — positional args.
2. For each chart, calls `CoderService.upsertChart(user, projectUuid, slug, chartAsCode, false, false, false)` with stable slugs (e.g., `protopie-churn-score-gauge`).
3. Calls `CoderService.upsertDashboard(user, projectUuid, dashboardSlug, dashboardAsCode, false, false, false)`.
4. Returns the aggregated `PromotionChanges` result per dashboard so the operator sees what was created/updated/unchanged.

### Diff / preview behavior

Before any write, the bootstrap endpoint accepts `?dryRun=true` and returns the *intended* `PromotionChanges` without applying. This lets ops verify "what would happen" before pulling the trigger. The implementation reuses `CoderService`'s internal change-detection (the same logic that produces `action: 'no_changes'`).

### Update behavior — how CoderService handles re-runs

`CoderService.upsertX` is **content-comparison-based**, not last-write-wins. On each call it:

- Loads the existing entity by slug (if any).
- Computes a hash/diff against the incoming `*AsCode` payload.
- If equal → `action: 'no_changes'`, no DB writes.
- If different → `action: 'update'`, creates a new `dashboard_versions` / `saved_queries_versions` row (Lightdash's existing versioning) and returns `'update'`.
- If absent → `action: 'create'`.

This means **bootstrap is safe to re-run any time**. The YAML in git is the source of truth; manual edits made in the UI between bootstrap runs are overwritten on the next bootstrap. *That's by design* — if you want to keep a dashboard editable by hand, don't bootstrap it. Conversely, if a dashboard is in the bootstrap YAML, the YAML wins.

### Conflict with manual edits

If a user has been hand-editing `protopie-account-360` in the UI and ops runs bootstrap, the manual edits are lost (overwritten by the YAML version). Mitigation:

- **Convention:** Anything under the `protopie/sales-ops` space with a `protopie-` slug is bootstrap-managed and **read-only** for end users. The space-level access list grants `viewer` (not `editor`) to the sales team; only admin can edit.
- **UI warning:** When opening a dashboard that has a `protopie-` slug, surface a one-time toast: "This dashboard is managed via content-as-code. Edits will be overwritten on the next bootstrap. Edit the YAML in `data-modeling/lightdash/dashboards/` instead."
- **Audit:** Every bootstrap run writes a row in `protopie_dashboard_bootstrap_runs` (new table — see below) with `PromotionChanges` summary. If anyone sees their work disappear, the audit row explains who triggered the overwrite.

```sql
CREATE TABLE protopie_dashboard_bootstrap_runs (
    run_uuid               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid           UUID NOT NULL REFERENCES projects(project_uuid) ON DELETE CASCADE,
    triggered_by_user_uuid UUID NOT NULL REFERENCES users(user_uuid),
    dry_run                BOOLEAN NOT NULL,
    changes                JSONB NOT NULL,           -- the PromotionChanges response
    yaml_source_ref        VARCHAR(120),              -- e.g. git commit SHA of the YAML
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Rollback

There is no first-class "undo bootstrap" button. Two paths:

1. **Re-bootstrap from an earlier YAML commit.** Check out the previous version of `data-modeling/lightdash/dashboards/protopie-*.yml`, deploy, run bootstrap. The dashboards revert. (This is the recommended path — bootstrap is idempotent and reversible by design.)
2. **Lightdash dashboard version revert.** Lightdash already supports reverting a dashboard to a prior `dashboard_versions` row via the UI. After a bad bootstrap, an admin reverts the dashboard in the UI; the next bootstrap will overwrite again unless you also revert the YAML — so this is a fire-drill measure, not a long-term fix.

### Manual edits as a deliberate exception

If sales wants a dashboard they can hand-edit (e.g., "Esther's custom risk view"), put it in a **different space** (not `protopie/sales-ops`) with a slug that does NOT start with `protopie-`. Bootstrap never touches such dashboards.

### Where the YAML lives

The dashboard + chart YAML files live **in the data-modeling repo** at `lightdash/charts/protopie-*.yml` and `lightdash/dashboards/protopie-*.yml` — *next to the existing chart YAMLs* (the data-modeling repo already has `lightdash/charts/event-info-details.yml`, `lightdash/dashboards/product-dashboard.yml`, etc.). This colocates the data model and its visualizations.

The bootstrap endpoint in Lightdash reads them from a mounted directory or by HTTP from the dbt repo's CI artifact. Updating a dashboard = edit YAML in `data-modeling` → PR → deploy → call bootstrap.

> Use long descriptive slugs (`protopie-account-360-q2-2026` not `account-360`) and **prefix every slug with `protopie-`** to avoid collisions with existing charts in the same Lightdash project. Lightdash slugs are **not** uniquely enforced at the DB level — see the Slugs warning in the root `CLAUDE.md`.

## Alternative seeding path: MCP content-as-code tools

Once [07-mcp-server-extension.md](./07-mcp-server-extension.md) ships, the same `CoderService` is reachable via MCP — meaning an external agent can author dashboards programmatically:

```text
agent: → tool: protopie_create_space(spaceSlug: "protopie/sales-ops", name: "Protopie — Sales Ops")
       → tool: protopie_upsert_chart_as_code(slug: "protopie-churn-score-gauge", ...)
       → tool: protopie_upsert_dashboard_as_code(slug: "protopie-account-360", spaceSlug: "protopie/sales-ops", ...)
```

This is dogfooding: the MCP content-as-code tools build our own dashboards. Strongly recommended for the **second** dashboard onward. The first one is built either by hand in the UI (to validate the data) or via the bootstrap endpoint (to validate the bootstrap path itself).

## Permissions

- The space "Protopie — Sales Ops" is created with explicit member list: the Sales group + Ops admins.
- Lightdash already supports per-space access control. No custom code needed.
- Public link sharing: **disabled** for these dashboards (contains Account names and MRR).
- Embedding: also disabled unless the team explicitly asks for it later.

## What we keep out of these dashboards

- **PII**. The `mart_sales_touchpoints` mart **must not** export raw email bodies or anything resembling personal data of contacts. Only the summary (which the rep wrote) and metadata (date, channel, sentiment).
- **Inferred predictions**. Sales asked for the Churn Score (a deterministic weighted-sum), not an ML churn prediction. If we add an ML model later, it lives in a separate mart and a separate dashboard — and goes through privacy review first.
