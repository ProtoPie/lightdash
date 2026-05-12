export const PROTOPIE_MCP_OVERVIEW_URI = 'protopie://overview';

export const PROTOPIE_MCP_OVERVIEW_MARKDOWN = `# Protopie MCP Tools — Agent Operating Guide

This document is the canonical "how to use the Protopie MCP tools" reference.
Read it before invoking any \`protopie_*\` tool. Treat it as load-bearing —
following the recommended workflow avoids the common failure modes
(missing scopes, organization opt-out, slug mismatches, payload drift).

## What these tools do

They extend Lightdash's existing MCP server with **content-as-code** read and
write capabilities plus a guarded REST API bridge for UI-backed resources that
do not yet have dedicated MCP tools. Dedicated write tools wrap Lightdash's
\`CoderService\`/\`SpaceService\`; the API bridge calls Lightdash's existing
REST controllers as the authenticated MCP user. We do not bypass any Lightdash
authorization.

## Tool catalogue

### Read (no scope required beyond \`mcp:read\`)
- \`protopie_get_overview\` — returns this document. Call it once per session.
- \`protopie_get_content_as_code_schema\` — JSON schemas for ChartAsCode,
  DashboardAsCode, and a hint for SqlChartAsCode. Call before constructing
  payloads.
- \`protopie_get_dashboards_as_code\` — export existing dashboards.
- \`protopie_get_charts_as_code\` — export existing saved charts.
- \`protopie_get_sql_charts_as_code\` — export existing SQL charts.
- \`lightdash_list_api_endpoints\` — search Lightdash's generated OpenAPI
  routes for UI-backed resources.
- \`lightdash_api_get\` — call a read-only \`GET /api/v1/*\` or
  \`GET /api/v2/*\` endpoint as the MCP user.

### Write (require \`mcp:write\` scope AND organization opt-in)
- \`protopie_upsert_dashboard_as_code\` — create or update a dashboard.
- \`protopie_upsert_chart_as_code\` — create or update a saved chart.
- \`protopie_upsert_sql_chart_as_code\` — create or update a SQL chart.
- \`protopie_create_space\` — get or create a space by content-as-code path.
- \`protopie_update_space\` — update a space's metadata.
- \`lightdash_api_mutate\` — call \`POST\`, \`PUT\`, \`PATCH\`, or \`DELETE\`
  endpoints for UI-backed resources that do not yet have dedicated tools.

## Permission model (three layers — every layer must pass)

1. **OAuth scope \`mcp:write\`**: must be on the access token. PAT and
   service-account tokens are issued with both \`mcp:read\` and \`mcp:write\`
   by Lightdash today; OAuth bearer tokens depend on the consent screen.
2. **Organization opt-in**: org admins must set
   \`mcp_write_enabled = true\` via
   \`PATCH /api/v1/protopie/mcp-settings\` (default: \`false\`).
3. **Per-call CASL ability check**: enforced inside \`CoderService\`,
   \`SpaceService\`, or the target REST controller. The caller must have the
   same Lightdash permission the UI/API action normally requires.

Forbidden errors will surface from whichever layer rejects first.

## Recommended workflow

For any non-trivial change, follow this order. The MCP tools are idempotent
by slug, so the workflow is safe to retry.

1. **Establish project context** — call \`set_project\` once with the target
   project UUID, or pass \`projectUuid\` to every tool.
2. **Read schemas** — call \`protopie_get_content_as_code_schema\` to see
   the exact \`ChartAsCode\` / \`DashboardAsCode\` shapes you must produce.
3. **Discover existing fields and data** — use the core read tools
   (\`find_explores\`, \`find_fields\`, \`run_metric_query\`, \`run_sql\`)
   to confirm dimensions/metrics exist and that your query returns rows.
4. **Read existing content** — if you intend to modify a dashboard, call
   \`protopie_get_dashboards_as_code\` first and patch the returned payload.
5. **Use the API bridge for uncovered UI resources** — call
   \`lightdash_list_api_endpoints\` to find the route, then
   \`lightdash_api_get\` or \`lightdash_api_mutate\`. Prefer dedicated tools
   when they exist; use the API bridge to avoid waiting for one-off wrappers.
6. **Make space slugs explicit** — every chart/dashboard must reference a
   \`spaceSlug\`. If the slug does not exist, the upsert will create the
   space (\`skipSpaceCreate: false\`, default). Use slash-separated paths
   for nested spaces, e.g. \`protopie/sales-ops\`.
7. **Upsert charts before dashboards** — dashboard tiles reference charts
   by slug. CoderService resolves slug → UUID for you. If the slug is
   absent, the tile fails to render — create the chart first.
8. **Use stable, prefixed slugs** — start every Protopie slug with
   \`protopie-\` to avoid colliding with content from other workflows.
   Lightdash slugs are NOT uniquely enforced at the database level.
9. **Inspect promotion changes** — every write tool returns a summary of
   actions per entity (create/update/no_changes/delete). Verify the
   actions match your intent before declaring success.
10. **Idempotency** — re-running the same upsert with identical payloads
   produces \`no_changes\`. Re-run safely after partial failures.

## Common gotchas

- **\`ForbiddenError: MCP tool requires the mcp:write scope.\`** Your access
  token does not carry \`mcp:write\`. Re-authenticate through the OAuth
  flow with the scope granted; or use a PAT/service account.
- **\`ForbiddenError: MCP write tools are disabled for this organization.\`**
  Org admin must opt-in via \`PATCH /api/v1/protopie/mcp-settings\` with
  \`{ "mcpWriteEnabled": true }\`.
- **\`No project context set.\`** Either pass \`projectUuid\` to the tool
  call or invoke \`set_project\` first.
- **Slug mismatch.** The \`slug\` argument and \`<entity>.slug\` inside the
  payload must agree, or you must pass \`slug\` separately. If both are
  missing the tool errors with \`<Type> slug is required.\`.
- **Stale schemas.** If a tool rejects your payload as malformed, call
  \`protopie_get_content_as_code_schema\` again — Lightdash schemas can
  evolve between releases.
- **Blocked API bridge path.** The API bridge intentionally blocks auth,
  token, credential, service-account, SCIM, file, support, and MCP paths.
  Add a dedicated reviewed tool if one of those resources ever needs MCP
  support.

## Auditing

Every successful or failed write tool call, including \`lightdash_api_mutate\`,
is recorded in
\`protopie_mcp_audit_log\` with: organization, project, user, tool name,
input summary (slug only), outcome, and error message (on failure).
Payloads are intentionally NOT logged (they can contain PII via tile
titles). Use the audit log to trace changes after the fact.

## Going further

- Lightdash content-as-code shapes: \`@lightdash/common\` exports
  \`ChartAsCode\`, \`SqlChartAsCode\`, \`DashboardAsCode\`, and their
  JSON schemas.
- Operational doc: \`docs/protopie-docs/07-mcp-server-extension.md\` in
  the Lightdash fork.
- This guide can also be fetched as an MCP resource at
  \`${PROTOPIE_MCP_OVERVIEW_URI}\` if your client supports resources.
`;
