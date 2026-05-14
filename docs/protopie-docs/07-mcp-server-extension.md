# 07 — MCP Server Extension

> Current state: the Lightdash fork now extends the existing MCP server from `packages/backend/src/ee/services/McpService/McpService.ts` with Protopie-owned tools registered from `packages/backend/src/protopie/mcp/registerProtopieMcpTools.ts`.

The MCP extension is not only for the churn-score project. It is a generic authoring and inspection surface for Lightdash content, plus a read-only window into the `ProtoPie/data-modeling` dbt repository so agents understand the warehouse models they are building dashboards on.

## What is implemented

The registration entrypoint is:

```ts
// packages/backend/src/protopie/mcp/registerProtopieMcpTools.ts
export const registerProtopieMcpTools = (deps: ProtopieMcpToolDeps): void => {
    // registers Protopie tools on the existing Lightdash MCP server
};
```

`McpService.ts` imports and calls this entrypoint after the existing Lightdash MCP tools are registered.

The extension adds these tools:

| Category | Tool | Purpose |
|----------|------|---------|
| Operating guide | `protopie_get_overview` | Returns the workflow, permission model, tool catalogue, and gotchas. Agents should call this once per session. |
| Operating guide | `protopie://overview` resource | Same guide as a best-effort MCP resource for clients that support resources. |
| Content-as-code help | `protopie_get_content_as_code_schema` | Returns chart/dashboard schema hints. |
| Content-as-code help | `protopie_get_chart_examples` | Returns minimal chart, SQL chart, and dashboard examples. |
| dbt source context | `protopie_dbt_list_files` | Lists allowlisted files from the data-modeling repo. |
| dbt source context | `protopie_dbt_get_file` | Reads one allowlisted dbt file. |
| dbt source context | `protopie_dbt_search_files` | Searches allowlisted dbt paths, optionally including file contents. |
| Lightdash API bridge | `lightdash_list_api_endpoints` | Lists available generated OpenAPI endpoints. |
| Lightdash API bridge | `lightdash_api_get` | Calls a read-only Lightdash REST API path as the authenticated MCP user. |
| Lightdash API bridge | `lightdash_api_mutate` | Calls a write-capable Lightdash REST API path as the authenticated MCP user. |
| Content-as-code read | `protopie_get_dashboards_as_code` | Exports dashboards from `CoderService`. |
| Content-as-code read | `protopie_get_charts_as_code` | Exports saved charts from `CoderService`. |
| Content-as-code read | `protopie_get_sql_charts_as_code` | Exports SQL charts from `CoderService`. |
| Content-as-code write | `protopie_upsert_dashboard_as_code` | Creates or updates dashboards by slug through `CoderService`. |
| Content-as-code write | `protopie_upsert_chart_as_code` | Creates or updates saved charts by slug through `CoderService`. |
| Content-as-code write | `protopie_upsert_sql_chart_as_code` | Creates or updates SQL charts by slug through `CoderService`. |
| Space write | `protopie_create_space` | Gets or creates a Lightdash space by content-as-code path. |
| Space write | `protopie_update_space` | Updates space metadata through `SpaceService`. |

There is no destructive delete/archive MCP tool in v1. Deleting content should stay in the UI until we add explicit confirmation semantics and a stronger audit UX.

## Why CoderService

The content tools wrap Lightdash's existing content-as-code layer (`CoderService`) instead of calling raw dashboard/chart service methods.

That gives us:

- Slug-based idempotency for agents that retry the same request.
- Existing Lightdash validation and permission checks.
- Dashboard tile references by chart slug, resolved by the same code path as the `lightdash upload` workflow.
- Promotion/change summaries that are easier for agents to inspect.

This is the right base for agent-driven dashboard authoring.

## Folder layout

Current implementation:

```text
packages/backend/src/protopie/mcp/
├── registerProtopieMcpTools.ts          ← tool registration entrypoint
└── shared/
    ├── audit.ts                         ← audit wrapper for write tools
    ├── auth.ts                          ← mcp:write + org opt-in checks
    ├── dbtRepository.ts                 ← local/GitHub dbt file access
    ├── examples.ts                      ← reusable chart/dashboard examples
    ├── overview.ts                      ← MCP operating guide text
    ├── promotionChanges.ts              ← PromotionChanges response summary
    ├── respond.ts                       ← JSON response helper
    └── types.ts                         ← dependency and argument types
```

This keeps Protopie-owned code isolated while the core Lightdash touch point stays small.

## Permission model

Writes require three checks:

| Layer | Check | Where |
|-------|-------|-------|
| OAuth scope | The MCP token must include `mcp:write`. | `requireMcpWriteScope()` |
| Org opt-in | The org must have MCP writes enabled. | `requireOrganizationMcpWriteEnabled()` |
| Lightdash permissions | The user must have the underlying Lightdash ability, such as content-as-code or space management. | `CoderService` / `SpaceService` |

Read-only tools still require a valid authenticated MCP session, but do not require the org write toggle.

### Admin toggle

The org-level toggle is exposed through:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/protopie/mcp-settings` | Read current MCP write setting. |
| PATCH | `/api/v1/protopie/mcp-settings` | Update `mcpWriteEnabled`. |

Frontend location:

```text
Settings → Organization settings → Integrations → Protopie MCP
URL: /generalSettings/integrations
```

Only users that can `manage` the `Organization` see the Protopie MCP settings panel in the UI.

## API bridge guardrails

The generic API bridge exists because users can perform many Lightdash UI actions that do not deserve a dedicated MCP tool yet.

Allowed:

- Relative `/api/v1/*` and `/api/v2/*` paths only.
- `GET` through `lightdash_api_get`.
- `POST`, `PUT`, `PATCH`, `DELETE` through `lightdash_api_mutate`, with write permission checks.

Blocked:

- MCP endpoint calls.
- OAuth/login/logout paths.
- Personal access token paths.
- Warehouse credential paths.
- Service-account, SCIM, file, and support paths.
- Absolute URLs.

The bridge should not be used for auth, credential, or token management.

## dbt source knowledge

The MCP server can read dbt source files for agent context.

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

Use a fine-grained GitHub PAT with read-only access to the `ProtoPie/data-modeling` repository: Metadata read-only and Contents read-only. The token is never returned by MCP responses.

## Client setup

Dev Lightdash MCP endpoint:

```bash
codex mcp add lightdash-mcp --url https://lightdash-dev.protopie.io/api/v1/mcp
codex mcp login lightdash-mcp --scopes read,write,mcp:read,mcp:write
```

Local endpoint:

```bash
codex mcp add lightdash --url http://localhost:3000/api/v1/mcp
codex mcp login lightdash --scopes read,write,mcp:read,mcp:write
```

Claude Desktop can connect to the same HTTP endpoint through its connector settings. Use the Lightdash URL ending in `/api/v1/mcp`; the OAuth browser flow signs the user into Lightdash/Okta and grants the MCP scopes.

## Recommended agent workflow

1. Call `set_project` with the target Lightdash project UUID.
2. Call `protopie_get_overview`.
3. Use `protopie_dbt_search_files` / `protopie_dbt_get_file` to understand dbt marts and dimensions.
4. Use Lightdash read tools such as `find_explores`, `find_fields`, `run_metric_query`, and `run_sql` to validate field identifiers and query shape.
5. Call `protopie_get_chart_examples`.
6. Upsert charts with `protopie_upsert_chart_as_code` or `protopie_upsert_sql_chart_as_code`.
7. Upsert the dashboard with `protopie_upsert_dashboard_as_code`.
8. Use `lightdash_api_get` or `lightdash_api_mutate` only when there is no dedicated tool.

## Validation checklist

- `MCP_ENABLED=true` is present in the app environment.
- Client can complete OAuth login and tool discovery.
- `protopie_get_overview` returns guide text.
- `protopie_dbt_list_files` shows files from `ProtoPie/data-modeling` in dev/prod.
- Write tool without `mcp:write` fails.
- Write tool with `mcp:write` but org toggle off fails with "MCP write tools are disabled for this organization."
- Admin enables the toggle at `/generalSettings/integrations`.
- `protopie_create_space` can create a test space.
- `protopie_upsert_chart_as_code` and `protopie_upsert_dashboard_as_code` create visible Lightdash content.
