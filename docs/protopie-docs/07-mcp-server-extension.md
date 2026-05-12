# 07 — MCP Server Extension (write tools)

> Lightdash already runs an MCP server at `packages/backend/src/ee/services/McpService/McpService.ts` (~2,500 lines) with **16 read-only tools**. This doc covers adding **write tools** by piggy-backing on Lightdash's existing **content-as-code** layer (`CoderService`), which is the right substrate because it is already slug-based, idempotent, permission-gated, and used by the `lightdash upload` CLI today.

## Why CoderService — not raw service calls

An earlier draft of this doc proposed building separate `create_dashboard`, `update_dashboard`, `archive_dashboard` tools that wrapped `DashboardService.create()` etc. **That's the wrong substrate** for two reasons:

1. `CoderService` already exists and is the durable, idempotent write interface for dashboards/charts/spaces. It's slug-based (perfect for agents that re-call with the same payload), and tile references in dashboards use chart slugs which it resolves to UUIDs automatically.
2. `CoderService` already enforces `manage:ContentAsCode` and uses `SpaceService`, `SavedChartService`, `DashboardService`, `SqlChartService`, `PromoteService` under the hood. Wrapping it with MCP tools means we **inherit all of that** — permissions, validation, slug uniqueness handling, version creation — instead of re-implementing them.

So the MCP write tools are **thin Zod adapters over `CoderService`**. They are upsert-based: the same tool both creates and updates, keyed by slug.

## What already exists (read tools)

Read-only tools already in `McpService.ts` — we don't touch these:

`get_lightdash_version`, `list_explores`, `find_explores`, `find_fields`, `find_content`, `list_projects`, `set_project`, `get_current_project`, `list_agents`, `set_agent`, `clear_agent`, `get_current_agent`, `run_metric_query`, `run_sql`, `search_field_values`, `list_verified_content`.

## What we add

| Direction | Tool | Backed by |
|-----------|------|-----------|
| read | `list_spaces` | `SpaceService` |
| read | `get_charts_as_code` | `CoderService.getCharts` |
| read | `get_sql_charts_as_code` | `CoderService.getSqlCharts` |
| read | `get_dashboards_as_code` | `CoderService.getDashboards` |
| read | `get_content_as_code_schema` | static — returns Zod/JSON schema with examples |
| write | `create_space` | `SpaceService.createSpace` |
| write | `update_space` | `SpaceService.updateSpace` |
| write | `upsert_chart_as_code` | `CoderService.upsertChart` |
| write | `upsert_sql_chart_as_code` | `CoderService.upsertSqlChart` |
| write | `upsert_dashboard_as_code` | `CoderService.upsertDashboard` |

**Deliberately deferred to a later release:**

- `move_content` — call `upsert_dashboard_as_code` with a different `spaceSlug` instead.
- `delete_content` / `archive_*` — destructive; needs strict confirmation semantics. Use the UI in v1.
- `validate_*_as_code` — useful for catching agent mistakes before write; nice-to-have.

## Where this code lives — open architecture question

The MCP write tools are **generic** — they work for any Lightdash content, not Protopie's churn data. So where they live is a real choice:

### Option A — Keep in `packages/backend/src/protopie/mcp/` *(current proposal)*

**Pros:** Honors the isolation rule from [02-isolation-strategy.md](./02-isolation-strategy.md). Removable in one `rm -rf` if Protopie is wound down. Designed for upstream PR via a clean `git mv`.

**Cons:** Code with non-Protopie semantics hides under a Protopie-branded path. New eng who joins later wonders why "Protopie owns generic Lightdash features." The `requireMcpWrite` helper, the audit table, and the org-settings table all bleed beyond a strictly-Protopie scope.

### Option B — Move to `packages/backend/src/ee/services/McpService/writeTools/` *(codex's suggestion)*

**Pros:** The tools live next to the existing McpService code that they extend. Implies they're a fork-wide feature, not a Protopie-only one. Easier for upstream PR (no rename needed).

**Cons:** Mixed into Lightdash core EE code, so the kill-switch (revert seven touch points) no longer cleanly removes them — they'd need a separate cleanup step. Also requires Lightdash's EE license to be valid (the `ee/` folder is enterprise-gated).

### Recommendation

**Ship Option A in v1.** It preserves the kill-switch property and matches the "we're a temporary fork" mindset for the launch. Once the write tools are stable and the team commits to maintaining a long-running fork (or upstream accepts the PR), refactor to Option B in v1.1 — a contained one-PR move.

The Protopie module's `requireMcpWrite`, `protopie_organization_settings`, and `protopie_mcp_audit_log` already live in Protopie-land. The generic write tools just happen to be physically located there. **No tool implementation logic is Protopie-specific** — that's the invariant.

## Folder layout (Option A)

```
packages/backend/src/protopie/mcp/
├── registerWriteTools.ts           ← single entry called from McpService
├── shared/
│   ├── requireMcpWrite.ts          ← scope enforcement helper
│   ├── requireMcpWriteEnabledForOrg.ts  ← org opt-in check
│   ├── auditLogger.ts              ← writes protopie_mcp_audit_log rows
│   ├── annotations.ts              ← shared MCP tool annotations
│   ├── activeProject.ts            ← resolves project_uuid from MCP context if omitted
│   └── promotionChangesAdapter.ts  ← PromotionChanges → MCP structuredContent
└── writeTools/
    ├── listSpaces.ts
    ├── createSpace.ts
    ├── updateSpace.ts
    ├── getChartsAsCode.ts
    ├── upsertChartAsCode.ts
    ├── getSqlChartsAsCode.ts
    ├── upsertSqlChartAsCode.ts
    ├── getDashboardsAsCode.ts
    ├── upsertDashboardAsCode.ts
    └── getContentAsCodeSchema.ts
```

## Wire-up

🔌 **WIRE-UP touch point #4 (extended).** Two edits, both in EE:

### a) Inject `CoderService` into `McpService`

`McpService` does **not** currently receive `coderService`. In `packages/backend/src/ee/index.ts`, find the `mcpService` provider in `serviceProviders` and add `coderService`:

```ts
// packages/backend/src/ee/index.ts — within getEnterpriseAppArguments()
mcpService: ({ context, models, repository, clients }) =>
    new McpService({
        // ... existing dependencies
        spaceService: repository.getSpaceService(),
        savedChartService: repository.getSavedChartService(),
        dashboardService: repository.getDashboardService(),
        // 🔌 add:
        coderService: repository.getCoderService(),
    }),
```

And add `coderService: CoderService` to `McpServiceArguments` in `McpService.ts`.

### b) Register our tools at the bottom of `createServer()`

```ts
// packages/backend/src/ee/services/McpService/McpService.ts
// ... existing imports
import { registerProtopieWriteTools } from '../../../protopie/mcp/registerWriteTools';

// At the end of createServer(), AFTER the existing read tools are registered:
registerProtopieWriteTools(server, {
    spaceService: this.spaceService,
    coderService: this.coderService,
    lightdashConfig: this.lightdashConfig,
    accountFromAuthInfo: this.accountFromAuthInfo.bind(this),
    activeProject: this.activeProject.bind(this),     // existing helper
});
```

`registerProtopieWriteTools` then registers each tool:

```ts
// packages/backend/src/protopie/mcp/registerWriteTools.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSpacesTool } from './writeTools/listSpaces';
import { createSpaceTool } from './writeTools/createSpace';
import { updateSpaceTool } from './writeTools/updateSpace';
import { getChartsAsCodeTool } from './writeTools/getChartsAsCode';
import { upsertChartAsCodeTool } from './writeTools/upsertChartAsCode';
import { getSqlChartsAsCodeTool } from './writeTools/getSqlChartsAsCode';
import { upsertSqlChartAsCodeTool } from './writeTools/upsertSqlChartAsCode';
import { getDashboardsAsCodeTool } from './writeTools/getDashboardsAsCode';
import { upsertDashboardAsCodeTool } from './writeTools/upsertDashboardAsCode';
import { getContentAsCodeSchemaTool } from './writeTools/getContentAsCodeSchema';

export function registerProtopieWriteTools(server: McpServer, deps: WriteToolDeps) {
    listSpacesTool.register(server, deps);
    createSpaceTool.register(server, deps);
    updateSpaceTool.register(server, deps);
    getChartsAsCodeTool.register(server, deps);
    upsertChartAsCodeTool.register(server, deps);
    getSqlChartsAsCodeTool.register(server, deps);
    upsertSqlChartAsCodeTool.register(server, deps);
    getDashboardsAsCodeTool.register(server, deps);
    upsertDashboardAsCodeTool.register(server, deps);
    getContentAsCodeSchemaTool.register(server, deps);
}
```

If Protopie is disabled (`PROTOPIE_ENABLED=false`), `registerProtopieWriteTools` is a no-op — no write tools exposed.

## Permission model (three layers)

Write tools enforce **three** checks in order. Each layer can reject; the first rejection becomes the MCP tool's error response.

### Layer 1 — `mcp:write` OAuth scope (`requireMcpWrite`)

```ts
// packages/backend/src/protopie/mcp/shared/requireMcpWrite.ts
import { ForbiddenError } from '@lightdash/common';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export function requireMcpWrite(authInfo: AuthInfo | undefined): void {
    if (!authInfo) throw new ForbiddenError('MCP auth context missing');
    const scopes = authInfo.scopes ?? [];
    if (!scopes.includes('mcp:write')) {
        throw new ForbiddenError(
            'This tool requires the `mcp:write` OAuth scope. Re-authenticate with write permission.',
        );
    }
}
```

Every write tool calls this as its first line.

### Layer 2 — Org-level opt-in (`protopie_organization_settings`)

Write tools are **OFF by default per organization**. An org admin must explicitly enable them. We persist the flag in a new table:

```sql
CREATE TABLE protopie_organization_settings (
    organization_uuid                  UUID PRIMARY KEY REFERENCES organizations(organization_uuid) ON DELETE CASCADE,
    mcp_write_tools_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
    mcp_write_tools_enabled_at         TIMESTAMPTZ,
    mcp_write_tools_enabled_by_user_uuid UUID REFERENCES users(user_uuid),
    created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

A helper resolves the flag before invoking the underlying service:

```ts
async function requireMcpWriteEnabledForOrg(
    organizationUuid: string,
    settingsModel: ProtopieOrganizationSettingsModel,
): Promise<void> {
    const setting = await settingsModel.getByOrg(organizationUuid);
    if (!setting?.mcp_write_tools_enabled) {
        throw new ForbiddenError(
            'MCP write tools are disabled for this organization. An org admin can enable them in Settings → Integrations → MCP.',
        );
    }
}
```

Toggle endpoints (org-admin-only):

| Method | Path | Auth |
|--------|------|------|
| GET    | `/api/v1/protopie/org/mcp-settings` | Org admin |
| PUT    | `/api/v1/protopie/org/mcp-settings` | Org admin |

A minimal UI page lives at `/protopie/settings/mcp` (admin-gated; see [08-frontend-integration.md](./08-frontend-integration.md)) showing an enable/disable toggle and the audit timestamp.

### Layer 3 — Per-call service CASL ability

Lightdash's existing service-layer checks run automatically when we call `CoderService.upsertX` (which checks `manage:ContentAsCode`) and `SpaceService.createSpace` / `updateSpace` (which check `create:Space` / `manage:Space`). We do not duplicate these — failing CASL produces a `ForbiddenError` that the MCP tool surfaces to the agent.

## How tokens get scopes

| Auth method | `mcp:read` | `mcp:write` |
|-------------|-----------|-------------|
| **OAuth Bearer (user-to-machine)** | Granted if the OAuth consent screen included `mcp:read`. | Granted only if the consent screen explicitly included `mcp:write`. We update the dynamic client registration flow in `oauthRouter.ts` to advertise `mcp:write` as a separate scope so consent UX is clear. |
| **OAuth Bearer (machine-to-machine, client credentials)** | Granted if the OAuth client was registered with `mcp:read`. | Granted only if registered with `mcp:write`. Org admin controls registration. |
| **Personal Access Token (PAT)** | Default ON. | Default ON today; we propose adding a `scopes` column to `personal_access_tokens` and defaulting `mcp:write` to OFF unless the PAT was created with `--allow-mcp-write`. This is an upstream-friendly change — flag for the open-questions list. |
| **Service account** | Default ON. | Default ON when the service account has the `mcp_write_tools` capability in its role; OFF otherwise. |

For v1, the simplest defensible setup:
- **OAuth users** must explicitly consent to `mcp:write` when authorizing the client.
- **PATs and service accounts** carry `mcp:write` by default *but* Layer 2 (org opt-in) is OFF by default — so writes are blocked regardless until an admin enables them.

This gives admins a single switch to disable all MCP writes org-wide, even if PATs are leaked.

## Audit logging

Every successful or failed write tool call emits **two** records:

1. **`LightdashAnalytics.track`** with `event: 'mcp_write_tool.called'` — the analytics path, matching existing read-tool tracking shape.
2. **A row in `protopie_mcp_audit_log`** (new table) — durable, queryable by org admins:

   ```sql
   CREATE TABLE protopie_mcp_audit_log (
       audit_uuid             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
       organization_uuid      UUID NOT NULL REFERENCES organizations(organization_uuid) ON DELETE CASCADE,
       project_uuid           UUID REFERENCES projects(project_uuid) ON DELETE SET NULL,
       user_uuid              UUID REFERENCES users(user_uuid) ON DELETE SET NULL,
       auth_method            VARCHAR(40) NOT NULL,        -- 'oauth' | 'pat' | 'service_account'
       tool_name              VARCHAR(120) NOT NULL,        -- 'upsert_dashboard_as_code' etc.
       input_summary          JSONB NOT NULL,               -- { slug, spaceSlug, projectUuid }
       outcome                VARCHAR(20) NOT NULL,         -- 'ok' | 'forbidden' | 'error'
       action_summary         JSONB,                        -- PromotionChanges → action counts
       error_message          TEXT,
       created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
   );
   CREATE INDEX protopie_mcp_audit_log_org_recent_idx
       ON protopie_mcp_audit_log (organization_uuid, created_at DESC);
   ```

   The `input_summary` is intentionally compact — slug, target space, project. We do not log the full `dashboardAsCode` payload (could be large, may contain PII via tile titles). If a forensic trail of the exact payload is ever needed, that comes from `dashboard_versions` (already versioned by Lightdash).

A read-only admin endpoint `GET /api/v1/protopie/org/mcp-audit-log` lets org admins inspect recent activity.

## Actual `CoderService` signatures (verified in source)

The pseudo-code below uses the **real** API. `CoderService.upsertX` methods take **positional arguments**, not an options object. Return type is `PromotionChanges` from `packages/common/src/types/promotion.ts`, *not* a `{ dashboard, created }` shape — the tool implementation translates `PromotionChanges` into a stable structured response.

```ts
// Real signatures — see packages/backend/src/services/CoderService/CoderService.ts

class CoderService {
    async upsertChart(
        user: SessionUser,
        projectUuid: string,
        slug: string,
        chartAsCode: ChartAsCode,
        skipSpaceCreate?: boolean,
        publicSpaceCreate?: boolean,
        force?: boolean,
        spaceNames?: Record<string, string>,
    ): Promise<PromotionChanges>;

    async upsertSqlChart(
        user: SessionUser,
        projectUuid: string,
        slug: string,
        sqlChartAsCode: SqlChartAsCode,
        skipSpaceCreate?: boolean,
        publicSpaceCreate?: boolean,
        force?: boolean,
        spaceNames?: Record<string, string>,
    ): Promise<PromotionChanges>;

    async upsertDashboard(
        user: SessionUser,
        projectUuid: string,
        slug: string,
        dashboardAsCode: DashboardAsCode,
        skipSpaceCreate?: boolean,
        publicSpaceCreate?: boolean,
        force?: boolean,
        spaceNames?: Record<string, string>,
    ): Promise<PromotionChanges>;

    async getOrCreateSpace(
        projectUuid: string,
        spaceSlug: string,
        user: SessionUser,
        skipSpaceCreate?: boolean,
        publicSpaceCreate?: boolean,
        spaceNames?: Record<string, string>,
    ): Promise<{ space: SpaceSummaryBase; created: boolean }>;
}

// PromotionChanges — see packages/common/src/types/promotion.ts
export type PromotionChanges = {
    spaces:     { action: PromotionAction; data: PromotedSpace }[];
    dashboards: { action: PromotionAction; data: PromotedDashboard }[];
    charts:     { action: PromotionAction; data: PromotedChart }[];
    sqlCharts?: { action: PromotionAction; data: PromotedSqlChart }[];
};
```

`PromotionAction` is one of `'create' | 'update' | 'no_changes' | 'delete'`. The MCP tool flattens this into a stable structured response.

## Anatomy of a single write tool — `upsert_dashboard_as_code`

```ts
// packages/backend/src/protopie/mcp/writeTools/upsertDashboardAsCode.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DashboardAsCode, PromotionChanges } from '@lightdash/common';
import { requireMcpWrite } from '../shared/requireMcpWrite';
import type { WriteToolDeps } from '../shared/types';
import { writeAnnotations } from '../shared/annotations';

const dashboardAsCodeSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    slug: z.string().min(1).describe('Stable slug used to upsert by'),
    spaceSlug: z.string().min(1).describe('Slug of the space the dashboard lives in (created if missing)'),
    tabs: z.array(z.any()).default([]),
    tiles: z.array(z.any()).describe('Dashboard tiles; chart tiles reference by `chartSlug`, not UUID'),
    filters: z.any().optional(),
    parameters: z.any().optional(),
    version: z.number().int().default(1),
    contentType: z.literal('dashboard').optional(),
});

const inputSchema = z.object({
    projectUuid: z.string().uuid().optional()
        .describe('Project UUID. If omitted, uses the active project set via `set_project`.'),
    dashboard: dashboardAsCodeSchema,
    options: z.object({
        skipSpaceCreate: z.boolean().default(false),
        publicSpaceCreate: z.boolean().default(false),
        force: z.boolean().default(false)
            .describe('Bypass version-conflict checks when re-applying changes'),
    }).optional(),
}).describe(
    'Create or update a Lightdash dashboard via content-as-code. Idempotent on (projectUuid, slug). ' +
    'Tile chart references are by slug; UUIDs are resolved automatically.',
);

const outputSchema = z.object({
    dashboardUuid: z.string().uuid().nullable(),
    slug: z.string(),
    url: z.string().url().nullable(),
    spaceSlug: z.string(),
    actions: z.object({
        dashboard: z.enum(['create', 'update', 'no_changes', 'delete']),
        charts: z.array(z.object({
            slug: z.string(), action: z.enum(['create', 'update', 'no_changes', 'delete']),
        })),
        spaces: z.array(z.object({
            slug: z.string(), action: z.enum(['create', 'update', 'no_changes', 'delete']),
        })),
    }).describe('Per-entity action summary derived from PromotionChanges'),
});

function summarizeChanges(
    slug: string,
    changes: PromotionChanges,
    siteUrl: string,
    projectUuid: string,
) {
    const dashboardEntry = changes.dashboards.find((d) => d.data.slug === slug);
    return {
        dashboardUuid: dashboardEntry?.data.dashboardUuid ?? null,
        slug,
        url: dashboardEntry?.data.dashboardUuid
            ? `${siteUrl}/projects/${projectUuid}/dashboards/${dashboardEntry.data.dashboardUuid}/view`
            : null,
        spaceSlug: dashboardEntry?.data.spaceSlug ?? '',
        actions: {
            dashboard: dashboardEntry?.action ?? 'no_changes',
            charts: changes.charts.map((c) => ({ slug: c.data.slug, action: c.action })),
            spaces: changes.spaces.map((s) => ({ slug: s.data.slug, action: s.action })),
        },
    };
}

export const upsertDashboardAsCodeTool = {
    name: 'upsert_dashboard_as_code',

    register(server: McpServer, deps: WriteToolDeps) {
        server.registerTool('upsert_dashboard_as_code', {
            description: inputSchema.description!,
            inputSchema: inputSchema.shape,
            outputSchema: outputSchema.shape,
            annotations: writeAnnotations({ idempotent: true }),
        }, async (toolArgs, { authInfo }) => {
            requireMcpWrite(authInfo);
            const args = inputSchema.parse(toolArgs);
            const account = deps.accountFromAuthInfo(authInfo);

            const projectUuid = args.projectUuid
                ?? await deps.activeProject(account);

            // Positional args — NOT an options object
            const changes: PromotionChanges = await deps.coderService.upsertDashboard(
                account.user!,
                projectUuid,
                args.dashboard.slug,
                args.dashboard as DashboardAsCode,
                args.options?.skipSpaceCreate,
                args.options?.publicSpaceCreate,
                args.options?.force,
                undefined,                    // spaceNames — leave undefined for v1
            );

            return {
                content: [],
                structuredContent: summarizeChanges(
                    args.dashboard.slug,
                    changes,
                    deps.lightdashConfig.siteUrl,
                    projectUuid,
                ),
            };
        });
    },
};
```

Key properties:

- **Idempotent.** Calling twice with the same args produces `action: 'no_changes'`. The agent doesn't have to track whether a slug exists.
- **Slug-not-UUID.** All references are by slug. UUID resolution lives inside `CoderService`.
- **No new business logic.** We use `z.any()` for `tiles`, `filters`, `parameters` — the underlying service validates them. We trust `ChartAsCode`, `SqlChartAsCode`, `DashboardAsCode` as the canonical shapes (defined in `packages/common/src/types/coder.ts`).
- **Structured response derived from `PromotionChanges`.** The tool always returns the action summary — `'create' | 'update' | 'no_changes'` for each entity touched — so the agent knows what actually happened.

## MCP tool annotations

Every tool ships annotations so clients understand the risk profile:

```ts
// packages/backend/src/protopie/mcp/shared/annotations.ts
export const readAnnotations = () => ({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
});

export const writeAnnotations = (opts: { idempotent: boolean } = { idempotent: true }) => ({
    readOnlyHint: false,
    destructiveHint: false,            // upserts are not destructive
    idempotentHint: opts.idempotent,
});

export const destructiveAnnotations = () => ({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
});
```

When `delete_content` is added later, it uses `destructiveAnnotations()` and requires an explicit `confirm: true` argument.

## `get_content_as_code_schema` — the agent's reference

LLMs build correct payloads when they can see the shape. We expose a static tool that returns concise JSON-schema-ish guidance for `ChartAsCode`, `SqlChartAsCode`, `DashboardAsCode`, with **examples** for cartesian, table, big-number, and dashboard tiles:

```ts
{
    chartAsCode: { /* schema */, example: { name: 'Sales by Month', metricQuery: {...}, chartConfig: { type: 'cartesian', ... } } },
    sqlChartAsCode: { /* schema */, example: {...} },
    dashboardAsCode: { /* schema */, example: { tiles: [{ type: 'chart', chartSlug: 'sales-by-month', x: 0, y: 0, w: 12, h: 8 }, ...] } },
}
```

Source these examples from the already-generated `chart-as-code.schema.json` (built via `pnpm generate:chart-as-code-schema`).

## Per-tool design notes

### `list_spaces`

Uses the active project from MCP context, or accepts `project_uuid`. Returns UUID, name, slug/path (ltree), parent, access summary, content counts. Calls `SpaceService.list(projectUuid)`.

### `create_space`

Wraps `SpaceService.createSpace(projectUuid, user, space: CreateSpace)`. The `CreateSpace` type (from `packages/common/src/types/space.ts`):

```ts
export type CreateSpace = {
    name: string;
    inheritParentPermissions?: boolean;
    access?: Pick<SpaceShare, 'userUuid' | 'role'>[];   // role: SpaceMemberRole
    parentSpaceUuid?: string;                            // for nested spaces (ltree)
};
```

MCP input mirrors this exactly:

```ts
inputSchema = z.object({
    projectUuid: z.string().uuid(),
    name: z.string().min(1).max(200),
    parentSpaceUuid: z.string().uuid().optional(),
    inheritParentPermissions: z.boolean().default(true),
    access: z.array(z.object({
        userUuid: z.string().uuid(),
        role: z.enum(['viewer', 'editor', 'admin']),    // matches SpaceMemberRole
    })).default([]),
})
```

> **No `isPrivate` flag in `CreateSpace`.** Space privacy is *implied* by the access list: a space with no `access` entries and `inheritParentPermissions: false` is private to the creator. Group access is not part of `CreateSpace` — add a group member after creation via a dedicated tool if needed (deferred to v1.1).

### `update_space`

Wraps `SpaceService.updateSpace(user, spaceUuid, updateSpace: UpdateSpace)`. The `UpdateSpace` type:

```ts
export type UpdateSpace = {
    name: string;
    inheritParentPermissions?: boolean;
    projectMemberAccessRole?: SpaceMemberRole | null;   // when set, all project members get this role
    colorPaletteUuid?: string | null;
};
```

MCP input:

```ts
inputSchema = z.object({
    spaceUuid: z.string().uuid(),
    name: z.string().min(1).max(200),                    // required by UpdateSpace
    inheritParentPermissions: z.boolean().optional(),
    projectMemberAccessRole: z.enum(['viewer', 'editor', 'admin']).nullable().optional(),
})
```

> **Access-list mutation is not part of `UpdateSpace`.** Membership changes go through separate `SpaceService` methods (`addSpaceUserAccess`, `removeSpaceUserAccess`). We expose those as separate MCP tools only when the use case demands it; for v1 the LLM cannot change membership.

> No `delete_space` in v1. Spaces with content cannot be easily un-deleted; require human via UI.

### `upsert_chart_as_code`

Maps to `CoderService.upsertChart(user, projectUuid, slug, chartAsCode, skipSpaceCreate?, publicSpaceCreate?, force?, spaceNames?)` — positional args. Accepts the full `ChartAsCode` payload.

### `upsert_sql_chart_as_code`

Important: **SQL charts live in a separate table** (`saved_sql`) from regular saved charts (`saved_queries`). They have `sql + limit + config + chartKind` instead of `metricQuery + chartConfig`. The MCP tool surfaces this as a separate tool with `SqlChartAsCode` payload. Wraps `CoderService.upsertSqlChart`.

### `upsert_dashboard_as_code`

Wraps `CoderService.upsertDashboard`. Tile chart references use slugs (`chartSlug`, `sqlChartSlug`); the service resolves them to UUIDs. This means the **order of operations** for an agent is:

1. `upsert_chart_as_code` for each chart used → saves charts (and their slugs).
2. `upsert_dashboard_as_code` with tiles that reference those slugs.

If a referenced chart slug doesn't exist, the upsert errors cleanly; the LLM can recover by creating the missing chart and retrying.

### `get_charts_as_code` / `get_sql_charts_as_code` / `get_dashboards_as_code`

Read tools. Wrap the corresponding `CoderService` getters with pagination params. Useful for the agent to read an existing dashboard, modify it, and upsert it back.

## What we don't expose to LLMs

- `dashboard_tiles` row internals (only `DashboardAsCode` tile shapes).
- `saved_queries_versions` directly (versioning is implicit on upsert).
- `space_user_access` / `space_group_access` row management (use a separate dedicated tool if/when added).

The principle: anything that requires understanding Lightdash's internal table schema is **not** an MCP tool. Only the public content-as-code shapes are.

## Permissions matrix

| Tool | `mcp:read` | `mcp:write` | Service-layer CASL |
|------|------------|-------------|---------------------|
| `list_spaces` | ✓ | — | `view:Space` (inside `SpaceService`) |
| `get_*_as_code` | ✓ | — | `view:SavedChart` / `view:Dashboard` |
| `create_space` | — | ✓ | `create:Space` |
| `update_space` | — | ✓ | `manage:Space` |
| `upsert_*_as_code` | — | ✓ | `manage:ContentAsCode` |

Write tools always check **both** `mcp:write` (via `requireMcpWrite`) and the service-level subject (via the called service). Failing either is a `ForbiddenError`.

## Authentication

MCP requests authenticate via:

- **OAuth Bearer tokens** (preferred for IDE agents) — `oauthRouter.ts`. The OAuth grant flow includes the `mcp:write` scope only when the user explicitly approves it during authorization.
- **Personal Access Tokens** (PATs) — assigned `mcp:read` + `mcp:write` by default.
- **Service Account tokens** — assigned `mcp:read` + `mcp:write` by default.

All three go through the existing `McpService` middleware. We don't change anything in the auth layer.

## Audit trail

Every write tool emits `LightdashAnalytics.track({ event: 'mcp_write_tool.called', ... })` with `toolName`, `userUuid`, `projectUuid`, `targetSlug`, `created/updated/error`. Same shape as the existing `McpToolCallEvent` for read tools.

## Testing

**Unit:**
- Each tool's Zod schema accepts valid payloads, rejects malformed ones.
- `requireMcpWrite` rejects auth contexts without `mcp:write` scope.

**Service-level:**
- Upserting a new chart creates the expected `saved_queries` row + version.
- Upserting the same chart twice is idempotent (no second version row if the payload didn't change — or one new version if it did, per `CoderService` semantics).
- Upserting a dashboard with chart slugs resolves tiles to the right chart UUIDs.
- Missing spaces are auto-created when `skipSpaceCreate=false`.

**Integration (in-process MCP harness):**
- PAT-authenticated client creates a chart → dashboard.
- OAuth client with only `mcp:read` calls a write tool → `ForbiddenError`.
- Service-account client without `manage:ContentAsCode` → ForbiddenError surfaces from `CoderService`.

**E2E:**
- A scripted Claude Code session: `set_project` → `find_explores` → `find_fields` → `run_metric_query` (validate) → `upsert_chart_as_code` → `upsert_dashboard_as_code` → verify both exist via UI.

## Example agent transcript

```
User:   "Create a dashboard called 'Q2 Sales' in the 'sales' space. Add a chart
         showing total revenue per month from the `orders` explore."

Agent:  → tool: set_project(projectUuid: "...")
        → tool: find_explores(query: "orders")
        ← { explores: [{ name: "orders", ... }] }
        → tool: find_fields(exploreName: "orders", query: "revenue")
        ← { fields: [{ name: "orders.total_revenue", type: "metric" }, ...] }
        → tool: run_metric_query(...)         // validate the data shape
        ← { rows: [...] }
        → tool: upsert_chart_as_code({
              slug: "total-revenue-by-month",
              spaceSlug: "sales",
              dashboard: { name: "Total Revenue by Month", metricQuery: {...}, chartConfig: { type: "cartesian", ... } }
          })
        ← { chartUuid: "...", created: true }
        → tool: upsert_dashboard_as_code({
              dashboard: {
                  name: "Q2 Sales", slug: "q2-sales", spaceSlug: "sales",
                  tiles: [{ type: "chart", chartSlug: "total-revenue-by-month", x: 0, y: 0, w: 12, h: 8 }]
              }
          })
        ← { dashboardUuid: "...", url: "https://...", created: true }
```

## Rollout sequence

1. Add `requireMcpWrite` helper + scope-enforcement unit tests. **Ship alone first** — this makes the existing `mcp:read`/`mcp:write` scope distinction real, with no behavior change yet.
2. Add read tools: `list_spaces`, `get_*_as_code`, `get_content_as_code_schema`.
3. Add `upsert_chart_as_code`.
4. Add `upsert_dashboard_as_code`.
5. Add `upsert_sql_chart_as_code`.
6. Add `create_space` / `update_space`.
7. Document example payloads in our repo `docs/claude-docs/` + upstream contribution README.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| LLM creates 100 dashboards by mistake | Rate-limit at MCP middleware. Encourage "dry-run via `validate_*_as_code`" once that tool exists. |
| Slug collisions (Lightdash slugs are not unique — see Lightdash `CLAUDE.md`) | `CoderService.upsertX` uses `forceSlug` internally, which DOES allow collisions. Mitigate by recommending agents use long, descriptive slugs (e.g., `q2-sales-revenue-by-region-2026`). Document this in the tool description. |
| LLM expands access list via `update_space` (e.g., sets `projectMemberAccessRole: 'editor'`) | Tool description warns. `SpaceService.updateSpace` enforces `manage:Space` CASL ability — only callers who can manage the space at all can change membership semantics. |
| MCP `mcp:write` scope grants too much | Document explicitly in OAuth consent. Org admins can disable write tools entirely by setting an org-level flag (deferred — see [10-open-questions.md](./10-open-questions.md) E7). |

## Going upstream

These write tools are NOT Protopie-specific. After they stabilize in this fork, they're strong candidates for an upstream PR to Lightdash. Design choices that make this easy:

- All tools live in `packages/backend/src/protopie/mcp/` — extractable with `git mv`.
- Tool implementations only depend on `CoderService` + `SpaceService` (already public in Lightdash).
- The `requireMcpWrite` helper is general-purpose and should be promoted into the core MCP middleware when contributed back.

We design as if upstream from day one. The `protopie/` folder is just where we wrote them; the logic is not branded.
