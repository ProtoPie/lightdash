# 13 — Operational Runbook

> Procedures for keeping the Protopie module healthy in production. Every section answers a single "what do I do when X happens" question. Print and pin in `#protopie-data-ops` Slack.

## Quick reference

| Symptom | Section |
|---------|---------|
| Nightly churn recompute didn't run / failed | [§ A — Failed recompute](#a--failed-nightly-recompute) |
| One Account has wildly wrong score | [§ B — Score anomaly](#b--score-anomaly-on-one-account) |
| Form submissions not showing up in dbt mart | [§ C — App DB → Redshift stale](#c--app-db--redshift-staleness) |
| Dashboard tile broken after bootstrap | [§ D — Dashboard rollback](#d--dashboard-rollback) |
| MCP tool returning 403 | [§ E — MCP write tool denied](#e--mcp-write-tool-denied) |
| MCP cannot read dbt files | [§ E2 — MCP dbt source access denied or empty](#e2--mcp-dbt-source-access-denied-or-empty) |
| Need to pause all updates (red flag) | [§ F — Emergency pause](#f--emergency-pause-protopie) |
| Cutover day procedures | [§ G — Cutover monitoring](#g--cutover-monitoring) |
| Retention sweep / GDPR purge | [§ H — Retention and deletion](#h--retention-and-deletion) |
| Credential rotation | [§ I — Credential rotation](#i--credential-rotation) |
| Bad image deployed via ECS | See [15-deployment.md § Rollback](./15-deployment.md#rollback) |
| ECS task crashes / health check failing | See [15-deployment.md § Health checks & observability](./15-deployment.md#health-checks--observability) |

---

## A — Failed nightly recompute

**Signal:** PagerDuty / Slack alert from Lightdash scheduler. `protopie_churn_score_runs.status = 'failed'` for the latest run.

**Triage (≤5 min):**

```bash
# 1. Find the failed run
psql -c "SELECT run_uuid, started_at, error_message FROM protopie_churn_score_runs
         WHERE status='failed' ORDER BY started_at DESC LIMIT 5;"

# 2. Check Graphile Worker job state
psql -c "SELECT id, task_identifier, last_error, attempts FROM graphile_worker.jobs
         WHERE task_identifier='protopie.recomputeChurnScore' AND last_error IS NOT NULL
         ORDER BY id DESC LIMIT 5;"

# 3. Check Sentry — search by tag module=protopie + transaction=recomputeChurnScore
```

**Common causes:**

| Cause | Symptom | Fix |
|-------|---------|-----|
| Warehouse client timeout (Redshift busy) | error_message contains "query timeout" or "connection reset" | Re-trigger: `POST /api/v1/protopie/churn/recompute`. If repeats, escalate to data-eng. |
| Active config missing | error_message contains "no active config" | `psql -c "SELECT * FROM protopie_churn_score_configs WHERE status='active'"` — if 0 rows, manually activate the latest version. |
| Mart `mart_account_usage_90d` empty | Run completes with `accounts_scored = 0` | dbt failure upstream. Check `cd /Users/mamur/Documents/projects/data-modeling && dbt build --select +mart_account_usage_90d` for errors. |
| Migration / schema drift | error_message references a missing column | Check that latest migration ran: `pnpm -F backend migrate:list`. Run pending migration. |

**Re-run after fix:**

```bash
curl -X POST -H "Authorization: ApiKey $LDPAT" \
  "$SITE_URL/api/v1/projects/$PROJECT_UUID/protopie/churn/recompute"
```

**Escalate** (after 3 failed retries) to: `#data-platform` channel + page on-call eng.

---

## B — Score anomaly on one Account

**Signal:** Sales rep says "Account X has score 12 but they're a healthy customer" (or vice versa).

**Diagnose (≤10 min):**

```sql
-- 1. Pull the latest score breakdown
SELECT total_score, score_percent, risk_band, factor_scores
FROM protopie_churn_score
WHERE account_key = '<team_id>'
ORDER BY scored_for_date DESC LIMIT 1;

-- 2. Check the inputs — does mart_account_usage_90d say what you expect?
-- Run from a Lightdash SQL runner or psql against Redshift:
SELECT * FROM warehouse_staging.mart_account_usage_90d
WHERE team_id = '<team_id>';

-- 3. Is there an active override?
SELECT * FROM protopie_account_overrides
WHERE account_key = '<team_id>'
  AND (valid_until IS NULL OR valid_until > NOW())
ORDER BY created_at DESC;
```

**Common causes:**

| Cause | Fix |
|-------|-----|
| Override is suppressing the score | Remove or expire the override row. Re-run scoring for just this Account: `POST /api/v1/protopie/churn/recompute --data '{"accountKeys":["<team_id>"]}'`. |
| Events not attributed to this team_id | Run the account-bridge validation query 3 from [04-churn-score-engine.md § Validation queries](./04-churn-score-engine.md#validation-queries-run-before-declaring-v1-done). If > 30% events have no team_id, raise with data-eng. |
| Event group missing this Account's event names | Inspect `dim_churn_score_event_groups` seed — did sales add a new event type without updating it? |
| Account is too new (< 90 days of data) | Expected. Document in dashboard tile description: "scores for Accounts younger than 90 days are partial." |

---

## C — App DB → Redshift staleness

**Signal:** Lightdash freshness alarm: `protopie_app_redshift_staleness_seconds > 4× cadence`. Or sales reports: "I submitted a touchpoint 3 hours ago but it's not on the dashboard."

**Triage:**

```bash
# 1. Is the Airflow DAG running?
# Check Airflow UI → DAG `protopie_postgres_to_redshift` → recent runs

# 2. Latest submission in Postgres vs Redshift
psql -h <lightdash-app-db> -c "SELECT MAX(created_at) FROM protopie_form_submissions;"
# Then in Redshift via SQL runner:
SELECT MAX(created_at) FROM protopie_app_raw.protopie_form_submissions;
# Gap > 4× cadence (cadence is hourly for forms) is the alarm threshold.
```

**Fix:**

1. **DAG failing:** Click "Retry" in Airflow. If credentials are the problem, see [§ I — Credential rotation](#i--credential-rotation).
2. **DAG running but slow:** Likely Redshift COPY contention. Check Redshift query queue. Wait it out unless persistent.
3. **DAG paused intentionally:** Resume in Airflow.

**Mitigation while you wait:** Dashboards that read directly from Postgres (`protopie_churn_score` via the backend API, not via dbt) are unaffected. So Account 360's score tile is fresh; only the touchpoint history tile lags.

---

## D — Dashboard rollback

**Signal:** A bootstrap run overwrote a dashboard incorrectly, or sales reports broken tiles after a recent bootstrap.

**Recover (in order of preference):**

1. **Re-bootstrap from a prior YAML commit.** Most cases.
   ```bash
   cd /Users/mamur/Documents/projects/data-modeling
   git log -- lightdash/dashboards/protopie-account-360.yml
   git checkout <good-commit> -- lightdash/dashboards/protopie-account-360.yml
   # Deploy the data-modeling repo, then call bootstrap with the reverted YAML
   curl -X POST -H "Authorization: ApiKey $LDPAT" \
     "$SITE_URL/api/v1/projects/$PROJECT_UUID/protopie/churn/dashboards/bootstrap"
   ```

2. **Revert in Lightdash UI.** Lightdash supports dashboard version revert. **But:** the next bootstrap will re-overwrite. Only use this if you also intend to (a) update YAML to match or (b) skip the next bootstrap.

3. **Inspect the audit log:**
   ```sql
   SELECT triggered_by_user_uuid, created_at, changes, yaml_source_ref
   FROM protopie_dashboard_bootstrap_runs
   ORDER BY created_at DESC LIMIT 5;
   ```
   The `yaml_source_ref` should be a git SHA in the data-modeling repo.

---

## E — MCP write tool denied

**Signal:** Agent reports `ForbiddenError: …` from an MCP tool call.

**Decision tree:**

```
ForbiddenError message says…
├─ "requires the `mcp:write` OAuth scope"
│     → The token doesn't have mcp:write.
│       OAuth: re-authorize with the scope.
│       PAT/service account: ensure `protopie_organization_settings.mcp_write_tools_enabled = true`.
├─ "MCP write tools are disabled for this organization"
│     → Org admin must toggle on at Settings → Organization settings → Integrations → Protopie MCP
│       URL: /generalSettings/integrations.
├─ "Insufficient permission" / CASL error
│     → User lacks manage:ContentAsCode / create:Space.
│       Check user's role; only admins/editors get manage:ContentAsCode.
└─ Other
   → Search `protopie_mcp_audit_log` for the call:
     SELECT * FROM protopie_mcp_audit_log WHERE outcome='forbidden' ORDER BY created_at DESC LIMIT 10;
```

---

## E2 — MCP dbt source access denied or empty

**Signal:** Agent reports `protopie_dbt_list_files`, `protopie_dbt_get_file`, or `protopie_dbt_search_files` returned an empty result, 403, 404, or "outside the allowed dbt repository paths."

**Decision tree:**

```
Symptom says…
├─ "outside the allowed dbt repository paths"
│     → The requested path is not in PROTOPIE_DBT_ALLOWED_PATHS.
│       Use an allowlisted path such as models/, marts/, macros/, seeds/, dbt_project.yml, packages.yml.
├─ GitHub 401/403
│     → PROTOPIE_DBT_GITHUB_TOKEN is missing, expired, or lacks repo access.
│       Use a fine-grained read-only PAT for ProtoPie/data-modeling with Contents read-only and Metadata read-only.
├─ GitHub 404
│     → Check PROTOPIE_DBT_GITHUB_OWNER, PROTOPIE_DBT_GITHUB_REPO, PROTOPIE_DBT_GITHUB_REF, and the requested path.
├─ Empty list in dev/prod
│     → Confirm the ECS task definition includes PROTOPIE_DBT_GITHUB_* env vars and the task has been redeployed.
└─ Empty list locally
      → Confirm PROTOPIE_DBT_LOCAL_PATH points to /Users/mamur/Documents/projects/data-modeling and the repo exists on disk.
```

The dbt MCP tools are read-only. They do not run dbt, write GitHub files, or change warehouse state.

---

## F — Emergency pause (Protopie)

**Trigger conditions:**

- Data breach suspected involving sales touchpoint notes.
- Score recompute writing wildly wrong values for >10% of Accounts.
- Bootstrap run mangled dashboards across multiple projects.

**Steps:**

1. **Stop the scheduler task:**
   ```sql
   -- Permanently delete pending recompute jobs (re-enqueued on next cron unless we also flip env)
   DELETE FROM graphile_worker.jobs WHERE task_identifier = 'protopie.recomputeChurnScore';
   ```

2. **Disable MCP if the emergency is MCP-specific:**
   ```bash
   # in infra/{prod,dev}/.env:
   MCP_ENABLED=false
   # then redeploy via Terraform.
   # This disables the MCP server surface for that environment.
   ```

3. **Disable MCP write tools for the org:**
   ```sql
   UPDATE protopie_organization_settings
   SET mcp_write_tools_enabled = false
   WHERE organization_uuid = '<uuid>';
   ```

4. **For non-MCP emergencies, pause at the narrowest layer.** Stop scheduler jobs, block affected UI routes via role/permission changes, or temporarily remove the affected nav entry. A single global `PROTOPIE_ENABLED` kill switch is not implemented yet.

5. **Communicate.** Post in `#protopie-data-ops` + `#sales`: "Protopie module paused for [reason]. Existing data preserved. ETA on resumption: …"

6. **Do NOT drop tables.** Pausing ≠ kill-switch. Tables stay in place for forensic analysis. The full kill-switch (drop tables + revert touch points) is a separate, deliberate decision documented in [02-isolation-strategy.md](./02-isolation-strategy.md#self-test-can-we-delete-the-fork-in-10-minutes).

---

## G — Cutover monitoring

The day before ChurnZero shutdown (~2026-07-29):

| Check | Command / where to look | Pass criterion |
|-------|--------------------------|----------------|
| Last successful nightly recompute | `psql -c "SELECT MAX(finished_at) FROM protopie_churn_score_runs WHERE status='completed'"` | < 24h ago |
| All active configs have factors | `psql -c "SELECT c.config_uuid, COUNT(f.factor_uuid) FROM protopie_churn_score_configs c LEFT JOIN protopie_churn_score_factors f ON c.config_uuid=f.config_uuid WHERE c.status='active' GROUP BY 1"` | every count > 0 |
| Dashboards render for top-30 at-risk | Manual UI check | every tile renders |
| Reconciliation passes (top-30 score diff ≤ 10pt) | See [12-acceptance-matrix.md § C1](./12-acceptance-matrix.md) | ✓ |
| Sales playbook updated | Internal Notion | ✓ |
| Email announcement scheduled | Comms doc | ✓ |

Cutover day (2026-07-30):

| Hour | Action |
|------|--------|
| T-1h | Final reconciliation snapshot (CZ vs Lightdash). Archive. |
| T0   | Announcement email. ChurnZero set to read-only. |
| T+24h | Spot-check sales UX: 3 reps log a touchpoint, see it on dashboard. |
| T+72h | If no issues, cancel CZ subscription. |
| T+1w  | Retro. Document anything that surprised us. |

---

## H — Retention and deletion

### Default retention policy

| Data | Retention | Rationale |
|------|-----------|-----------|
| `protopie_form_submissions` | **3 years** (then soft-delete via cron) | Sales notes are operational, not legally required long-term. Most analysis windows are 12–24 months. |
| `protopie_form_submissions.payload` (the JSONB) | Same | The payload may contain meeting attendees / notes — treat as PII-adjacent. Don't keep longer than needed. |
| `protopie_churn_score` | **5 years** | Pure aggregates; low PII risk; useful for long-range trend studies. |
| `protopie_churn_score_runs` | **2 years** | Audit only; rarely consulted after 6 months. |
| `protopie_mcp_audit_log` | **1 year** | Security audit; longer is overkill for tool-call records that don't contain payloads. |
| `protopie_dashboard_bootstrap_runs` | **2 years** | Same logic — audit. |
| `protopie_account_overrides` | **Indefinite** while active; **6 months** after `valid_until` | Active overrides explain current scores; expired ones aren't load-bearing. |

A cron task `protopie.retentionSweep` runs weekly (Sundays 03:00 UTC) and soft-deletes (sets `deleted_at`) rows past the retention horizon. **Soft delete only** — hard delete requires manual admin SQL (see below).

### GDPR-style hard delete (a specific user requests removal)

```sql
-- Identify the submissions tied to a user
SELECT form_submission_uuid FROM protopie_form_submissions WHERE created_by_user_uuid = '<user_uuid>';

-- After legal sign-off, hard-delete in a transaction
BEGIN;
DELETE FROM protopie_form_submissions WHERE created_by_user_uuid = '<user_uuid>';
-- Also wipe from the Redshift mirror — coordinate with data-eng to skip CDC for this user
COMMIT;
```

Document every hard delete in a separate audit table `protopie_hard_delete_log` (run book skill — table left as exercise for data-eng since it's outside Protopie's normal write path).

---

## I — Credential rotation

Quarterly cadence. Owners listed.

| Credential | Owner | Storage | Rotation procedure |
|------------|-------|---------|--------------------|
| Redshift connection (in Lightdash backend) | Data-eng | Env / secret manager | Issue new password; update secret store; restart backend. Test churn recompute completes. |
| Lightdash app Postgres → Airflow read user | Data-eng | Airflow connection store | Create new role; update connection; expire old role after 1 successful DAG run. |
| Airflow → Redshift IAM role | Data-eng | AWS IAM | Standard IAM rotation. |
| OAuth client secrets for external MCP agents | Org admin | OAuth client registration | Re-register; deprecate old client after agents migrate. |
| PATs for ops scripts | Each owner | 1Password (or equivalent) | `lightdash pat rotate <name>`; update consumers; revoke old. |

After every rotation, spot-check: log a test touchpoint, verify it lands in Redshift via Airflow ≤ 65 minutes later.

## Contact

- **Backend issues:** `#protopie-eng`
- **Data pipeline issues:** `#data-platform`
- **Sales-side questions:** `#protopie-data-ops`
- **Security incident:** `#security` + page on-call security
