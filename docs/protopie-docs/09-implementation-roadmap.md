# 09 — Implementation Roadmap

> **Hard deadline.** ChurnZero subscription ends **2026-07-30**. Sales must be off CZ by then. That's the milestone that drives everything else.
>
> We slice into five phases, with the first three delivering ChurnZero parity. Phase 4 (MCP write tools) and Phase 4.5 (deployment plumbing) are independently valuable and run in parallel.

## Phase plan at a glance

```
P1 — Foundations & data
P2 — Forms + score backend
P3 — Dashboards & UI
P4 — MCP write tools (parallel track)
P4.5 — Deployment plumbing (parallel track)
P5 — Hardening, UAT, ChurnZero parallel run, cutover
                       ▲
                       complete before 2026-07-30
```

## Phase 1 — Foundations & data

**Goal.** Set up the isolation skeleton and the warehouse marts. Nothing is user-visible yet.

### Backend

1. Create `packages/{common,backend,frontend}/src/protopie/` folder skeletons (with `index.ts` placeholders and a README pointing to `docs/claude-docs/`).
2. Add runtime config intentionally. Current MCP enablement uses existing `MCP_ENABLED`; a global `PROTOPIE_ENABLED` kill switch is not implemented yet.
3. Set up the `protopie_*` migrations directory and `knexfile` entry (🔌 WIRE-UP #2).
4. Write migration `20260512000000_create_protopie_tables.ts` for the **8 tables** listed in [03-data-model.md](./03-data-model.md): `protopie_form_definitions`, `protopie_form_submissions`, `protopie_churn_score_configs`, `protopie_churn_score_factors`, `protopie_churn_score`, `protopie_churn_score_factor_results` (optional), `protopie_churn_score_runs`, `protopie_account_overrides`. Seed 1 default config + 9 factors.
5. Implement model classes (`FormSubmissionModel`, `ScoringRuleModel`, `ChurnScoreModel`, etc.) — Knex-only, no service logic.

### dbt — in the data-modeling repo at `/Users/mamur/Documents/projects/data-modeling`

6. Add a `protopie` block to `dbt_project.yml` under `models:` and `vars:` — see [11-dbt-integration.md](./11-dbt-integration.md).
7. New folder `models/marts/warehouse/protopie/daily/`. Add an empty `_protopie__models.yml` for schema metadata.
8. Create `models/intermediate/protopie/int_protopie_team_user_event_counts.sql` (intermediate).
9. Create `models/marts/warehouse/protopie/daily/mart_account_usage_90d.sql` with `meta.joins` pointing at `dim_team_summary` and `dim_enterprise_summary`.
10. Add the `dim_churn_score_event_groups` seed CSV and run `dbt seed`.
11. dbt tests: `unique` + `not_null` on `team_id`; `not_null` on `total_users`; `accepted_values` for `factor_key` in the seed.
12. Confirm CI's auto-manifest generation picks up the new models (the repo has Airflow integration tied to manifest).

### Exit criteria
- `pnpm -F backend migrate` creates all 6 Protopie tables in local Postgres.
- `dbt build --select +protopie+` succeeds, marts populate against staging warehouse.
- `psql -c "SELECT * FROM protopie_churn_score_configs"` returns the 1 seeded active config; `psql -c "SELECT * FROM protopie_churn_score_factors"` returns the 9 seed rows linked to it.

---

## Phase 2 — Forms + score backend

**Goal.** Sales can hit the API to submit forms; backend can compute scores. No UI yet.

### Backend

1. Implement `FormService` + `FormController` ([05](./05-forms-system.md)).
2. Define the first three form schemas in `packages/common/src/protopie/forms/schemas/`:
   - `accountTouchpoint` (logged communications)
   - `renewalStatus` (renewal notes)
   - `accountOverrideCreate` (force a score)
3. `pnpm generate-api` — verify the new endpoints show up in OpenAPI.
4. Implement `ChurnScoreService.recomputeAll()` + `scoreAccount()` ([04](./04-churn-score-engine.md)).
5. Wire up the Graphile Worker task `protopie.recomputeChurnScore` (🔌 WIRE-UP #3).
6. Implement read controllers: `GET /api/v1/protopie/churn/score?accountKey=`, `GET /api/v1/protopie/churn/rules`, `PUT /api/v1/protopie/churn/rules/:ruleKey`, `POST /api/v1/protopie/churn/recompute`.
7. Wire DI providers (🔌 WIRE-UP #1) in `App.ts`.

### dbt

8. Add `protopie_postgres` as a dbt source (`_protopie_postgres.yml`) and build `mart_sales_touchpoints.sql` ([05](./05-forms-system.md)).
9. Build `mart_churn_score_latest.sql` (read the most recent score per Account per rule_set_version).

### Tests

10. Unit tests for `scoreAccount()` with synthetic inputs.
11. Integration test: submit a form via HTTP, observe row in `protopie_form_submissions`.
12. Integration test: run `recomputeAll()` against a fixture warehouse, assert scores match a golden file.

### Exit criteria
- `curl -X POST /api/v1/projects/:projectUuid/protopie/forms/churn_score_input/submissions ...` returns 201 for the current POC form.
- `curl -X POST /api/v1/protopie/churn/recompute` enqueues a job; worker runs it; scores appear in `protopie_churn_score`.
- Schedule cron is registered; nightly run completes on staging.

---

## Phase 3 — Dashboards & UI

**Goal.** Sales can see dashboards and submit forms from the browser. Feature-complete for ChurnZero parity.

### Lightdash dashboards (configuration)

1. Create the "Protopie — Sales Ops" space in prod Lightdash.
2. Add dbt YAML metadata to expose `mart_account_usage_90d`, `mart_churn_score_latest`, `mart_account_metadata`, `mart_sales_touchpoints` as Lightdash explores ([06](./06-dashboards.md)).
3. Build **Usage Data Dashboard** (Account 360) in Lightdash UI.
4. Build **Churn Score Dashboard** (portfolio view) in Lightdash UI.
5. Export both as content-as-code JSON, commit to `dashboards/protopie/` in this repo.

### Frontend

6. Build the route tree (`/protopie/*`) and pages from [08](./08-frontend-integration.md):
   - `ProtopieHomePage`
   - `FormsListPage`, `FormSubmitPage`, `FormHistoryPage`
   - `ScoringWeightsPage`
   - `AccountOverridesPage`
7. Implement `DynamicForm` and `AccountPickerCombobox`.
8. Wire up route mount and nav entry (🔌 WIRE-UP #6, #7).
9. End-to-end test: a sales user logs in, opens the home page, submits a touchpoint, sees it appear in history.

### Exit criteria
- A sales rep navigates to `/protopie` and successfully logs an Account touchpoint without help.
- Both dashboards render with real data for 5+ Accounts.
- Score values for 5 sampled Accounts differ from ChurnZero by ≤ 5 points (the dashboard tells the same story).

---

## Phase 4 — MCP write tools (parallel track)

**Goal.** External AI agents can create/update charts, dashboards, spaces via MCP. Runs in parallel with Phases 1-3.

1. Define Zod input schemas for Protopie MCP tools ([07](./07-mcp-server-extension.md)).
2. Implement `registerProtopieMcpTools` with:
   - dbt source read tools: `protopie_dbt_list_files`, `protopie_dbt_get_file`, `protopie_dbt_search_files`
   - content-as-code read/write tools: `protopie_get_*_as_code`, `protopie_upsert_*_as_code`
   - space tools: `protopie_create_space`, `protopie_update_space`
   - guarded API bridge: `lightdash_list_api_endpoints`, `lightdash_api_get`, `lightdash_api_mutate`
3. Wire `registerProtopieMcpTools` into `McpService.ts` (🔌 WIRE-UP #4).
4. Add `mcp:write`, org opt-in, and service-layer permission checks for write tools.
5. Add audit tracking per write tool call.
6. Tests:
   - Unit: each tool's schema parsing.
   - Integration: in-process MCP server harness, call each tool, assert Postgres state.
   - E2E: Claude Code creates space → chart → dashboard, then archives.
7. Document the tools in `docs/protopie-docs/07-mcp-server-extension.md` (already done) and add a "Getting started for external agents" section.

### Exit criteria
- E2E test green.
- A Claude Code session can issue: "Create a space called 'Demo'. Build a dashboard inside it titled 'Hello World' with a markdown tile." — and the result is visible in the Lightdash UI.

---

## Phase 4.5 — Deployment plumbing (parallel track)

**Goal.** Get our forked image building and deployable to ECS dev. Detailed in [15-deployment.md](./15-deployment.md).

1. Set up an ECR repo `protopie/lightdash` in the `xid-dev` AWS account; same in `xid-prod`.
2. Add `.github/workflows/build-image.yml` to this Lightdash fork: build on push to `main`, push to ECR with `<commit-sha>` and `latest` tags.
3. In `infra/dev/ecs.tf`, point the ECS task at the ECR image repo.
4. In `infra/dev/.env`, set `MCP_ENABLED=true` and the `PROTOPIE_DBT_GITHUB_*` env vars for data-modeling source context.
5. In `infra/dev/ecs.tf`, add the corresponding `environment[]` entries.
6. `terraform plan` -> review -> `terraform apply` in `infra/dev/`.
7. Smoke test against dev URL.
8. Repeat steps 3-7 in `infra/prod/` only after dev has been stable for ≥48h with Protopie features enabled.

### Exit criteria
- A push to `main` of this fork produces an ECR image tag.
- `terraform apply` in `infra/dev` rolls the new image and the dev URL serves Protopie pages.
- Backend logs in CloudWatch show no errors during the first hour after deploy.

---

## Phase 5 — Hardening, UAT, cutover

**Goal.** Sales runs the new system in parallel with ChurnZero; we validate; cutover.

1. **Reconciliation against CZ**:
   - Both systems active. Sales uses the new Lightdash UI; ChurnZero remains as the source-of-truth fallback.
   - Run the formal 6-step reconciliation from [04-churn-score-engine.md](./04-churn-score-engine.md#reconciliation-against-churnzero-pre-cutover):
     1. Account count per plan tier.
     2. Active user count per Account (90d).
     3. Per-factor `raw_value` agreement (±5% for ≥80% of Accounts).
     4. Per-factor `points_awarded` agreement.
     5. `total_score` and `risk_band` agreement (top-30 at-risk: same Accounts in both lists with score diff < 10pt).
     6. Documented expected differences (formula linear-vs-stepwise, event mapping nuances).
   - **Lock score config changes** during reconciliation — no rubric edits until cutover, or comparisons become meaningless.
2. **Sign-off**:
   - Esther + sales lead approve the new system in writing.
   - Open reconciliation gaps documented with owner + ETA (or accepted as known divergences).
3. **Cutover**:
   - Update internal sales ops playbooks to point at Lightdash URLs.
   - Email announcement.
   - ChurnZero put in read-only mode (no new data ingested).
4. **CZ shutdown** (before 2026-07-30):
   - Cancel subscription.
   - Export historical CZ data for archival (not migrated — kept as a snapshot).

---

## The "kill switch" criterion

At the end of every phase, we verify the isolation rule still holds:

```bash
# This must still produce a clean, working Lightdash with no Protopie traces:
git checkout HEAD^
git apply --reverse <protopie touch-point patch>
rm -rf packages/{common,backend,frontend}/src/protopie
psql -c "DROP TABLE protopie_form_submissions, protopie_form_definitions, protopie_churn_score_factors, protopie_churn_score_configs, protopie_churn_score_factor_results, protopie_churn_score, protopie_churn_score_runs, protopie_account_overrides"
pnpm -F backend typecheck && pnpm -F frontend typecheck && pnpm -F common typecheck
pnpm -F backend test:dev:nowatch
```

If any step fails, we've leaked Protopie code into core. Stop the phase and refactor.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Score values disagree with ChurnZero by > 5pt → trust loss | High | High | Phase 5 parallel run with reconciliation. Tune rules with sales lead before cutover. |
| `mart_account_usage_90d` is wrong because Amplitude event names changed | Medium | High | dbt test on event presence + freshness check on `amplitude_events` source. |
| TSOA `generate-api` breaks on new controllers | Low | Medium | Run `pnpm generate-api` in CI on every PR touching `protopie/`. |
| Permissions edge case lets non-sales view internal touchpoints | Low | High | Org-scoped reads in `FormSubmissionModel.list()`; integration test for cross-org isolation. |
| MCP write tool exposed via OAuth without proper scope check | Medium | High | Every write tool checks `mcp:write`, org opt-in, and the underlying Lightdash service permission; tested in integration harness. |
| Upstream Lightdash merge conflict on the 7 touch points | Medium | Low | Touch points are tiny and idempotent; conflicts resolve in minutes. |
| ChurnZero CSV data not in warehouse (e.g., a metric only existed in CZ) | Medium | Medium | Phase 1 inventory: list every ChurnZero metric in use, confirm each has a warehouse equivalent. |

## Owner mapping (placeholder — confirm with team)

| Track | Owner | Reviewer |
|-------|-------|----------|
| dbt marts | Data eng | Esther |
| Backend (forms, scoring) | Backend eng | Eng lead |
| Frontend (`protopie/`) | Frontend eng | Eng lead |
| MCP extension | Backend eng | Lightdash team contact (for eventual upstream PR) |
| Dashboards (Lightdash UI) | Sales ops + data eng | Esther |
| QA & parallel run | Sales lead | Esther |

## What we ship in v1, what we explicitly defer

**v1 (by 2026-07-30):**
- Forms: touchpoint, renewal status, override.
- Score: nightly recompute, the 9 default rules, weight admin page.
- Dashboards: Account 360, Churn Score portfolio.
- MCP: existing Lightdash read tools plus Protopie dbt source tools, content-as-code create/update tools, and the guarded API bridge.

**Deferred to v1.1 (post-cutover):**
- Salesforce $$ data integration into dashboards (the "good to have" from the Notion brief).
- Hourly/real-time score recompute (cron is nightly in v1).
- Pro / Pro Plus split filter (the Notion "Action needed" — depends on `plan_tier` mart, which we build but the UI filter chip is v1.1).
- Forms-as-DB (currently code-defined; later move to runtime-editable).

## Definition of done

- All Phase 5 exit criteria met.
- ChurnZero subscription canceled.
- Three working dashboards (or more — sales builds extras via the MCP content-as-code tools).
- Documentation updated to reflect actual implementation (these docs are a *starting point*, not a contract).
- One retrospective documenting what we'd do differently, ideally before any upstream PR back to Lightdash.
