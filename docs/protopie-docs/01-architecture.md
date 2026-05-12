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
   │   │ dashboards,  │  │ forms +       │  │ + write tools      │    │   submissions,  │
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

### C. MCP write tools

**Purpose.** Let external AI agents create / update charts, dashboards, spaces via MCP.

**Where the code lives.**

| Layer | Path | New / Existing |
|-------|------|----------------|
| MCP write tools | `packages/backend/src/protopie/mcp/writeTools/*.ts` | New |
| Tool registry | `packages/backend/src/protopie/mcp/registerWriteTools.ts` | New |
| `requireMcpWrite` helper | `packages/backend/src/protopie/mcp/shared/requireMcpWrite.ts` | New — enforces `mcp:write` OAuth scope per call (gap in current MCP service) |
| Wire-up | 🔌 Modify `McpService.ts` to call `registerWriteTools(server, deps)` AND inject `coderService` in `packages/backend/src/ee/index.ts` | **Smallest possible upstream edit** |

The tools wrap Lightdash's **existing `CoderService`** (`packages/backend/src/services/CoderService/CoderService.ts`) — `upsertChart`, `upsertSqlChart`, `upsertDashboard`, `getOrCreateSpace`. CoderService is already slug-based, idempotent, and permission-gated (`manage:ContentAsCode`), making it the right substrate for agent-driven authoring. We do **not** wrap raw `DashboardService.create()` — that's not idempotent for an agent that may retry.

See [07-mcp-server-extension.md](./07-mcp-server-extension.md).

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
Claude Code → MCP HTTP /mcp endpoint (existing mcpRouter.ts)
            → McpServer.handle(toolCall: "upsert_dashboard_as_code", args)
            → requireMcpWrite(authInfo)              ← rejects mcp:read-only callers
            → Protopie write-tool handler
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
- MCP write tools enforce per-tool CASL ability checks (e.g., `subject('Dashboard', { projectUuid })` + `'create'`).
- A new scope **may** be added if we want to gate the form system to a sales role — see [05-forms-system.md](./05-forms-system.md) for the decision.

### Logging / observability

- Sentry is already integrated; Protopie services should extend `BaseService` so trace context is preserved.
- Add a Sentry tag `module: 'protopie'` so dashboards can be filtered.

### Configuration / feature flag

A single environment variable `PROTOPIE_ENABLED=true|false` is checked at startup. If false, the entire Protopie subsystem (controllers, scheduler tasks, MCP write tools, frontend route tree) is skipped. This is the single source of truth for fork-on/fork-off — see [02-isolation-strategy.md](./02-isolation-strategy.md).

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

Lightdash runs on **AWS ECS Fargate** (one container per task — same process serves HTTP + runs Graphile Worker via `SCHEDULER_ENABLED=true`), backed by a Postgres 15 RDS instance for the app DB and an S3 bucket for object storage. Two environments (`dev` / `prod`), each Terraform-managed in `/Users/mamur/Documents/projects/lightdash-infra/infra/{dev,prod}/`. The fork repo is `github.com/ProtoPie/lightdash`; we build a custom Docker image, push to ECR, and reference it from the Terraform task definition.

The dbt project deployment (Airflow DAGs that build marts on Redshift, plus the new App-DB-→-Redshift sync) lives in a separate infrastructure stack owned by data-engineering. Coupling is via (a) the Redshift warehouse Lightdash queries through `WarehouseClient`, and (b) the Airflow read-only Postgres role on Lightdash's RDS.

See [15-deployment.md](./15-deployment.md) for the full picture.

## What we are NOT changing

- Lightdash's core controllers, services, models, migrations.
- Lightdash's existing MCP read tools.
- Lightdash's auth system (we reuse it).
- The dbt project's existing models — we only *add* `models/marts/warehouse/protopie/`.
- The Terraform stack's shape — we only *add* env vars, point at our ECR image, and (later) add a security-group rule allowing the Airflow worker SG to reach RDS:5432.

That's the whole point of the isolation strategy. See next doc.
