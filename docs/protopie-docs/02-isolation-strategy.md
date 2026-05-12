# 02 — Isolation Strategy

> **Read this before writing a single line of code.** Every architectural decision in this fork serves one rule: *minimize the surface area where Protopie code touches Lightdash core.* Upstream pulls then become merge-friendly.

## The rule of one folder per package

Every Protopie-specific file lives under a `protopie/` subfolder of its package:

```
packages/
├── common/src/protopie/        ← shared types (form schemas, churn DTOs, MCP tool args)
├── backend/src/protopie/       ← controllers, services, models, migrations, scheduler, mcp
└── frontend/src/protopie/      ← routes, pages, components, hooks, providers
```

No Protopie file lives outside one of those three trees. **No exceptions.** If you find yourself wanting to edit a Lightdash core file, see [§ Wire-up touch points](#wire-up-touch-points) below — those are the *only* allowed edits.

## Backend folder layout

```
packages/backend/src/protopie/
├── index.ts                       ← exports register({ services, models, ... }) called by App.ts
├── config.ts                      ← PROTOPIE_ENABLED flag, schema, defaults
├── controllers/
│   ├── ChurnScoreController.ts    ← TSOA, auto-picked-up by `src/**/*Controller.ts` glob
│   ├── FormController.ts
│   └── ProtopieMcpController.ts   ← optional: REST mirror of MCP write tools for debugging
├── services/
│   ├── ChurnScoreService.ts       ← extends BaseService
│   ├── FormService.ts
│   ├── ProtopieMcpWriteToolService.ts
│   └── index.ts                   ← exports a single { create(...) } factory
├── models/
│   ├── ChurnScoreModel.ts         ← Knex wrapper around protopie_churn_score
│   ├── FormSubmissionModel.ts
│   ├── ScoringRuleModel.ts
│   └── tableNames.ts              ← const PROTOPIE_CHURN_SCORE_TABLE = 'protopie_churn_score'; etc.
├── database/
│   └── migrations/
│       └── 20260601000000_create_protopie_tables.ts
├── scheduler/
│   ├── tasks.ts                   ← task name enum + payload types
│   └── recomputeChurnScore.ts     ← Graphile Worker handler
├── mcp/
│   ├── registerWriteTools.ts      ← single entrypoint called from McpService
│   └── writeTools/
│       ├── createSpace.ts
│       ├── createDashboard.ts
│       ├── updateDashboard.ts
│       ├── createSavedChart.ts
│       ├── updateSavedChart.ts
│       ├── deleteContent.ts
│       └── shared/
│           ├── permissions.ts     ← CASL ability check helpers
│           └── schemas.ts         ← Zod input schemas for each tool
└── README.md                      ← points back to docs/claude-docs/
```

### Why this works with TSOA

Lightdash's `tsoa.yml` already declares:

```yaml
controllerPathGlobs:
    - src/**/*Controller.ts
```

(See `packages/backend/tsoa.yml`.) Any file matching `**/*Controller.ts` is auto-discovered and added to the generated routes. **So a controller at `packages/backend/src/protopie/controllers/FormController.ts` is automatically wired up without any edit to Lightdash core.** The only manual step after creating a controller is running `pnpm generate-api`.

### Why this works with migrations

Lightdash's Knex config can run migrations from multiple directories. Today it uses two — `src/database/migrations` and `src/ee/database/migrations`. We add a third: `src/protopie/database/migrations`. That requires **one edit** to `knexfile` — a wire-up touch point — and then all our migrations are isolated.

## Common package folder layout

```
packages/common/src/protopie/
├── index.ts                       ← re-exports
├── forms/
│   ├── schemas/
│   │   ├── accountTouchpoint.ts   ← Zod schema for one form
│   │   └── renewalStatus.ts
│   └── types.ts                   ← FormSchemaDefinition, FormSubmission
├── churn/
│   ├── types.ts                   ← ChurnScore, ScoringRule, ScoreFactor
│   └── constants.ts               ← default 9-factor rubric
└── mcp/
    └── writeToolSchemas.ts        ← Zod schemas shared between backend and any test client
```

These types are re-exported from `@lightdash/common` via a single line:

```ts
// packages/common/src/index.ts
// 🔌 WIRE-UP — append:
export * as Protopie from './protopie';
```

We namespace under `Protopie` so we never collide with upstream type names.

## Frontend folder layout

```
packages/frontend/src/protopie/
├── index.tsx                      ← exports protopieRoutes: RouteObject[]
├── routes.tsx                     ← /protopie/* tree
├── pages/
│   ├── DashboardsHomePage.tsx     ← list of churn dashboards
│   ├── FormSubmitPage.tsx
│   ├── FormHistoryPage.tsx
│   └── ScoringWeightsPage.tsx
├── components/
│   ├── ChurnScoreBadge.tsx
│   ├── DynamicForm.tsx            ← renders any FormSchemaDefinition
│   └── NavEntry.tsx               ← the single nav item injected upstream
├── hooks/
│   ├── useChurnScore.ts
│   ├── useFormSchemas.ts
│   └── useSubmitForm.ts
├── api/
│   └── protopieApi.ts             ← wraps fetch() against /api/v1/protopie/…
└── styles/
    └── theme.module.css
```

A single export — `protopieRoutes` — is consumed by Lightdash's root `Routes.tsx` via spread. See wire-up below.

## Wire-up touch points

These are the **only** Lightdash core files we modify. Each edit is minimal — typically one import + one registration line. They are flagged in every other doc as `🔌 WIRE-UP`.

| # | File | What we add | Why this is unavoidable |
|---|------|-------------|--------------------------|
| 1 | `packages/backend/src/App.ts` *(or `index.ts`)* | `await registerProtopieModule({ services, models, knex, ... });` | Plug services/models into the existing repositories. |
| 2 | `packages/backend/knexfile.ts` (or equivalent migration config) | Add `src/protopie/database/migrations` to migration directories. | Run our migrations. |
| 3a | `packages/common/src/types/schedulerTaskList.ts` | Add `PROTOPIE_RECOMPUTE_CHURN_SCORE` to `SCHEDULER_TASKS` + payload type to `TaskPayloadMap`. | Lightdash scheduler types are registry-driven — type-system enforces task registration. |
| 3b | `packages/backend/src/scheduler/SchedulerWorker.ts` | One import + one entry in the task handler map. | Register the OSS handler. |
| 3c | `packages/backend/src/ee/scheduler/SchedulerWorker.ts` | Same entry, only if your deployment uses the commercial worker. | EE worker maintains its own task map. |
| 4a | `packages/backend/src/ee/services/McpService/McpService.ts` | Add `coderService: CoderService` to `McpServiceArguments`; one import + one call `registerProtopieWriteTools(mcpServer, deps)` at the bottom of `createServer()`. | Add write tools to MCP. |
| 4b | `packages/backend/src/ee/index.ts` | One line: inject `coderService: repository.getCoderService()` into the `mcpService` provider. | `McpService` doesn't currently receive `CoderService`. |
| 5 | `packages/common/src/index.ts` | `export * as Protopie from './protopie';` | Make shared types importable. |
| 6 | `packages/frontend/src/Routes.tsx` | `...protopieRoutes` spread inside `PRIVATE_ROUTES` array. | Mount our route tree. |
| 7 | `packages/frontend/src/components/NavBar/MainNavBarContent.tsx` | One import + one `<ProtopieNavEntry />` element. | Show nav link. |

Every touch point is **idempotent** and **<5 lines**. A clean-room delete of the Protopie module = remove the seven touch-point lines, then `rm -rf` the three `protopie/` trees. We document this in [09-implementation-roadmap.md](./09-implementation-roadmap.md) as part of the "kill switch" criterion.

## Provider pattern (re-using Lightdash's existing DI)

Lightdash already supports plug-in providers in `App.ts` via `serviceProviders`, `modelProviders`, and `clientProviders` (see `packages/backend/src/ee/index.ts` lines 49-65). We **piggy-back on this same mechanism** rather than inventing our own:

```ts
// packages/backend/src/protopie/index.ts — sketch
export async function getProtopieAppArguments(): Promise<Partial<AppArguments>> {
    if (!protopieConfig.enabled) return {};

    return {
        serviceProviders: {
            churnScoreService: ({ models, repository, context }) =>
                new ChurnScoreService({
                    analytics: context.lightdashAnalytics,
                    churnScoreModel: models.getChurnScoreModel(),
                    scoringRuleModel: models.getScoringRuleModel(),
                    projectService: repository.getProjectService(),
                    lightdashConfig: context.lightdashConfig,
                }),
            formService: ({ models, context }) =>
                new FormService({
                    formSubmissionModel: models.getFormSubmissionModel(),
                    lightdashConfig: context.lightdashConfig,
                }),
        },
        modelProviders: {
            churnScoreModel: ({ database }) => new ChurnScoreModel({ database }),
            scoringRuleModel: ({ database }) => new ScoringRuleModel({ database }),
            formSubmissionModel: ({ database }) => new FormSubmissionModel({ database }),
        },
    };
}
```

Then `App.ts` merges Lightdash's existing arguments with ours:

```ts
// packages/backend/src/index.ts — 🔌 WIRE-UP
const enterpriseArgs = await getEnterpriseAppArguments();
const protopieArgs = await getProtopieAppArguments();
const app = new App({
    ...enterpriseArgs,
    ...protopieArgs,
    serviceProviders: { ...enterpriseArgs.serviceProviders, ...protopieArgs.serviceProviders },
    modelProviders: { ...enterpriseArgs.modelProviders, ...protopieArgs.modelProviders },
});
```

This is the *one and only* DI wiring change. Adding a new Protopie service later = just add another entry to `serviceProviders` in our `getProtopieAppArguments` — no edit to Lightdash core needed.

> **Note on `ServiceRepository.getChurnScoreService()`** — TypeScript will not know about our custom services on the typed repository. We accept this and use a small typed adapter (`getProtopieServices(repository)`) inside Protopie controllers, rather than augmenting Lightdash's `ServiceRepository` type. This keeps the upstream type clean.

## Database table naming convention

All Protopie-owned tables have a **`protopie_` prefix**:

- `protopie_form_definitions` *(code-defined forms synced into this table on startup; see 05)*
- `protopie_form_submissions`
- `protopie_churn_score_configs`
- `protopie_churn_score_factors`
- `protopie_churn_score`
- `protopie_churn_score_runs`
- `protopie_account_overrides`

No exceptions. Search-and-destroy is trivial.

## What goes upstream eventually

After we stabilize the fork, candidates to PR back to Lightdash:

1. The **MCP write tools** for spaces/dashboards/charts — they are generally useful and not Protopie-specific.
2. A general-purpose **forms framework** — if other Lightdash users want it.

Both are designed in this fork to be re-extractable: they live in `protopie/` only because that's where we wrote them, not because their logic is Protopie-specific. If we keep the abstractions clean (no churn-specific logic in `protopie/mcp/`), extraction is a `git mv` plus a rename.

## Anti-patterns to avoid

- ❌ Adding a new column to a Lightdash core table (e.g., `dashboards.churn_account`). → Make a join table or sidecar.
- ❌ Importing from `protopie/` in any non-`protopie/` file. → Only the seven wire-up touch points may import from `protopie/`.
- ❌ Modifying CASL abilities files (`projectMemberAbility.ts` etc.) for Protopie-only scopes. → Use a per-route check, or define a scope in `protopie/auth/` and call it explicitly.
- ❌ Adding Protopie env vars to Lightdash's `parseConfig.ts`. → Keep Protopie config in `protopie/config.ts`, validated independently.

## Self-test: can we delete the fork in 10 minutes?

After implementation, the answer must remain "yes":

```bash
# remove protopie trees
rm -rf packages/{common,backend,frontend}/src/protopie

# revert the seven touch-point edits
git checkout HEAD~ -- packages/backend/src/index.ts \
                       packages/backend/knexfile.ts \
                       packages/backend/src/scheduler/SchedulerWorker.ts \
                       packages/backend/src/ee/services/McpService/McpService.ts \
                       packages/common/src/index.ts \
                       packages/frontend/src/Routes.tsx \
                       packages/frontend/src/components/NavBar/MainNavBarContent.tsx

# drop tables
psql -c "DROP TABLE protopie_form_submissions, protopie_churn_score, ..."
```

If this becomes hard, we've drifted from the isolation rule. Treat it as a design smell and refactor.
