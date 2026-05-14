# 14 — Security & Privacy

> What we collect, how we protect it, who can see it, and how long we keep it. Read alongside [13-operational-runbook.md § H — Retention and deletion](./13-operational-runbook.md#h--retention-and-deletion) and Lightdash's existing security best practices in the project `CLAUDE.md`.

## Data classification

| Data | Class | Examples | Stored where |
|------|-------|----------|--------------|
| Account metadata | Operational | `cloud_url`, `team_id`, plan tier | Redshift `dim_team_summary` (existing) |
| Usage events | Operational | Amplitude events keyed by `team_id` | Redshift via Spectrum (existing) |
| Salesforce account context | Operational + PII (owner emails) | CSM owner, MRR, license dates | Redshift (existing) |
| **Sales rep touchpoint notes** | **PII-adjacent** | meeting summary, attendees list, sentiment | Postgres `protopie_form_submissions` (NEW) |
| Score values | Operational | per-Account total/factor scores | Postgres `protopie_churn_score` (NEW) |
| MCP audit log | Audit | tool name, slug, outcome — **no payloads** | Postgres `protopie_mcp_audit_log` (NEW) |
| Form schemas | Configuration | Zod schemas; non-sensitive | Postgres `protopie_form_definitions` (NEW) |
| Scoring config / weights | Configuration | weights, goals, event groups | Postgres `protopie_churn_score_configs` + `_factors` (NEW) |
| dbt source files | Internal source code / analytics logic | models, marts, macros, seeds in `ProtoPie/data-modeling` | Read by MCP from local path or GitHub |
| dbt GitHub PAT | Secret | `PROTOPIE_DBT_GITHUB_TOKEN` | Ignored `.env` locally; ECS environment in dev/prod |

**PII-adjacent** means: not directly identifying ("John Doe lives at X"), but could be linked to a person — e.g., notes naming a customer's individual contact, attendees, or sentiment about a real person. Treat with care; apply retention policy.

## Access control summary

| Subject | What they can see |
|---------|--------------------|
| Authenticated org member | All non-form Protopie data (configs, scores). Form submissions: own + org-wide read; cannot edit others'. |
| Sales contributor / Sales manager | Product roles for the final workflow. Not implemented as separate Lightdash roles in the current POC. |
| Org admin | All of the above + MCP write-tools toggle + MCP audit log + bootstrap dashboards + hard-delete via SQL. |
| Lightdash service account | Whatever is granted via its role + `mcp:read`/`mcp:write` scopes (per [07-mcp-server-extension.md](./07-mcp-server-extension.md)). |
| **MCP write tools (external agent)** | Subject to **three** gates: (1) `mcp:write` OAuth scope, (2) org opt-in, (3) per-call CASL — see [07-mcp-server-extension.md § Permission model](./07-mcp-server-extension.md#permission-model). |
| **MCP dbt read tools (external agent)** | Read-only access to allowlisted paths from `ProtoPie/data-modeling`; token value is never returned. |
| Cross-org users | **Nothing.** All read queries filter by `organization_uuid`. |

See [05-forms-system.md § Permissions matrix](./05-forms-system.md#permissions-matrix-v1--locked) for the full role-by-action grid.

## Audit logging

Three audit streams:

1. **`protopie_form_submissions`** — every row is its own audit record. Soft-delete preserves history. Explicit supersession chains are planned only if sales needs correction history beyond soft-delete/re-submit.
2. **`protopie_churn_score_runs`** — every recompute (scheduler, manual, MCP-triggered) writes a row with `triggered_by`, `triggered_by_user_uuid`, `started_at`, `finished_at`, `status`, `error_message`.
3. **`protopie_mcp_audit_log`** — every MCP write tool call writes a row with `auth_method`, `user_uuid`, `tool_name`, `input_summary` (slugs only, no full payloads), `outcome`, `error_message`. See [07-mcp-server-extension.md § Audit logging](./07-mcp-server-extension.md#audit-logging).

What's NOT audited (intentional):

- **Form submission payloads themselves.** The payload IS the record; auditing it would double-write the same JSONB. If you need "what changed", compare adjacent rows in the supersession chain.
- **Dashboard view counts.** Lightdash core handles analytics; we don't duplicate.

## Retention policy

See [13-operational-runbook.md § H — Retention and deletion](./13-operational-runbook.md#h--retention-and-deletion) for the per-table retention table and the weekly sweep cron.

**Summary:** Form submissions auto-soft-delete after **3 years**. Scores keep **5 years**. Audit logs keep **1 year**. Overrides keep **6 months** past expiry.

Hard delete requires admin SQL and is logged separately.

## Exports & dashboard sharing

| Surface | Default policy |
|---------|----------------|
| Lightdash dashboard CSV / PDF export | **Allowed** for org members. The data already passes through Lightdash's existing export RBAC. |
| Lightdash public link sharing | **Disabled** for the `protopie/sales-ops` space (set at space-creation time via `inheritParentPermissions: false` + no public-share config). Public links can expose Account names + MRR. |
| Embedding (Lightdash embed feature) | **Disabled** for Protopie content in v1. Revisit if a Salesforce-side embed becomes desirable. |
| Slack scheduled deliveries | **Allowed** to internal-only channels. Sales managers set them up; the existing Lightdash scheduler controls access. |

## Masking

Lightdash's existing dbt PII masking macros (`dbt_snow_mask`, integrated into the data-modeling repo) apply automatically when:
- A column is annotated with `meta: { snowmask: 'mask' }` in the dbt YAML.
- The `get_salt()` macro is configured.

For Protopie marts, mark these columns as masked:
- `mart_sales_touchpoints.notes_summary` — mask via `get_salt()` hash for non-admin viewers if and only if sales lead requests it. Default: unmasked for org members.
- `mart_sales_touchpoints.attendees` — same.

Score-related columns are aggregates; no PII; no masking needed.

## Sensitive credential handling

The Lightdash backend never logs:
- Redshift connection strings or passwords.
- OAuth client secrets.
- PAT values (only PAT name + scopes).
- MCP `authInfo.token` values.
- `PROTOPIE_DBT_GITHUB_TOKEN`.

The dbt source MCP tools return file contents only from allowlisted paths. They strip the GitHub token from source metadata before responding. Use a fine-grained GitHub PAT scoped only to `ProtoPie/data-modeling` with Contents read-only and Metadata read-only. Rotate it when people leave the project or when the token is exposed in a terminal, screenshot, issue, Slack thread, or commit.

If Protopie introduces any new auth-bearing field, it **must** be added to `sensitiveCredentialsFieldNames` in `packages/common/src/types/projects.ts` (per Lightdash core's warehouse credentials protection rule — see project `CLAUDE.md`). Validate by `GET /api/v1/projects/{uuid}` and checking the field is omitted from the response.

## Deletion behavior — what soft-delete actually does

When a row is soft-deleted (`deleted_at` set):

1. **Backend reads** filter `WHERE deleted_at IS NULL` — invisible to all users.
2. **dbt mart `mart_sales_touchpoints`** filters out soft-deleted rows in its base CTE.
3. **Existing churn scores tied to the row are NOT recomputed.** Past scores remain as-they-were. This is intentional under the as-was history model — soft-deleting an old touchpoint doesn't rewrite history.
4. **Bottle for forensic / legal review:** the row remains queryable by an admin with direct SQL access (and shows up in JOIN with the supersession chain).

## Cross-environment isolation

Dev, staging, and prod:
- Have separate Postgres databases (existing Lightdash convention).
- Have separate Redshift schemas (`warehouse_staging` vs `warehouse`).
- Form schemas and migrations are deployed in the same order to all three.
- MCP org-opt-in setting (`protopie_organization_settings.mcp_write_tools_enabled`) is per-org per-environment — turning it on in dev does NOT turn it on in prod.

## Threat model (v1)

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|------------|
| Disgruntled sales rep exfiltrates touchpoint notes | Medium | Medium (PII-adjacent) | Org-scoped reads. Dashboard exports require auth. CSV export is logged in Lightdash. |
| Leaked PAT used to mass-create dashboards via MCP | Low | High (resource pollution) | Org opt-in defaults OFF. Audit log surfaces unusual volume. Rate-limit at MCP middleware. |
| Leaked `PROTOPIE_DBT_GITHUB_TOKEN` | Medium | Medium (read access to dbt source) | Fine-grained PAT limited to `ProtoPie/data-modeling`, Contents read-only, Metadata read-only. Keep in ignored `.env`/ECS env only. Rotate immediately if exposed. |
| Bug in `FormService.submit()` lets one org write to another | Low | High | Every insert sets `organization_uuid = user.organizationUuid`. Integration test for cross-org isolation in CI. |
| Score config edited maliciously (sabotage by sales) | Low | Medium (wrong dashboards for a day) | Config versioning audits who/when. Sales lead reviews via the diff in the admin UI. Recompute is reversible by activating prior config. |
| Stale credential in Airflow leaks Postgres data to S3 | Low | Medium | Quarterly rotation; read-only Postgres role. Bucket has restricted IAM access. |
| LLM agent with `mcp:write` creates malicious dashboards | Medium | Medium | Org opt-in defaults OFF. Per-tool CASL checks. Audit log. Slug prefix `protopie-` makes content easy to identify and bulk-revert. |
| Memory `notes_summary` leaked via Slack notification | Low | Medium | Slack notifications include only score deltas, not free-text notes. Configurable. |

## When to consult security

Before:
- Shipping any new field that captures PII (e.g., contact emails, phone numbers) — could trigger GDPR scrutiny.
- Exposing Protopie dashboards via public links / embeds (we currently disable both; reversing requires review).
- Adding a new auth method or external integration that touches OAuth scopes.
- Hard-deleting data (use the procedure in [§ H of the runbook](./13-operational-runbook.md#h--retention-and-deletion)).

## Open items

- Formal data processing agreement update with Salesforce if/when we mirror Salesforce data into Postgres. Today we only read from the warehouse copy.
- Determine whether `notes_summary` ever contains data subject to specific national regulations (Korea PIPA, EU GDPR). Default assumption: yes for GDPR-resident customers. The 3-year retention is the floor; specific customer requests for shorter retention should be honored.
