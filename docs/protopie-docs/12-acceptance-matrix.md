# 12 — Acceptance Matrix

> One row per requirement → implementation file paths → verification step. Tick a row when its verification passes. Sales-side sign-off requires every "Required for v1 cutover" row to be ✓.

## Legend

- **Status:** `□` not started · `▣` in progress · `✓` done
- **Required for v1 cutover** (by 2026-07-30): rows marked **R**. Cutover blocked if any **R** row is not ✓.
- **Verification commands** assume you're in the appropriate repo (Lightdash fork or `data-modeling`).

## Functional requirements

| # | Requirement | R | Implementation | Verification | Status |
|---|------------|---|----------------|--------------|--------|
| F1 | Sales rep can submit an "Account Touchpoint" via the app | R | [05-forms-system.md](./05-forms-system.md), `packages/backend/src/protopie/controllers/FormController.ts`, `packages/frontend/src/protopie/pages/FormSubmitPage.tsx` | Open `/projects/:projectUuid/protopie/forms/account_touchpoint`, submit, see 201 + row in `protopie_form_submissions`. | □ |
| F2 | Submission payload validated server-side (Zod) | R | `FormService.submit()` runs `form.schema.parse()` before insert | Try `curl -X POST … -d '{"payload":{"invalid":true}}'`, expect 400. | □ |
| F3 | Submission has extracted `account_key`, `cloud_url`, `salesforce_account_id` columns | R | `FormService.submit()` extracts via `form.accountKeyField` / `secondaryKeyFields` | `psql -c "SELECT account_key, cloud_url FROM protopie_form_submissions LIMIT 5"` returns non-null `account_key`. | □ |
| F4 | Sales rep can supersede their own touchpoint | R | `POST … --supersedesSubmissionUuid <uuid>` | New row with `supersedes_submission_uuid` set; old row remains intact. | □ |
| F5 | dbt marts created for usage data + form data | R | [11-dbt-integration.md](./11-dbt-integration.md). New folders in `data-modeling` repo. | `cd /Users/mamur/Documents/projects/data-modeling && dbt run --select tag:protopie && dbt test --select tag:protopie` exits 0. | □ |
| F6 | Churn score computed per Account, nightly | R | [04-churn-score-engine.md](./04-churn-score-engine.md). `ChurnScoreService.recomputeAll()` + Graphile Worker cron `0 2 * * *`. | After cron firing: `psql -c "SELECT COUNT(*), MAX(computed_at) FROM protopie_churn_score WHERE scored_for_date = current_date"` returns ≥ ~500, max(computed_at) within last 3h. | □ |
| F7 | Sales manager can change scoring weights | R | `ScoringWeightsPage.tsx`, `PUT /api/v1/protopie/churn/configs/:configUuid/factors/:factorKey` | Edit weight in UI, see new `version` row in `protopie_churn_score_configs`. | □ |
| F8 | Account 360 dashboard exists with score + tiles | R | [06-dashboards.md](./06-dashboards.md). YAML in `data-modeling/lightdash/dashboards/protopie-account-360.yml`. Built via bootstrap endpoint. | Browse Lightdash UI to the dashboard; all 10 tiles render real data for ≥1 Account. | □ |
| F9 | Churn Score Portfolio dashboard exists | R | YAML in `data-modeling/lightdash/dashboards/protopie-churn-score-portfolio.yml` | Browse Lightdash UI; account list sorted by score ascending. | □ |
| F10 | Dashboard filters: Account, plan tier, CSM owner, score band, lookback window | R | Lightdash dashboard config (in YAML) | Apply each filter in turn; all combinations return data. | □ |
| F11 | Pro vs Pro Plus / Pro Plus Plus split visible | R | Filter chip backed by `dim_plan_tier_labels` seed (see [00-context.md](./00-context.md)) | Filter shows both values; counts differ. | □ |
| F12 | MCP can create a space | R if MCP is shipped | [07-mcp-server-extension.md](./07-mcp-server-extension.md). `create_space` tool. | E2E test: agent calls `create_space` → row in `spaces` table. | □ |
| F13 | MCP can create / update a dashboard via content-as-code | R if MCP is shipped | `upsert_dashboard_as_code` tool wrapping `CoderService.upsertDashboard` | Agent creates dashboard with 2 chart tiles; `PromotionChanges` shows `{action:'create'}` for new entities, `{action:'no_changes'}` on re-run. | □ |
| F14 | MCP can create / update a saved chart | R if MCP is shipped | `upsert_chart_as_code` | Agent creates chart; visible in Lightdash UI. | □ |
| F15 | MCP can create / update a SQL chart | | `upsert_sql_chart_as_code` | Agent creates SQL chart; row in `saved_sql`. | □ |
| F16 | MCP `mcp:write` scope enforced | R if MCP is shipped | `requireMcpWrite()` helper | OAuth client without `mcp:write` scope receives `ForbiddenError`. | □ |
| F17 | MCP write tools OFF by default per org | R if MCP is shipped | `protopie_organization_settings.mcp_write_tools_enabled` | Brand-new org: any write tool call returns `ForbiddenError`. After admin toggle ON: succeeds. | □ |
| F18 | MCP write tool calls audited | R if MCP is shipped | `protopie_mcp_audit_log` | `SELECT * FROM protopie_mcp_audit_log ORDER BY created_at DESC LIMIT 5` returns the last 5 invocations. | □ |

## Cutover requirements

| # | Requirement | R | Verification | Status |
|---|------------|---|--------------|--------|
| C1 | ChurnZero subscription parity validated | R | [04-churn-score-engine.md § Reconciliation](./04-churn-score-engine.md#reconciliation-against-churnzero-pre-cutover): the 6-step protocol passes. Top-30 at-risk match with ≤10pt diff. | □ |
| C2 | Sign-off in writing from Esther + sales lead | R | Notion page or email captured. | □ |
| C3 | Sales playbooks updated to point at Lightdash URLs | R | Linked from the relevant Sales Notion pages. | □ |
| C4 | ChurnZero set to read-only (no new data ingested) | R | Confirm with CZ admin; check Amplitude → CZ CSV export job is paused. | □ |
| C5 | ChurnZero subscription canceled | R | Procurement record. Must complete before 2026-07-30. | □ |
| C6 | Operational runbook published and team-trained | R | [13-operational-runbook.md](./13-operational-runbook.md) exists; one dry-run "failed nightly recompute" handled per the runbook. | □ |
| C7 | Historical CZ data exported and archived | | One-time CSV/JSON export stored in S3 with read-only retention. | □ |

## Non-functional requirements

| # | Requirement | R | Verification | Status |
|---|------------|---|--------------|--------|
| N1 | Nightly recompute completes in < 5 minutes | R | `protopie_churn_score_runs.finished_at - started_at` p95 < 300s over 7 days. | □ |
| N2 | App DB → Redshift staleness < 4× cadence | | The freshness metric documented in [11-dbt-integration.md § Failure handling](./11-dbt-integration.md). | □ |
| N3 | Submission insert latency p95 < 300ms | | k6 / Locust load test on `POST /forms/.../submissions`. | □ |
| N4 | All form submissions surveyed in dbt mart within hourly cadence | | Insert a test submission; verify it appears in `mart_sales_touchpoints` ≤ 65 min later. | □ |
| N5 | No Protopie code in non-`protopie/` paths (kill-switch test passes) | R | [09-implementation-roadmap.md § Kill switch criterion](./09-implementation-roadmap.md). Run the test script. | □ |

## Security & privacy requirements

| # | Requirement | R | Verification | Status |
|---|------------|---|--------------|--------|
| S1 | Form submissions visible to org members only | R | Cross-org test: create user in org B, hit `GET /api/v1/protopie/forms/account_touchpoint/submissions` — get 0 results. | □ |
| S2 | Soft-delete preserves audit trail | R | After soft-delete, row still in DB with `deleted_at` set. `mart_sales_touchpoints` filters it out. | □ |
| S3 | PII not exported in MCP audit log payloads | | Read 10 random audit rows; confirm `input_summary` contains only slug, projectUuid, spaceSlug — never full payload. | □ |
| S4 | Retention policy documented & enforced | R | [13-operational-runbook.md](./13-operational-runbook.md) § Retention. Cron job purges submissions older than the configured TTL. | □ |
| S5 | Warehouse credentials never logged | R | `grep -r "redshift_password\|REDSHIFT_PASSWORD" packages/backend/src` returns no log statements. | □ |
| S6 | Sensitive credentials filter (Lightdash) includes any new auth fields | | If any new auth method ships in this fork, verify `sensitiveCredentialsFieldNames` in `packages/common/src/types/projects.ts` includes it. | □ |

## Sign-off block

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Esther (Sales Ops) | | | |
| Sales lead | | | |
| Backend eng | | | |
| Data eng | | | |
| Frontend eng | | | |
| Security review (informal) | | | |

Print this page, gather signatures, store in the runbook archive.
