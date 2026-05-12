# 03 — Data Model

> All Protopie-owned Postgres tables are prefixed `protopie_`. Migrations live in `packages/backend/src/protopie/database/migrations/` and follow Lightdash's existing timestamp naming (`YYYYMMDDHHmmss_description.ts`).

## Tables overview

| # | Table | Purpose | Owner |
|---|-------|---------|-------|
| 1 | `protopie_form_definitions` | Form metadata + JSON schema definition. Versioned. | Backend |
| 2 | `protopie_form_submissions` | Every row a sales rep submits via a form. JSONB payload + extracted join columns. | Backend |
| 3 | `protopie_churn_score_configs` | A score configuration (name, lookback, function, effective dates). | Backend |
| 4 | `protopie_churn_score_factors` | The N factors that make up a score config. One row per factor. | Backend |
| 5 | `protopie_churn_score` | Daily score per Account. Total score row. | Backend |
| 6 | `protopie_churn_score_factor_results` | Per-factor breakdown per Account per scored date. *(Optional — can be derived from JSONB in `protopie_churn_score`. Materialize if dashboards need to filter/aggregate by factor.)* | Backend |
| 7 | `protopie_churn_score_runs` | Audit log: when scores were computed, how long, what config version. | Backend |
| 8 | `protopie_account_overrides` | Manual overrides (e.g. force red/green for an Account). | Backend |

### The Account key

In the data-modeling warehouse, "Account" maps to **a team in `dim_team_summary`**. That dim is keyed by:

- `team_id` — opaque PK (the canonical join key on the warehouse side).
- `namespace` — human-readable identifier, the join key into `dim_enterprise_summary`.
- `url` — the tenant URL string the Notion brief calls "cloud_url".

For v1 the primary `account_key` column on Protopie tables is **`team_id`** — it's the actual PK in the warehouse, stable across Cloud and Enterprise. We also persist three nullable secondary identifiers extracted from every Account-scoped row so that joins can use whichever fits:

- `namespace` — for joining into `dim_enterprise_summary`.
- `cloud_url` — for matching against Amplitude `event_properties->>'cloud_url'` and for sales-friendly URLs in dashboards.
- `salesforce_account_id` — for future Salesforce join (currently nullable; populated when known).

This lets dbt joins target whichever identifier is available without descending into JSONB. `team_id` is the contract.

> The Notion brief refers to Accounts by `cloud_url`. That value is the human-friendly label and stays on the dashboards; the *database key* underneath is `team_id`. Sales never sees `team_id`.

## DDL — table-by-table

### `protopie_form_definitions`

```sql
CREATE TABLE protopie_form_definitions (
    form_uuid               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid            UUID NOT NULL REFERENCES projects(project_uuid) ON DELETE CASCADE,
    space_uuid              UUID REFERENCES spaces(space_uuid) ON DELETE SET NULL,
    form_key                VARCHAR(120) NOT NULL,           -- e.g. 'account_touchpoint'
    title                   VARCHAR(255) NOT NULL,
    description             TEXT,
    schema_version          INTEGER NOT NULL DEFAULT 1,
    schema                  JSONB NOT NULL,                  -- full form schema (fields, account_key_field, validators)
    status                  VARCHAR(20) NOT NULL DEFAULT 'active',  -- 'draft' | 'active' | 'archived'
    created_by_user_uuid    UUID NOT NULL REFERENCES users(user_uuid) ON DELETE RESTRICT,
    updated_by_user_uuid    UUID NOT NULL REFERENCES users(user_uuid) ON DELETE RESTRICT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at              TIMESTAMPTZ,

    UNIQUE (project_uuid, form_key, schema_version)
);
CREATE INDEX protopie_form_definitions_active_idx
    ON protopie_form_definitions (project_uuid, form_key) WHERE deleted_at IS NULL AND status = 'active';
```

The `schema` JSONB encodes the same shape Zod produces for code-defined forms (see [05-forms-system.md](./05-forms-system.md)), including a required top-level `account_key_field` pointer that names the field whose value becomes the row's `account_key`.

> **v1 decision: forms are code-defined**, *and* their definitions are mirrored into this table on backend startup (a sync step). The DB row is a read-mostly cache that lets dbt and DB tooling discover what forms exist. Adding a new form is still a code change; DB-defined editing comes in v1.1. The mirror lives in `protopie_form_definitions` so that submissions always have a foreign key target with a known schema version.

### `protopie_form_submissions`

```sql
CREATE TABLE protopie_form_submissions (
    submission_uuid         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid            UUID NOT NULL REFERENCES projects(project_uuid) ON DELETE CASCADE,
    form_uuid               UUID NOT NULL REFERENCES protopie_form_definitions(form_uuid) ON DELETE RESTRICT,
    form_key                VARCHAR(120) NOT NULL,           -- denormalized for cheap dbt reads
    schema_version          INTEGER NOT NULL,                -- which schema version validated this row
    submitted_by_user_uuid  UUID NOT NULL REFERENCES users(user_uuid) ON DELETE RESTRICT,
    organization_uuid       UUID NOT NULL REFERENCES organizations(organization_uuid) ON DELETE CASCADE,
    account_key             VARCHAR(255),                    -- extracted from payload via schema.account_key_field
    salesforce_account_id   VARCHAR(255),                    -- extracted secondary identifier
    cloud_url               VARCHAR(255),                    -- extracted secondary identifier
    payload                 JSONB NOT NULL,                  -- full validated payload
    supersedes_submission_uuid UUID REFERENCES protopie_form_submissions(submission_uuid) ON DELETE SET NULL,
    submitted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at              TIMESTAMPTZ,                     -- soft delete
    notes                   TEXT
);
CREATE INDEX protopie_form_submissions_form_idx
    ON protopie_form_submissions (form_key, submitted_at DESC);
CREATE INDEX protopie_form_submissions_account_idx
    ON protopie_form_submissions (account_key) WHERE deleted_at IS NULL;
CREATE INDEX protopie_form_submissions_project_idx
    ON protopie_form_submissions (project_uuid, submitted_at DESC);
CREATE INDEX protopie_form_submissions_supersedes_idx
    ON protopie_form_submissions (supersedes_submission_uuid) WHERE supersedes_submission_uuid IS NOT NULL;
```

**Why JSONB + extracted columns.** The full payload lives in JSONB for auditability; the join keys (`account_key`, `salesforce_account_id`, `cloud_url`) are extracted into typed columns so dbt joins don't require JSON path expressions on every model. Backend's `FormService.submit()` is responsible for extracting them from `payload` using the form's `account_key_field` config.

**Why `supersedes_submission_uuid`.** Sales sometimes corrects a touchpoint after the fact. Rather than UPDATE the row (which loses history), `FormService.submit()` inserts a **new** row pointing to the original via `supersedes_submission_uuid`. dbt marts then SELECT only the latest in each supersession chain. This preserves the historical record of what was active on any past scored date — important for explaining old churn scores.

### `protopie_churn_score_configs` (the score config — one row per version)

```sql
CREATE TABLE protopie_churn_score_configs (
    config_uuid             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid            UUID NOT NULL REFERENCES projects(project_uuid) ON DELETE CASCADE,
    name                    VARCHAR(120) NOT NULL,           -- e.g. 'Default Churn Score'
    version                 INTEGER NOT NULL,                -- monotonic per (project_uuid, name)
    lookback_days           INTEGER NOT NULL DEFAULT 90,
    score_function          VARCHAR(40) NOT NULL DEFAULT 'linear',    -- 'linear' | 'stepwise'
    risk_band_thresholds    JSONB NOT NULL DEFAULT '{"low":0.75,"medium":0.50}'::jsonb,  -- score_percent → band
    effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_to            TIMESTAMPTZ,                     -- nullable; null means still active
    status                  VARCHAR(20) NOT NULL DEFAULT 'draft',  -- 'draft' | 'active' | 'archived'
    created_by_user_uuid    UUID NOT NULL REFERENCES users(user_uuid),
    updated_by_user_uuid    UUID NOT NULL REFERENCES users(user_uuid),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (project_uuid, name, version)
);
CREATE INDEX protopie_churn_score_configs_active_idx
    ON protopie_churn_score_configs (project_uuid, name) WHERE status = 'active' AND effective_to IS NULL;
```

### `protopie_churn_score_factors` (the N factors that make up a config)

```sql
CREATE TABLE protopie_churn_score_factors (
    factor_uuid         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    config_uuid         UUID NOT NULL REFERENCES protopie_churn_score_configs(config_uuid) ON DELETE CASCADE,
    factor_key          VARCHAR(120) NOT NULL,               -- 'pct_users_with_starting_action'
    label               TEXT NOT NULL,
    max_points          NUMERIC(5,2) NOT NULL,               -- weight; sums to 100 across factors of a config
    goal_value          NUMERIC(12,4) NOT NULL,              -- 0.5 for 50%, 20 for "20 actions per user"
    goal_unit           VARCHAR(20) NOT NULL,                -- 'fraction' | 'count_per_user' | 'days'
    aggregation         VARCHAR(40) NOT NULL,                -- 'pct_users_with_event' | 'event_count_per_user' | 'active_days' | …
    event_group         JSONB NOT NULL,                       -- { operator: 'or', events: ['Studio - App - Launched', …] }
    denominator         VARCHAR(40),                          -- 'distinct_users' | 'total_users' | null
    step_thresholds     JSONB,                                -- only used when config.score_function='stepwise'
    sort_order          INTEGER NOT NULL DEFAULT 0,           -- display order

    UNIQUE (config_uuid, factor_key)
);
CREATE INDEX protopie_churn_score_factors_config_idx
    ON protopie_churn_score_factors (config_uuid, sort_order);
```

**Versioning.** A config is immutable once `status='active'`. To change weights, the API creates a **new version** of the config (bumps `version`) and a fresh set of factor rows. The old config sets `effective_to` and is marked `archived`. Scores tagged with the old `config_uuid` keep showing what was true under that rubric — this is the "as-was history" model (see [04-churn-score-engine.md](./04-churn-score-engine.md)).

### `protopie_churn_score` (total score, one row per Account per scored_date per config)

```sql
CREATE TABLE protopie_churn_score (
    score_uuid          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid        UUID NOT NULL REFERENCES projects(project_uuid) ON DELETE CASCADE,
    account_key         VARCHAR(255) NOT NULL,
    salesforce_account_id VARCHAR(255),
    cloud_url           VARCHAR(255),
    scored_for_date     DATE NOT NULL,
    lookback_days       INTEGER NOT NULL DEFAULT 90,
    config_uuid         UUID NOT NULL REFERENCES protopie_churn_score_configs(config_uuid) ON DELETE RESTRICT,
    config_version      INTEGER NOT NULL,                -- denormalized for cheap reads
    total_score         NUMERIC(6,2) NOT NULL,           -- raw points awarded
    max_score           NUMERIC(6,2) NOT NULL,           -- sum of max_points across factors (usually 100)
    score_percent       NUMERIC(5,4) NOT NULL,           -- total_score / max_score, 0–1
    risk_band           VARCHAR(20) NOT NULL,            -- 'low' | 'medium' | 'high' (derived from band thresholds)
    factor_scores       JSONB NOT NULL,                  -- inline breakdown: { factor_key: { raw, goal, points } }
    computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_uuid            UUID NOT NULL REFERENCES protopie_churn_score_runs(run_uuid) ON DELETE CASCADE,

    UNIQUE (account_key, scored_for_date, lookback_days, config_uuid)
);
CREATE INDEX protopie_churn_score_account_idx
    ON protopie_churn_score (account_key, scored_for_date DESC);
CREATE INDEX protopie_churn_score_latest_idx
    ON protopie_churn_score (scored_for_date DESC, total_score);
CREATE INDEX protopie_churn_score_project_band_idx
    ON protopie_churn_score (project_uuid, risk_band, scored_for_date DESC);
```

**Why `factor_scores` JSONB AND a separate factor results table.** For most dashboards, the inline JSONB on the total row is sufficient (it lets the "Account 360" dashboard's factor breakdown tile work without a join). But some queries — "average points awarded for factor X across all Accounts last 30 days" — are awkward against JSONB. When those queries appear, materialize the next table:

### `protopie_churn_score_factor_results` *(optional — materialize if dashboards filter by factor)*

```sql
CREATE TABLE protopie_churn_score_factor_results (
    factor_result_uuid      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    score_uuid              UUID NOT NULL REFERENCES protopie_churn_score(score_uuid) ON DELETE CASCADE,
    account_key             VARCHAR(255) NOT NULL,
    scored_for_date         DATE NOT NULL,
    config_uuid             UUID NOT NULL,
    factor_key              VARCHAR(120) NOT NULL,
    raw_value               NUMERIC(14,4) NOT NULL,      -- the actual measured number for this Account
    goal_value              NUMERIC(14,4) NOT NULL,      -- from the factor config
    max_points              NUMERIC(5,2) NOT NULL,
    points_awarded          NUMERIC(5,2) NOT NULL,
    calculation_detail      JSONB,                        -- { numerator, denominator, event_group, …  for debugging }
    run_uuid                UUID NOT NULL REFERENCES protopie_churn_score_runs(run_uuid) ON DELETE CASCADE,

    UNIQUE (score_uuid, factor_key)
);
CREATE INDEX protopie_churn_score_factor_results_factor_date_idx
    ON protopie_churn_score_factor_results (factor_key, scored_for_date DESC);
```

For v1 we ship **only the JSONB on the total row** and defer this normalized table to v1.1 if dashboards need it.

### `protopie_churn_score_runs`

```sql
CREATE TABLE protopie_churn_score_runs (
    run_uuid                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_uuid            UUID NOT NULL REFERENCES projects(project_uuid) ON DELETE CASCADE,
    config_uuid             UUID NOT NULL REFERENCES protopie_churn_score_configs(config_uuid) ON DELETE RESTRICT,
    triggered_by            VARCHAR(40) NOT NULL,        -- 'scheduler' | 'manual' | 'mcp'
    triggered_by_user_uuid  UUID REFERENCES users(user_uuid),
    input_watermark         TIMESTAMPTZ,                 -- max event timestamp consumed (for incremental runs later)
    output_relation         VARCHAR(255),                 -- e.g. 'protopie_churn_score' — useful if we ever write elsewhere
    status                  VARCHAR(20) NOT NULL DEFAULT 'queued',  -- 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    started_at              TIMESTAMPTZ,
    finished_at             TIMESTAMPTZ,
    accounts_scored         INTEGER,
    error_message           TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX protopie_churn_score_runs_recent_idx
    ON protopie_churn_score_runs (project_uuid, created_at DESC);
```

### `protopie_account_overrides`

```sql
CREATE TABLE protopie_account_overrides (
    override_uuid       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    account_key         VARCHAR(255) NOT NULL,
    override_type       VARCHAR(40) NOT NULL,            -- 'force_score' | 'pinned_note' | 'exclude'
    override_value      JSONB NOT NULL,                  -- { score: 30, reason: '...' }
    valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until         TIMESTAMPTZ,
    created_by          UUID NOT NULL REFERENCES users(user_uuid),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX protopie_account_overrides_account_active_idx
    ON protopie_account_overrides (account_key)
    WHERE valid_until IS NULL OR valid_until > NOW();
```

## Migration file pattern

We follow the Lightdash convention. Example skeleton:

```ts
// packages/backend/src/protopie/database/migrations/20260601000000_create_protopie_tables.ts
import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable('protopie_form_submissions', (t) => {
        t.uuid('submission_uuid').primary().defaultTo(knex.raw('uuid_generate_v4()'));
        t.string('form_key', 120).notNullable();
        t.integer('form_version').notNullable();
        t.uuid('submitted_by').notNullable()
            .references('user_uuid').inTable('users').onDelete('RESTRICT');
        t.uuid('organization_uuid').notNullable()
            .references('organization_uuid').inTable('organizations').onDelete('CASCADE');
        t.uuid('project_uuid')
            .references('project_uuid').inTable('projects').onDelete('SET NULL');
        t.string('account_key', 255);
        t.jsonb('payload').notNullable();
        t.timestamp('submitted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('deleted_at', { useTz: true });
        t.text('notes');

        t.index(['form_key', 'submitted_at'], 'protopie_form_submissions_form_idx');
        t.index(['account_key'], 'protopie_form_submissions_account_idx');
    });
    // ... other tables in the same migration, or split into multiple files per table.
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists('protopie_form_submissions');
    // ... reverse order
}
```

### Migration directory wire-up

🔌 **WIRE-UP touch point #2.** Lightdash's existing Knex configuration runs migrations from two directories. We add a third. The exact file is typically `packages/backend/src/database/knexfile.ts` or wherever the `migrations.directory` array is declared. After the edit, `pnpm -F backend migrate` runs Protopie migrations alongside core.

```ts
// existing migrations config — small edit:
migrations: {
    directory: [
        path.join(__dirname, 'migrations'),
        path.join(__dirname, '../ee/database/migrations'),
        // 🔌 protopie:
        path.join(__dirname, '../protopie/database/migrations'),
    ],
}
```

> **Verify before writing the wire-up.** Find the actual file with `rg -n 'database/migrations' packages/backend/src/ -t ts`. The exact pathing convention may differ; mirror what Lightdash already does for `ee/`.

## Reading these tables from dbt (mart layer)

The dbt project (in a separate repo) declares Postgres as a *source*, points at the `protopie_*` tables, and builds marts on top:

```yaml
# dbt/models/sources/_protopie_postgres.yml
version: 2
sources:
  - name: protopie_postgres
    database: lightdash_postgres
    schema: public
    tables:
      - name: protopie_form_submissions
      - name: protopie_churn_score
      - name: protopie_churn_score_configs
      - name: protopie_churn_score_factors
      - name: protopie_account_overrides
```

Then a mart like:

```sql
-- dbt/models/marts/protopie/mart_sales_touchpoints.sql
with submissions as (
    select
        submission_uuid,
        submitted_at,
        account_key,
        payload->>'meeting_date'::date            as meeting_date,
        payload->>'rep_name'                       as rep_name,
        payload->>'notes_summary'                  as notes_summary,
        (payload->>'sentiment')::text             as sentiment   -- 'positive'|'neutral'|'negative'
    from {{ source('protopie_postgres', 'protopie_form_submissions') }}
    where form_key = 'account_touchpoint'
      and deleted_at is null
)
select * from submissions
```

That mart is then exposed in Lightdash via its dbt YAML (`meta.lightdash.{type: table}`) so charts can reference touchpoints by dimension.

See [06-dashboards.md](./06-dashboards.md) for the Lightdash side.

## Why we don't store anything in the warehouse from the backend

Lightdash already has a clean separation: **app DB (Postgres)** holds operational data; **warehouse (BigQuery)** holds analytical data. Forms are operational (CRUD, recent activity), so they live in Postgres. dbt is the right tool to move that into the warehouse for analytical use. We never have the backend write directly to BigQuery — that violates Lightdash's architecture and creates a service-account-permission rabbit hole.

## Seed data on first migration

The default config + 9 factors from the Notion brief are seeded by the migration. This guarantees a working churn score from day 1; sales can tune weights later via the API (which creates a new `version` of the config rather than mutating in place).

```ts
// inside the up() migration:
const [{ config_uuid }] = await knex('protopie_churn_score_configs').insert({
    project_uuid: '<protopie-project-uuid>',  // configured in env / migration parameter
    name: 'Default Churn Score',
    version: 1,
    lookback_days: 90,
    score_function: 'linear',
    risk_band_thresholds: JSON.stringify({ low: 0.75, medium: 0.50 }),
    status: 'active',
    created_by_user_uuid: '<system-user-uuid>',
    updated_by_user_uuid: '<system-user-uuid>',
}).returning('config_uuid');

await knex('protopie_churn_score_factors').insert([
    {
        config_uuid,
        factor_key: 'pct_users_with_starting_action',
        label: '% of users with starting action',
        max_points: 5,
        goal_value: 0.5,
        goal_unit: 'fraction',
        aggregation: 'pct_users_with_event',
        event_group: JSON.stringify({
            operator: 'or',
            events: ['Studio - App - Launched', 'Cloud - Studio - Launched', 'session_start', 'Cloud - Page - Entered'],
        }),
        denominator: 'distinct_users',
        sort_order: 1,
    },
    // … 8 more factors from the rubric in 00-context.md
]);
```

## Index review checklist (review before merging the migration)

- [ ] Every FK has an explicit `ON DELETE` clause.
- [ ] Every `WHERE`-filtered index uses `WHERE deleted_at IS NULL` (or equivalent) for soft-deleted tables.
- [ ] `protopie_form_submissions(account_key)` is indexed — the dashboards filter by Account.
- [ ] `protopie_churn_score(account_key, scored_for_date DESC)` is indexed — the most common read pattern.
- [ ] Unique constraints exist where dedup matters (`protopie_churn_score(account_key, scored_for_date, window_days, rule_set_version)`).
