# 01 — Architecture

## System view (target state)

```
                              ┌────────────────────────────────────┐
                              │            Data sources             │
                              └────────────────────────────────────┘
   ┌────────────────┐   ┌────────────────┐   ┌──────────────────────┐
   │   Amplitude    │   │   Salesforce   │   │ Cloud / Enterprise   │
   │ (Spectrum:     │   │ (accounts, $$) │   │ (Postgres replicas)  │
   │  events_718461)│   │                │   │                      │
   └───────┬────────┘   └────────┬───────┘   └──────────┬───────────┘
           │                     │                       │
           ▼                     ▼                       ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │                Data Warehouse (Amazon Redshift)                   │
   │   prod database — schemas: amplitude_spectrum, enterprise,        │
   │   cloud, cloud_all, billing, misc                                 │
   └──────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │              dbt project — /Users/mamur/Documents/projects/      │
   │                              data-modeling                       │
   │   • models/staging/ → 74 stg_* models                            │
   │   • models/marts/warehouse/ → existing domains                   │
   │       (billing, cloud, learnworld, credit, ai_assistant)         │
   │   • models/marts/warehouse/protopie/  ← NEW: churn marts          │
   │     – mart_account_usage_90d                                      │
   │     – mart_churn_score                                            │
   │     – mart_sales_touchpoints (built off Lightdash app DB)        │
   └──────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼                                           ┌─────────────────┐
   ┌──────────────────────────────────────────────────────────────────┤  Postgres app   │
   │              Lightdash (forked, Protopie build)                  │  DB             │
   │                                                                  │  • protopie_*   │
   │   ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐    │     tables      │
   │   │ Existing     │  │ NEW protopie │  │ EXTENDED McpService│    │  (forms,        │
   │   │ dashboards,  │  │ forms +       │  │ + dbt/API/tools    │    │   submissions,  │
   │   │ spaces,      │  │ churn UI      │  │                    │    │   weights,      │
   │   │ charts,      │  │              │  │                    │    │   scores)       │
   │   │ MCP read     │  │              │  │                    │    │                 │
   │   │ tools        │  │              │  │                    │    │                 │
   │   └──────────────┘  └──────┬───────┘  └─────────┬──────────┘    └────────┬────────┘
   │                            │                    │                        │
   └────────────────────────────┼────────────────────┼────────────────────────┘
                                │                    │
                  ┌─────────────┘                    │
                  ▼                                  ▼
       ┌──────────────────┐               ┌──────────────────────┐
       │  Sales team UI   │               │  External AI agents   │
       │  (browser)       │               │  (Claude Code, etc.)  │
       └──────────────────┘               └──────────────────────┘
```

## The three Protopie subsystems

### A. Churn Score subsystem

**Purpose.** Replace ChurnZero. Compute a per-Account churn score nightly.

**Where the code lives.**

| Layer | Path | New / Existing |
|-------|------|----------------|
| dbt marts | `models/marts/warehouse/protopie/` *in the [data-modeling repo](#dbt-project-location)* | New |
| Scheduler task | `packages/backend/src/protopie/scheduler/recomputeChurnScore.ts` | New |
| Scoring rules table | `packages/backend/src/protopie/database/migrations/*_create_churn_scoring_rules.ts` | New |
| Score storage | Same migration → `protopie_churn_score` table | New |
| Read API | `packages/backend/src/protopie/controllers/ChurnScoreController.ts` | New |
| Dashboards | Built **inside Lightdash** as ordinary dashboards via the existing dashboard/chart system | Configuration only |

See [04-churn-score-engine.md](./04-churn-score-engine.md).

### B. Forms subsystem

**Purpose.** Let sales enter manual data (touchpoints, renewal notes, score overrides) into Postgres so dbt can model it.

**Where the code lives.**

| Layer | Path | New / Existing |
|-------|------|----------------|
| Form schema definitions | `packages/common/src/protopie/forms/schemas/*.ts` | New (TypeScript Zod schemas) |
| Submissions table | `packages/backend/src/protopie/database/migrations/*_create_protopie_form_submissions.ts` | New |
| Form service | `packages/backend/src/protopie/services/FormService.ts` | New |
| Form controller | `packages/backend/src/protopie/controllers/FormController.ts` | New |
| Form UI | `packages/frontend/src/protopie/forms/` | New |
| dbt source | `models/staging/protopie_app/source.yml` declares Lightdash Postgres tables (`protopie_form_submissions` etc.) as a source | New (in [data-modeling repo](#dbt-project-location)) |

See [05-forms-system.md](./05-forms-system.md).

### C. MCP extension

**Purpose.** Let external AI agents understand dbt marts, inspect Lightdash APIs, and create/update charts, dashboards, and spaces via MCP.

**Where the code lives.**

| Layer | Path | New / Existing |
|-------|------|----------------|
| MCP tools | `packages/backend/src/protopie/mcp/registerProtopieMcpTools.ts` | New |
| Shared helpers | `packages/backend/src/protopie/mcp/shared/*.ts` | New — auth, audit, dbt repository access, examples, responses |
| Org settings API | `packages/backend/src/protopie/controllers/SettingsController.ts` | New — admin write-toggle endpoint |
| Wire-up | 🔌 Modify `McpService.ts` to call `registerProtopieMcpTools(...)` with the existing Lightdash services it needs | **Smallest possible upstream edit** |

The content write tools wrap Lightdash's **existing `CoderService`** (`packages/backend/src/services/CoderService/CoderService.ts`) — `upsertChart`, `upsertSqlChart`, `upsertDashboard`, `getOrCreateSpace`. CoderService is already slug-based, idempotent, and permission-gated (`manage:ContentAsCode`), making it the right substrate for agent-driven authoring. The same extension also provides read-only dbt source tools and a guarded Lightdash REST API bridge.

See [07-mcp-server-extension.md](./07-mcp-server-extension.md).

## Request paths

### Sales rep submits a touchpoint

```
Browser → POST /api/v1/protopie/forms/account-touchpoint/submissions
        → FormController.submit()
        → FormService.validateAndPersist()      ← Zod validation
        → ProtopieFormSubmissionModel.insert()  ← Knex
        → Postgres: protopie_form_submissions
        ↓ (later, via dbt)
        Warehouse: mart_sales_touchpoints
        ↓ (used by)
        Churn Score dashboard tile in Lightdash
```

### Nightly churn recompute

```
Graphile Worker cron → SchedulerWorker enqueues recomputeChurnScore
                     → ChurnScoreService.recomputeAll()
                       ├─ Reads warehouse: mart_account_usage_90d
                       ├─ Reads Postgres: protopie_churn_score_configs + _factors
                       ├─ Computes score per Account
                       └─ Writes Postgres: protopie_churn_score (upsert)
                                          + audit row in protopie_churn_score_runs
```

### External agent creates a dashboard via MCP

```
Claude Code → MCP HTTP /api/v1/mcp endpoint
            → McpServer.handle(toolCall: "protopie_upsert_dashboard_as_code", args)
            → requireMcpWriteScope(authInfo)         ← rejects mcp:read-only callers
            → requireOrganizationMcpWriteEnabled()   ← org admin opt-in
            → Protopie MCP tool handler
            → CoderService.upsertDashboard(...)      ← reused as-is
              ├─ getOrCreateSpace()                  ← reused
              ├─ resolves chart slugs → UUIDs        ← reused
              └─ DashboardService + PromoteService   ← reused
            → Postgres: dashboards + dashboard_versions tables
            ← Tool response: { dashboardUuid, slug, url, created: true|false }
```

The agent authenticates via the **already-built** OAuth2, PAT, or service-account flows (`packages/backend/src/routers/oauthRouter.ts`). No new auth is needed.

## Cross-cutting concerns

### Authentication / authorization

- All Protopie endpoints reuse Lightdash's auth middlewares (`isAuthenticated`, `allowApiKeyAuthentication`).
- MCP write tools enforce the `mcp:write` scope, the org-level Protopie MCP write toggle, and Lightdash service-layer CASL checks.
- A new scope **may** be added if we want to gate the form system to a sales role — see [05-forms-system.md](./05-forms-system.md) for the decision.

### Logging / observability

- Sentry is already integrated; Protopie services should extend `BaseService` so trace context is preserved.
- Add a Sentry tag `module: 'protopie'` so dashboards can be filtered.

### Configuration / feature flags

The current MCP surface is controlled by Lightdash's existing `MCP_ENABLED=true|false` environment variable. MCP write behavior has a second, per-organization admin toggle stored in Protopie settings and exposed at `/generalSettings/integrations`.

There is no single implemented `PROTOPIE_ENABLED` kill switch yet for every Protopie controller, frontend route, and scheduler task. If that global switch becomes necessary, implement it as a separate config slice rather than overloading `MCP_ENABLED`, which should remain MCP-specific.

## dbt project location

The dbt project lives **outside** the Lightdash fork, at:

```
/Users/mamur/Documents/projects/data-modeling
```

It is a separate git repository. The two repos are coupled at the Lightdash UI layer (Lightdash reads compiled dbt manifest for explores) and at the Postgres source layer (dbt reads Lightdash's app DB to surface `protopie_form_submissions` etc. as a source).

Key facts about that repo (see [11-dbt-integration.md](./11-dbt-integration.md) for full details):

- **Warehouse:** Amazon Redshift (`prod` database).
- **Target schemas:** `warehouse_staging` (dev) / `warehouse` (prod).
- **Existing structure:** 74 staging models, 31 marts split across `billing`, `cloud`, `learnworld`, `credit`, `ai_assistant` domains. Time-grain subdirs (`daily/`, `weekly/`, `monthly/`).
- **Lightdash integration:** mart models tagged `lightdash` and carry `meta` config (joins, dimensions, metrics) inline. Content-as-code YAML lives in the same repo under `lightdash/charts/` and `lightdash/dashboards/`.
- **All materializations are `table`** (no views, no incremental yet — except the Amplitude staging model which is incremental).

## Deployment

Lightdash runs on **AWS ECS Fargate** (one container per task — same process serves HTTP + runs Graphile Worker via `SCHEDULER_ENABLED=true`), backed by an RDS Postgres app DB and an S3 bucket for object storage. Two environments (`dev` / `prod`) are Terraform-managed in this repo under `infra/{dev,prod}`. The fork repo is `github.com/ProtoPie/lightdash`; we build a custom Docker image, push to ECR, and reference it from the Terraform task definition.

The dbt project deployment (Airflow DAGs that build marts on Redshift, plus the new App-DB-→-Redshift sync) lives in a separate infrastructure stack owned by data-engineering. Coupling is via (a) the Redshift warehouse Lightdash queries through `WarehouseClient`, and (b) the Airflow read-only Postgres role on Lightdash's RDS.

See [15-deployment.md](./15-deployment.md) for the full picture.

## What we are NOT changing

- Lightdash's core controllers, services, models, migrations.
- Lightdash's existing MCP read tools.
- Lightdash's auth system (we reuse it).
- The dbt project's existing models — we only *add* `models/marts/warehouse/protopie/`.
- The Terraform stack's shape — we only *add* env vars, point at our ECR image, and (later) add a security-group rule allowing the Airflow worker SG to reach RDS:5432.

That's the whole point of the isolation strategy. See next doc.
