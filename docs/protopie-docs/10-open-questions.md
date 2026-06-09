# 10 — Open Questions

> Decisions still to make. Each has a recommended default (so we can ship without waiting), but each affects the product and should be confirmed with stakeholders before final cutover.

## From the Notion brief

The Notion page included four open questions (C7–C10). Recommendations below.

### C7. How often will weights change?

> *Quarterly / monthly / ad-hoc?*

**Recommendation: monthly cadence, ad-hoc allowed.**

- Cadence drives the `rule_set_version` strategy. Monthly is consistent enough to be predictable but flexible enough to react to incidents.
- Implementation already supports ad-hoc — every weight change creates a new `rule_set_version`. So this question is mainly about the review process, not the technical design.

**Affected docs:** [04-churn-score-engine.md](./04-churn-score-engine.md), [03-data-model.md](./03-data-model.md).

### C8. When weights change, do we recompute history?

> *Recompute all past scores under the new rubric, or only from the change point forward?*

**Recommendation: only forward.**

- Past scores stay tagged with their `rule_set_version`. This is what we already implement.
- Sales sees the score-trend chart filtered to the latest version by default, with a "show all versions" toggle for auditors.
- Rationale: rewriting history retroactively makes the "did Account X get worse?" question harder to answer ("worse under which rubric?").

### C9. Who can change weights?

> *All sales / managers only / Esther only?*

**Recommendation: managers + Esther; weight changes bump `protopie_churn_score_configs.version` (immutable per version), audit columns track who/when.**

- Front-end gates the `ScoringWeightsPage` admin view on the existing Lightdash "developer" role at minimum.
- For v1, we use the existing Lightdash role system (no new scope). If product wants a Protopie-specific role later, we add a `protopie:churn:rules:write` scope — see warning below.

> ⚠ **Adding a custom scope means editing `projectMemberAbility.ts`, `roleToScopeMapping.ts`, `serviceAccountAbility.ts`** (per Lightdash `CLAUDE.md`). That **violates the isolation rule**. Defer adding a custom scope until v1.1; for v1 do inline role checks in the controller.

### C10. Scoring function shape — linear or step?

> *Linear (`LEAST(value/goal, 1) * weight`) or step-wise (`threshold_1 / points_1`, …)?*

**Recommendation: linear for v1; step supported in the schema for future use.**

- The data model already supports both (`scoring_function` column + optional `step_thresholds` JSONB).
- Linear is simpler, easier to explain ("you got 80% of the goal → 80% of the points"). Step is what ChurnZero does today.
- We **default** to linear in v1. Once sales has lived with linear for a sprint, they decide: keep linear, or migrate specific rules to step.
- Migrating one factor from linear to step is a single-row UPDATE on `protopie_churn_score_factors.step_thresholds` (combined with a config-version bump if you want auditability). No code change.

## Engineering decisions still to make

### E1. Forms defined in code or in DB?

**Recommendation: code (v1).**

- Code-defined: easier to ship, fully type-safe, reviewed in PR.
- DB-defined: lets ops add new forms without an engineer.
- Default to code. Migrate to DB only when we hit ≥5 forms and adding new ones is slowing us down.

### E2. dbt project location?

**Resolved.** The dbt project already exists as a **separate repo** at `/Users/mamur/Documents/projects/data-modeling` (the "data-modeling" repo). Protopie additions go into `models/marts/warehouse/protopie/` and `models/staging/protopie_app/` *within that repo*. We coordinate via README pointers between the two repos. See [11-dbt-integration.md](./11-dbt-integration.md).

### E3. Account identity — what is *the* canonical key?

**Resolved.** Inspection of the data-modeling repo confirms the warehouse's canonical Account entity is `dim_team_summary`, keyed by `team_id` (opaque PK) with `namespace` (human-readable) and `url` (the `cloud_url` sales sees).

**Decision:** `team_id` is the canonical `account_key` on the Protopie backend tables. We persist `namespace`, `cloud_url`, and `salesforce_account_id` as nullable secondary columns for join flexibility.

**Still to confirm:**
- Does the team identity differ between Cloud and Enterprise customers? (`stg_all_teams` unions both; need to confirm `team_id` is globally unique.)
- For Salesforce join: which Salesforce field maps to `namespace` vs `team_id` vs `url`?
- Some sales-rep forms might be more naturally keyed on `cloud_url` for UX (sales rep pastes a URL). The form's `accountKeyField` resolves `cloud_url` → `team_id` via `dim_team_summary` lookup at submit time.

### E3b. Risk band names and thresholds — fixed or configurable?

**Question:** Today the score config defines bands at `score_percent ≥ 0.75 → low`, `≥ 0.50 → medium`, `< 0.50 → high`. Should sales be able to change the thresholds or the names ("red/amber/green" vs "low/medium/high" vs Korean labels)?

**Recommendation:** Already configurable via `protopie_churn_score_configs.risk_band_thresholds` JSONB. UI exposure is v1.1 — for v1, the thresholds are baked into the seed config and require a config-version bump (which is what we want for auditability).

### E4. Warehouse credentials for the backend's mart read?

**Question:** When `ChurnScoreService.recomputeAll()` reads `mart_account_usage_90d`, which Lightdash project's warehouse client (Redshift) does it use?

**Recommendation:** Configure a single "Protopie internal" project UUID in env. The recompute task hard-codes that project. This means:
- Sales has access to the same Redshift warehouse via Lightdash UI (no new auth surface).
- Operationally, we reuse one project's Redshift credentials and don't sprinkle warehouse access across the codebase.

The fully-qualified mart name is `warehouse_dev.mart_account_usage_90d` in dev, `warehouse_prod.mart_account_usage_90d` in prod (controlled by `DBT_ENVIRONMENT` env var in the dbt project's `profiles.yml`). The backend reads this from env config and never hard-codes the schema.

### E5. Notification when a score crosses a threshold?

**Question:** When an Account drops below 40 (the "red" band), should we notify the CSM owner?

**Recommendation:** v1.1. v1 is read-only dashboards. v1.1 adds an alert rule (likely via Lightdash's existing scheduler/alert system, not a new mechanism).

### E6. Score history retention?

**Question:** How long do we keep daily score rows in `protopie_churn_score`?

**Recommendation:** Keep all. At ~500 Accounts × 365 days × 2–3 rule versions/yr = ~500k rows max. Negligible storage. No retention policy needed until row count crosses 10M, which is years away.

### E7. Are MCP write tools enabled by default or behind a flag?

**Question:** Should MCP write tools such as `protopie_upsert_dashboard_as_code` be exposed to every authenticated MCP user, or gated by an org-level setting?

**Decision:** Gate behind an org-level setting (default OFF). Reason: write tools are powerful; an org admin should explicitly opt-in. Once enabled, per-user permission still uses the existing CASL ability checks.

The setting lives in `protopie_organization_settings`, keyed by `organization_uuid`, and is exposed to org admins at `/generalSettings/integrations` via `GET/PATCH /api/v1/protopie/mcp-settings`.

### E8. Slack notifications for `recomputeChurnScore` runs?

**Recommendation:** Yes — post a daily message to a `#protopie-data-ops` Slack channel: "Last night's recompute finished in 8s, 487 Accounts scored, 0 failures." Cheap, high-signal, uses Lightdash's existing Slack integration.

## Stakeholder questions to answer before kickoff

1. **(Esther)** What is the canonical Account-name source — Salesforce or Studio API?
2. **(Sales lead)** Is daily score recompute fine, or do we need hourly?
3. **(Eng lead)** Sign-off on the "one-folder-per-package" isolation rule.
4. **(Eng lead)** Sign-off on co-locating the Protopie dbt models in this repo (vs. the data-platform repo).
5. **(Legal/Privacy)** Anything in `notes_summary` of a touchpoint that constitutes PII we shouldn't retain indefinitely? Inform retention policy.
6. **(Security)** Approve OAuth2 + MCP write-tools exposure for external agents.
7. **(Lightdash team)** Will they accept MCP write tools as an upstream PR after we stabilize them? (Not blocking; nice to know.)

## Out of these docs, also undetermined

- Exact dashboard tile layout (Lightdash dashboard editor is the right place to iterate).
- Exact form field labels in Korean (sales is in Korea; should the form labels be Korean or English?).
- Whether to migrate ChurnZero's historical Churn Score values into Postgres for the trend chart (recommend **no** — fresh start).
