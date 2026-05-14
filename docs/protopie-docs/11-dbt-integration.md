# 11 — dbt Integration

> The dbt project lives at **`/Users/mamur/Documents/projects/data-modeling`** — a separate git repo from this Lightdash fork. Everything in this doc assumes you're working in that repo, not this one.

## The dbt project at a glance

| Item | Value |
|------|-------|
| Repo path | `/Users/mamur/Documents/projects/data-modeling` |
| dbt project name (in `dbt_project.yml`) | `my_new_project` *(placeholder name; do not rely on it)* |
| Warehouse | **Amazon Redshift** (`prod` database) |
| Target schema (dev) | `warehouse_staging` |
| Target schema (prod) | `warehouse` |
| Threads | 4 |
| dbt version | dbt + Redshift adapter (see `packages.yml` for utilities) |
| Packages | `dbt-labs/dbt_utils` 1.3.0, `entechlog/dbt_snow_mask` 0.2.6, `dbt-labs/codegen` 0.13.0 |
| Profile selector | `default` → target `dev` (from `profiles.yml`, which is `.gitignored`) |
| Env var controlling behavior | `DBT_ENVIRONMENT=dev|prod` |
| CI/CD | Auto-manifest generation; Airflow orchestration based on the manifest |

## MCP visibility into dbt source

The Lightdash MCP extension can read the `ProtoPie/data-modeling` source tree so agents can understand marts, dimensions, macros, seeds, and Lightdash content-as-code before creating or updating dashboards.

This is read-only context for agents. It does **not** replace dbt CI/CD and it does **not** run dbt.

Local development:

```bash
PROTOPIE_DBT_LOCAL_PATH=/Users/mamur/Documents/projects/data-modeling
```

Dev/prod:

```bash
PROTOPIE_DBT_GITHUB_OWNER=ProtoPie
PROTOPIE_DBT_GITHUB_REPO=data-modeling
PROTOPIE_DBT_GITHUB_REF=main
PROTOPIE_DBT_GITHUB_TOKEN=<fine-grained-read-only-pat>
PROTOPIE_DBT_ALLOWED_PATHS=models,marts,macros,seeds,snapshots,analyses,analysis,tests,dbt_project.yml,packages.yml,selectors.yml,exposures.yml,README.md
```

Exposed MCP tools:

- `protopie_dbt_list_files`
- `protopie_dbt_get_file`
- `protopie_dbt_search_files`

Use a fine-grained GitHub PAT scoped only to `ProtoPie/data-modeling` with Metadata read-only and Contents read-only. Store it in ignored `.env` files locally and in the ECS environment for dev/prod; never commit it.

## What's already there (read before adding)

```
models/
├── staging/                 ← 74 models, all materialized=table, tagged 'staging'
│   ├── amplitude/           ← stg_amplitude_protopie_all_events (incremental, partition-pruned via Spectrum)
│   ├── billing/             ← stg_billing_*  (Salesforce/billing facts)
│   ├── cloud/               ← stg_cloud_*   (Cloud product data; has base/ for intermediates)
│   ├── cloud_all/           ← stg_all_*     (cross-source union of cloud + enterprise)
│   ├── enterprise/          ← stg_enterprise_*  (Enterprise product data; has base/)
│   ├── credit/              ← stg_credit_*
│   ├── ai_assistant/        ← stg_ai_assistant_*
│   └── misc/                ← Learnworld + small misc sources
├── intermediate/
│   └── ai_assistant/        ← only existing intermediate folder
└── marts/
    ├── shared/              ← dim_calendar
    └── warehouse/
        ├── billing/daily/         ← 10 models — plan/subscription dimensions + facts
        ├── cloud/daily/           ← 15 models — product analytics dims
        ├── cloud/weekly/          ← 2 fact models
        ├── cloud/monthly/         ← 4 fact models
        ├── credit/daily/
        ├── ai_assistant/daily/
        └── learnworld/daily/
```

**The crucial existing models for Protopie work:**

- `stg_amplitude_protopie_all_events` — all Amplitude events (incremental).
- `dim_product_all_events` — Amplitude + Cloud unified event log (tagged `lightdash`).
- `dim_product_all_event_properties` — event_properties extracted, includes `team_id`, `pie_id`.
- `dim_team_summary` — the Account dim: `team_id` (PK), `namespace`, `url` (cloud_url), `max_seats`, `plan_type`, `plan_id`, dates, seat counts.
- `dim_enterprise_summary` — Enterprise Cloud customers, keyed by `namespace`; has MRR.
- `dim_latest_plan` — current paid plan per user/team (the source of "Pro" vs "Pro Plus Plus" distinction).
- `stg_all_teams`, `stg_all_teams_users`, `stg_all_users` — team/user membership.

Lightdash join metadata (`meta.joins`) is already declared on `dim_product_all_events`, `dim_team_summary`, `dim_enterprise_summary` — meaning when our new `mart_account_usage_90d` joins to those dims, sales gets MRR / plan tier / CSM owner filters for free.

## What we add (Protopie scope)

```
models/
├── staging/protopie_app/                                           ← NEW
│   ├── source.yml                                                  ← declares Lightdash Postgres as source
│   ├── stg_protopie_form_submissions.sql
│   ├── stg_protopie_churn_score_factors.sql                        ← optional, for parity testing
│   ├── stg_protopie_churn_score_configs.sql                        ← optional
│   └── stg_protopie_account_overrides.sql
├── intermediate/protopie/                                          ← NEW
│   └── int_protopie_team_user_event_counts.sql
├── marts/warehouse/protopie/daily/                                 ← NEW
│   ├── _protopie__models.yml                                       ← schema YAML for all protopie marts
│   ├── mart_account_usage_90d.sql
│   ├── mart_churn_score_latest.sql
│   ├── mart_sales_touchpoints.sql
│   └── mart_account_overrides_active.sql
└── seeds/protopie/                                                 ← NEW
    ├── dim_churn_score_event_groups.csv
    └── dim_churn_score_event_groups.yml

lightdash/
├── charts/                                                         ← EXISTS — alongside existing charts
│   ├── protopie-churn-score-gauge.yml                              ← NEW
│   ├── protopie-account-active-users.yml                           ← NEW
│   ├── … (one per chart in the dashboards)
└── dashboards/                                                     ← EXISTS — alongside existing dashboards
    ├── protopie-account-360.yml                                    ← NEW
    └── protopie-churn-score-portfolio.yml                          ← NEW
```

> **Prefix everything `protopie_` or `protopie-`.** Reuses the existing project's conventions and makes Protopie content trivially identifiable.

## Wiring it into `dbt_project.yml`

Append (don't replace) these blocks to the existing `dbt_project.yml`:

```yaml
# dbt_project.yml — additions
models:
  my_new_project:
    intermediate:
      protopie:
        +materialized: table
        +tags: ['protopie', 'intermediate']
    marts:
      warehouse:
        protopie:
          +materialized: table
          +tags: ['protopie', 'lightdash']     # 'lightdash' tag means surfaced in Lightdash explores
          daily:
            +materialized: table
    staging:
      protopie_app:
        +materialized: view                    # view, not table — these are thin passthroughs over Postgres
        +tags: ['protopie', 'stg_protopie_app']

seeds:
  my_new_project:
    protopie:
      +schema: protopie                        # land seeds in a dedicated schema for clarity
```

> Decision: **staging models over Postgres are `view`** (not `table`). Tables would require materializing every row from the operational DB into the warehouse — wasteful and stale. Views over the Postgres-as-source FDW (or `dblink`, or Spectrum, depending on what's available) keep Lightdash forms surfaced in dbt without expensive copies. If view performance becomes a problem, switch to incremental tables later.

## Declaring the Lightdash app DB as a source

```yaml
# models/staging/protopie_app/source.yml
version: 2
sources:
  - name: protopie_lightdash_app
    description: >
      The Lightdash application Postgres database (forks/protopie). Contains
      operational data: form submissions, churn-score config, run history.
    database: prod                              # if Redshift can reach the Postgres via FDW
    schema: lightdash_protopie                   # the FDW-mapped schema name in Redshift
    tables:
      - name: protopie_form_submissions
        description: "Sales-rep form submissions"
        columns:
          - name: form_submission_uuid
            tests: [unique, not_null]
          - name: form_key
          - name: account_key
            description: "Extracted from payload; canonical account_key"
          - name: cloud_url
          - name: salesforce_account_id
          - name: payload
            description: "Raw JSONB payload"
          - name: created_at
          - name: deleted_at
      - name: protopie_form_definitions
      - name: protopie_organization_settings
      - name: protopie_mcp_audit_log
      - name: protopie_churn_score_configs
      - name: protopie_churn_score_factors
      - name: protopie_churn_score
        description: "Computed daily churn score per team"
      - name: protopie_account_overrides
```

## App DB → Redshift ingestion (concrete plan)

The Lightdash app Postgres tables (`protopie_form_submissions`, `protopie_churn_score`, etc.) must reach Redshift so dbt can model them. Three options, with a clear recommendation:

### Option compared

| Option | How it works | Pros | Cons | Operational fit |
|--------|-------------|------|------|-----------------|
| **A. Federated query** (Redshift `CREATE EXTERNAL SCHEMA … FROM POSTGRES …`) | Redshift queries Postgres live via the federated-query feature. dbt sees the tables natively. | Always fresh. No copy job. Zero ETL. | Every query hits Postgres — bad if dashboards refresh aggressively. Requires Postgres to be in the same VPC and have credentials issued to Redshift's IAM role. Postgres becomes a query target for analytical load. | Best **only** for small reference tables. Risky for `protopie_form_submissions` if submissions count grows. |
| **B. Airflow dump/load** (existing Airflow installs already running for the data-modeling repo's manifest) | A scheduled DAG runs `pg_dump`/`COPY` into S3, then `COPY INTO Redshift` lands rows in `protopie_app_raw.*`. | Reuses existing ops infra. Simple. Backfill = one DAG run. Predictable. Cheap. | Latency = DAG cadence (recommend hourly for forms, daily for churn scores). Schema drift requires DAG updates. | **Recommended for v1.** |
| **C. AWS DMS continuous replication** | CDC stream from Postgres WAL into Redshift. | Near-real-time (~minutes). | Heavyweight to set up. Ongoing IAM, replication-task monitoring, DDL change handling. Overkill for our latency requirements. | Defer to v1.1 if real-time becomes a requirement. |

### Recommended v1: Option B (Airflow hourly dump/load)

**Source of truth for connection details.** The Lightdash Postgres RDS endpoint is provisioned in `infra/{dev,prod}/rds.tf` in this Lightdash repo (module `lightdash_db`). Expose it via a Terraform output (`output "lightdash_db_endpoint" { value = module.lightdash_db.db_instance_endpoint }`) and reference from the Airflow connection — don't hard-code. The read-only Postgres role used by Airflow is documented in [15-deployment.md § Network access for the Airflow DAG](./15-deployment.md#network-access-for-the-airflow-dag), along with the required security-group ingress rule on `aws_security_group.database_sg`.

**Ownership.** Data-engineering team owns the Airflow DAG. The Protopie backend team owns the schema of `protopie_*` tables; any schema change requires coordinating a matching DAG update.

**Cadence:**
- `protopie_form_submissions` → hourly (sales would notice longer staleness).
- `protopie_churn_score`, `protopie_churn_score_runs` → 6× daily (the nightly recompute writes once at ~02:00 UTC, plus catch any ad-hoc admin recomputes).
- `protopie_churn_score_configs`, `protopie_churn_score_factors`, `protopie_account_overrides`, `protopie_form_definitions` → daily (low change rate).

**Schema mapping.** All Postgres tables land in a Redshift schema named `protopie_app_raw`. The dbt staging models (in `models/staging/protopie_app/`) read from `source('protopie_app_raw', '<table>')` and create views in `warehouse_staging.stg_protopie_app__*`.

**Backfill.** Initial backfill = one DAG run with `--full-refresh=true`. Future backfills = re-run the DAG for the affected date range. Idempotent: each load uses `TRUNCATE + INSERT` because table sizes are small (well under 1M rows per Protopie table — even after 5 years of sales activity).

**Secrets.**
- Postgres read credentials live in Airflow's connection store (`Variable.get('lightdash_postgres_creds')`). The credentials are read-only on the Protopie tables — never write to the app DB from Airflow.
- Redshift write credentials are issued via the existing data-modeling IAM role.
- Rotation: quarterly. Documented in the operational runbook ([13-operational-runbook.md](./13-operational-runbook.md)).

**Failure handling.**
- DAG retries 3× with exponential backoff (60s → 5m → 30m).
- After 3 failures, PagerDuty alert routed to `#data-platform` Slack channel.
- The Protopie backend writes a metric `protopie_app_redshift_staleness_seconds = NOW() - max(created_at_seen_in_redshift)` to Lightdash analytics. A simple Lightdash dashboard alarms if staleness > 4× expected cadence.
- The nightly churn recompute reads its own data from Postgres directly (not Redshift) so a stale Redshift does NOT block scoring — it only affects dashboards.

**DDL changes.** Any schema migration in this fork that touches a `protopie_*` table requires a coordinated update to the Airflow DAG. Process documented in [13-operational-runbook.md](./13-operational-runbook.md). Until the DAG ships the update, the new column is missing from Redshift but no data is lost — the next run picks it up.

### The dbt source declaration is option-agnostic

The dbt source YAML stays the same regardless of which ingestion option underlies it — `source('protopie_app_raw', 'protopie_form_submissions')` resolves to the right Redshift schema/table whether populated by Airflow load (B) or federated query (A). If a future migration to DMS happens, the dbt models don't change.

## A representative new mart with full Lightdash `meta`

```sql
-- models/marts/warehouse/protopie/daily/mart_churn_score_latest.sql
{{ config(
    materialized='table',
    tags=['protopie', 'lightdash'],
    meta={
        "label": "[Protopie] Latest Churn Score",
        "description": "Most recent churn score per team. Powers the Account 360 and Portfolio dashboards.",
        "joins": [
            {
                "join": "dim_team_summary",
                "label": "Team Summary",
                "sql_on": "${mart_churn_score_latest.team_id} = ${dim_team_summary.team_id}"
            },
            {
                "join": "dim_enterprise_summary",
                "label": "Enterprise Summary",
                "sql_on": "${dim_team_summary.namespace} = ${dim_enterprise_summary.namespace}"
            },
            {
                "join": "dim_latest_plan",
                "label": "Latest Plan",
                "sql_on": "${dim_latest_plan.team_id} = ${mart_churn_score_latest.team_id}"
            },
            {
                "join": "mart_account_usage_90d",
                "label": "Account Usage (90d)",
                "sql_on": "${mart_account_usage_90d.team_id} = ${mart_churn_score_latest.team_id}"
            }
        ],
        "metrics": {
            "average_score": {"sql": "${TABLE}.total_score", "type": "average"},
            "at_risk_count": {
                "sql": "${TABLE}.team_id", "type": "count_distinct",
                "filters": [{"risk_band": "high"}]
            }
        }
    }
) }}
with latest as (
    select
        s.*,
        row_number() over (partition by s.team_id order by s.scored_for_date desc) as rn
    from {{ source('protopie_lightdash_app', 'protopie_churn_score') }} s
)
select
    team_id,
    salesforce_account_id,
    cloud_url,
    total_score,
    max_score,
    score_percent,
    risk_band,
    scored_for_date,
    factor_scores,
    config_uuid,
    config_version
from latest
where rn = 1
```

This single file exposes the score table to Lightdash with rich joins — sales filters by Account name, plan tier, MRR, CSM owner with no extra YAML.

## A representative new chart YAML

```yaml
# lightdash/charts/protopie-churn-score-gauge.yml
name: Protopie — Churn Score (current)
description: "Latest churn score for the selected Account."
tableName: mart_churn_score_latest
slug: protopie-churn-score-gauge
spaceSlug: protopie/sales-ops
version: 1
metricQuery:
  exploreName: mart_churn_score_latest
  dimensions: [mart_churn_score_latest_team_id]
  metrics: [mart_churn_score_latest_average_score]
  filters: {}
  sorts: []
  limit: 1
  tableCalculations: []
  additionalMetrics: []
  customDimensions: []
chartConfig:
  type: big_number
  config:
    label: "Churn Score"
tableConfig:
  columnOrder: [mart_churn_score_latest_average_score]
dashboardUuid: null
```

This file is checked into `data-modeling/lightdash/charts/` alongside the existing chart YAMLs. The Lightdash bootstrap endpoint (see [06-dashboards.md](./06-dashboards.md)) reads this directory and upserts via `CoderService`.

## Naming conventions Protopie must follow

Match the existing repo's conventions exactly — anything else looks foreign in code review:

| Kind | Pattern | Example |
|------|---------|---------|
| Source | `stg_<schema>_<entity>.sql` | `stg_protopie_app_form_submissions.sql` |
| Cross-source staging | `stg_all_<entity>.sql` | *(not used by Protopie)* |
| Base intermediate | `base_<source>_<entity>.sql` | *(only used if a multi-step pipeline emerges)* |
| Dimension | `dim_<entity>.sql` | `dim_churn_score_event_groups.sql` (the seed) |
| Fact | `fct_<entity>_<grain>.sql` | *(none for v1; the score is a daily snapshot, not a fact)* |
| Mart | `mart_<purpose>.sql` | `mart_account_usage_90d.sql` |

Tags: every Protopie model gets `tags: ['protopie', …]`, and any mart surfaced in Lightdash also gets `'lightdash'`.

## dbt commands for Protopie work

```bash
# in /Users/mamur/Documents/projects/data-modeling
cd /Users/mamur/Documents/projects/data-modeling

# run only protopie models
dbt run --select tag:protopie

# run the daily marts (what the Lightdash backend depends on)
dbt run --select tag:protopie,tag:lightdash

# run a single model and downstream
dbt run --select mart_account_usage_90d+

# seed the event-group dim and test
dbt seed --select protopie
dbt test --select tag:protopie

# build everything cleanly
dbt build --select +marts.warehouse.protopie
```

Air-gapped Airflow consumers should target `tag:protopie` so the new pipeline runs nightly without changing the existing DAG.

## Test coverage we expect to land with v1

- **`stg_protopie_app__*`**: `unique` + `not_null` on PK columns.
- **`int_protopie_team_user_event_counts`**: `not_null(team_id, user_id, event_name)`.
- **`mart_account_usage_90d`**: `unique(team_id)`, `not_null(team_id, total_users)`.
- **`mart_churn_score_latest`**: `unique(team_id)`, `not_null(total_score, risk_band)`, `accepted_values(risk_band, [low, medium, high])`.
- **`dim_churn_score_event_groups` seed**: `unique_combination_of_columns(factor_key, event_name)`, `accepted_values(factor_key, [<known factor keys>])`.
- **Parity test** (custom): `event_group.events[]` array in `protopie_churn_score_factors` Postgres rows matches the `event_name` set in the dbt seed. **Fails CI if drift.**

## Performance considerations

- Redshift performs best with `dist_key` on join columns and `sort_key` on time columns. Add:
  ```sql
  {{ config(dist='team_id', sort='scored_for_date') }}
  ```
  on `mart_churn_score_latest` and similar.
- `dim_product_all_events` is already incremental (good — we don't re-scan all Amplitude events on every dbt run). Our intermediate must read from it, not from raw Amplitude.
- `int_protopie_team_user_event_counts` is a `table` (not incremental) for v1 since the 90-day window is small. Switch to incremental if the model run-time exceeds 5 minutes.

## What we do NOT do

- We don't add new packages to `packages.yml` unless absolutely necessary. Adding a package triggers `dbt deps` for every CI run.
- We don't change the existing `dbt_project.yml` defaults (`max_id: 100`, `max_value: 255`) — Protopie models cast strings the same way: `::varchar({{ var('max_id') }})`.
- We don't modify any existing model. Protopie additions are strictly **new** files.
- We don't introduce a different materialization (no `view`/`incremental`) for marts. Everything is `materialized='table'` to match the project's house style.

## Security flag — `profiles.yml`

The repo's `profiles.yml` contains a Redshift password in plaintext but is `.gitignored`. Don't paste the file into any other repo, don't share it in Slack screenshots, and prefer reading the credential from `~/.dbt/profiles.yml` (the dbt default location) instead of the repo copy.

## Open dbt questions

See [10-open-questions.md](./10-open-questions.md) for the full list. dbt-specific ones:

- Federated query vs DMS vs periodic dump for the Lightdash Postgres → Redshift bridge. Default recommendation: **periodic dump via Airflow**, hourly.
- Should the dbt project name `my_new_project` be renamed to something meaningful (e.g., `protopie_dwh`)? Cosmetic; only matters for log messages.
- Should the seed `dim_churn_score_event_groups` live under `seeds/protopie/` (proposed) or `models/marts/warehouse/protopie/`? Convention says seeds live in `seeds/`.
