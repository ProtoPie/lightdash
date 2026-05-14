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
\`CoderService\`/\`SpaceService\`; the API bridge calls Lightdash's REST API
over HTTP as the authenticated MCP user. We do not bypass any Lightdash
authorization.

## Tool catalogue

### Read (no scope required beyond \`mcp:read\`)
- \`protopie_get_overview\` — returns this document. Call it once per session.
- \`protopie_get_content_as_code_schema\` — JSON schemas for ChartAsCode,
  DashboardAsCode, and a hint for SqlChartAsCode. Call before constructing
  payloads.
- \`protopie_get_chart_examples\` — worked, minimal-but-valid sample
  payloads (bar / table / big-number / SQL chart / dashboard). Use these
  as copy-and-patch templates instead of building from the schema alone.
- \`protopie_dbt_list_files\` — list allowlisted files in the
  \`ProtoPie/data-modeling\` dbt repository.
- \`protopie_dbt_get_file\` — read one allowlisted dbt source file.
- \`protopie_dbt_search_files\` — search allowlisted dbt file paths, and
  optionally file contents.
- \`protopie_get_dashboards_as_code\` — export existing dashboards.
- \`protopie_get_charts_as_code\` — export existing saved charts.
- \`protopie_get_sql_charts_as_code\` — export existing SQL charts.
- \`lightdash_list_api_endpoints\` — search Lightdash's generated OpenAPI
  routes for UI-backed resources.
- \`lightdash_api_get\` — call a read-only \`GET /api/v1/*\` or
  \`GET /api/v2/*\` endpoint as the MCP user.

### Core Lightdash MCP tools (already part of \`McpService\`)
These are the bread and butter for **discovering dbt models, warehouse
fields, and validating queries** before generating a chart:
- \`set_project\` / \`list_projects\` / \`get_current_project\` — project
  context. Required before discovery.
- \`list_explores\` — list every dbt model surfaced as a Lightdash explore.
- \`find_explores\` — semantic search across explores; returns explore
  metadata AND the field list.
- \`find_fields\` — semantic search for dimensions/metrics inside an
  explore; returns descriptions, types, formats.
- \`search_field_values\` — distinct values of a dimension (for filter
  UIs). Use before adding a filter to a chart.
- \`run_metric_query\` — execute a metric query against the warehouse and
  return a chart/table result. Use this to verify a chart's query before
  upserting.
- \`run_sql\` — execute raw SQL. Use for SQL charts.
- \`find_content\` — search dashboards / charts / spaces.
- \`list_verified_content\` — list verified dashboards / charts.

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
2. **Inspect the project** (optional but useful) — call
   \`lightdash_api_get { "path": "/api/v1/projects/<projectUuid>" }\` to
   see project metadata including warehouse type (Redshift, BigQuery,
   Snowflake, Postgres, DuckDB). The warehouse type affects SQL dialect
   for \`run_sql\` and SQL charts.
3. **Discover dbt models (Lightdash explores)** —
   \`list_explores\` for the full catalogue, or \`find_explores\` for
   semantic search. Each result is a dbt model with its table name,
   description, tags, and joined tables.
4. **Discover fields inside an explore** —
   \`find_fields { "table": "<exploreName>",
   "fieldSearchQueries": [{ "label": "<topic>" }], "page": 1 }\`
   returns dimensions and metrics with descriptions and types. For the
   FULL explore structure (joins, custom dimensions, sql expressions), use
   the API bridge: \`lightdash_api_get { "path":
   "/api/v1/projects/<projectUuid>/explores/<exploreId>" }\`.
5. **Find filter values** — \`search_field_values\` returns distinct
   sample values for a dimension. Use before adding a filter to a chart
   to ensure the value exists.
6. **Validate the underlying query** — call \`run_metric_query\` with the
   MCP tool's query shape (\`title\`, \`description\`, \`queryConfig\`,
   \`chartConfig\`, \`customMetrics\`, \`tableCalculations\`, \`filters\`).
   Use this to verify the query before saving it as a chart. For SQL
   charts, use \`run_sql\` instead.
7. **Read dbt source when needed** — if compiled Lightdash metadata is not
   enough, use \`protopie_dbt_list_files\`, \`protopie_dbt_search_files\`,
   and \`protopie_dbt_get_file\` to inspect allowlisted raw dbt files from
   the data-modeling repository.
8. **Read schemas + examples** — call
   \`protopie_get_content_as_code_schema\` for the formal types, and
   \`protopie_get_chart_examples\` for ready-to-patch templates. The
   examples are the fastest path to a valid payload.
9. **Read existing content** — if you intend to modify a dashboard, call
   \`protopie_get_dashboards_as_code\` first and patch the returned
   payload. Same for \`protopie_get_charts_as_code\`.
10. **Use the API bridge for uncovered UI resources** — call
   \`lightdash_list_api_endpoints\` to find the route, then
   \`lightdash_api_get\` or \`lightdash_api_mutate\`. Prefer dedicated tools
   when they exist; use the API bridge to avoid waiting for one-off
   wrappers.
11. **Make space slugs explicit** — every chart/dashboard must reference a
   \`spaceSlug\`. If the slug does not exist, the upsert will create the
   space (\`skipSpaceCreate: false\`, default). Use slash-separated paths
   for nested spaces, e.g. \`protopie/sales-ops\`.
12. **Upsert charts before dashboards** — dashboard tiles reference charts
   by slug. CoderService resolves slug → UUID for you. If the slug is
   absent, the tile fails to render — create the chart first.
13. **Use stable, prefixed slugs** — start every Protopie slug with
   \`protopie-\` to avoid colliding with content from other workflows.
   Lightdash slugs are NOT uniquely enforced at the database level.
14. **Inspect promotion changes** — every write tool returns a summary of
   actions per entity (create/update/no_changes/delete). Verify the
   actions match your intent before declaring success.
15. **Idempotency** — re-running the same upsert with identical payloads
   produces \`no_changes\`. Re-run safely after partial failures.

## Cheat sheet — generating a chart from a natural-language request

User says: "Create a Lightdash chart of total revenue by month."

\`\`\`
1. set_project { projectUuid: "<uuid>" }
2. find_explores { searchQuery: "revenue by month" }            → pick \`orders\`
3. find_fields {
       table: "orders",
       fieldSearchQueries: [{ label: "Total Revenue" }],
       page: 1
   }                                                            → \`orders_total_revenue\`
4. find_fields {
       table: "orders",
       fieldSearchQueries: [{ label: "Order Month" }],
       page: 1
   }                                                            → \`orders_order_month\`
5. run_metric_query {
       title: "Total Revenue by Month",
       description: "Validation query before saving the chart.",
       queryConfig: {
           exploreName: "orders",
           dimensions: ["orders_order_month"],
           metrics: ["orders_total_revenue"],
           sorts: [{ fieldId: "orders_order_month", descending: false, nullsFirst: null }],
           limit: 12
       },
       chartConfig: {
           defaultVizType: "bar",
           xAxisDimension: "orders_order_month",
           yAxisMetrics: ["orders_total_revenue"],
           groupBy: null,
           xAxisType: "time",
           stackBars: false,
           lineType: null,
           funnelDataInput: null,
           xAxisLabel: "Month",
           yAxisLabel: "Total Revenue",
           secondaryYAxisMetric: null,
           secondaryYAxisLabel: null
       },
       customMetrics: [],
       tableCalculations: [],
       filters: null
   }                                                            → confirms rows
6. protopie_get_chart_examples                                  → copy \`barChart\` template
7. protopie_upsert_chart_as_code {
       chart: { ...patchedTemplate, slug: "protopie-revenue-by-month" }
   }                                                            → action: 'create'
\`\`\`

The same pattern works for SQL charts (substitute \`run_sql\` and
\`protopie_upsert_sql_chart_as_code\`) and dashboards (assemble tile slugs
after creating charts, then call \`protopie_upsert_dashboard_as_code\`).

## Useful API bridge endpoints for chart generation

Many discovery surfaces are not yet wrapped in dedicated MCP tools, but
\`lightdash_api_get\` exposes them as-is. These are the highest-value
endpoints when generating charts:

- \`/api/v1/projects/<projectUuid>\` — project metadata, including the
  warehouse connection type (\`postgres\`, \`redshift\`, \`bigquery\`,
  \`snowflake\`, \`databricks\`, \`trino\`, \`duckdb\`). Pick SQL dialect
  accordingly when writing a SQL chart.
- \`/api/v1/projects/<projectUuid>/explores\` — list of all explores
  (dbt models) with names, tags, descriptions, and base tables.
- \`/api/v1/projects/<projectUuid>/explores/<exploreId>\` — full explore
  with every dimension and metric (including SQL expressions, types,
  formats, joins, custom dimensions). Best one-shot for chart
  generation when you need typed field info.
- \`/api/v1/projects/<projectUuid>/dataCatalog\` — catalog search across
  fields and tables, with descriptions and tags.
- \`/api/v1/projects/<projectUuid>/spaces\` — list of spaces; useful
  before creating content to confirm the target space exists.
- \`/api/v1/projects/<projectUuid>/dashboards\` — list of dashboards in
  the project (UUIDs, names, slugs).
- \`/api/v1/projects/<projectUuid>/charts\` — list of saved charts.
- \`/api/v1/projects/<projectUuid>/sqlRunner/saved\` — list saved SQL
  charts. Use \`/api/v1/projects/<projectUuid>/sqlRunner/tables\` and
  \`/api/v1/projects/<projectUuid>/sqlRunner/fields\` for SQL runner
  warehouse metadata.

The API bridge always calls these endpoints as **the MCP user** — they
respect Lightdash's normal CASL permissions, so a viewer-only token will
get a 403 from write-shaped endpoints just like in the UI.

## dbt source repository access

Lightdash MCP knows the compiled dbt layer through Lightdash projects:
\`list_explores\`, \`find_explores\`, \`find_fields\`, \`dataCatalog\`, and
warehouse query tools. For raw dbt source context, this fork also exposes
read-only \`protopie_dbt_*\` tools through the same Lightdash MCP server.

The dbt source reader supports two modes:

1. **Local development** — set \`PROTOPIE_DBT_LOCAL_PATH\` to a checked-out
   data-modeling repo, for example
   \`/Users/mamur/Documents/projects/data-modeling\`.
2. **Dev/prod** — set \`PROTOPIE_DBT_GITHUB_TOKEN\` to a fine-grained
   GitHub PAT with read-only access to \`ProtoPie/data-modeling\`.

Optional env vars:

- \`PROTOPIE_DBT_GITHUB_OWNER\` — defaults to \`ProtoPie\`.
- \`PROTOPIE_DBT_GITHUB_REPO\` — defaults to \`data-modeling\`.
- \`PROTOPIE_DBT_GITHUB_REF\` — defaults to \`main\`.
- \`PROTOPIE_DBT_ALLOWED_PATHS\` — comma-separated allowlist. Defaults to
  \`models,marts,macros,seeds,snapshots,analyses,analysis,tests,dbt_project.yml,packages.yml,selectors.yml,exposures.yml,README.md\`.

Agents should use:

1. \`protopie_dbt_search_files\` to find relevant marts/macros/YAML docs.
2. \`protopie_dbt_get_file\` to read the exact source file.
3. Lightdash discovery and warehouse tools to validate compiled model
   availability and query behavior before creating charts.

The dbt tools are read-only and path allowlisted. They never write to GitHub,
never expose the PAT, and refuse paths outside the configured allowlist.

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
