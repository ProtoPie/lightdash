import {
    ChartAsCode,
    chartAsCodeSchema,
    DashboardAsCode,
    dashboardAsCodeSchema,
    ForbiddenError,
    ParameterError,
    SqlChartAsCode,
} from '@lightdash/common';
// eslint-disable-next-line import/extensions
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
    ServerNotification,
    ServerRequest,
    // eslint-disable-next-line import/extensions
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import apiSpec from '../../generated/swagger.json';
import Logger from '../../logging/logger';
import { withMcpWriteAudit } from './shared/audit';
import {
    requireMcpWriteScope,
    requireOrganizationMcpWriteEnabled,
} from './shared/auth';
import {
    PROTOPIE_MCP_OVERVIEW_MARKDOWN,
    PROTOPIE_MCP_OVERVIEW_URI,
} from './shared/overview';
import { summarizePromotionChanges } from './shared/promotionChanges';
import { jsonToolResponse } from './shared/respond';
import {
    type ProtopieMcpContext,
    type ProtopieMcpToolDeps,
    type UpdateSpaceArgs,
    type UpsertChartAsCodeArgs,
    type UpsertDashboardAsCodeArgs,
    type UpsertSqlChartAsCodeArgs,
} from './shared/types';

const OVERVIEW_HINT =
    'Call `protopie_get_overview` once per session for the full workflow guide. The recommended order is: `set_project` → `protopie_get_content_as_code_schema` → `find_fields`/`run_metric_query` to validate data → `protopie_upsert_chart_as_code` → `protopie_upsert_dashboard_as_code`. Write tools require the `mcp:write` scope AND organization opt-in via `PATCH /api/v1/protopie/mcp-settings`.';

const projectScopedReadSchema = z.object({
    projectUuid: z.string().uuid().optional(),
    ids: z.array(z.string().min(1)).optional(),
    offset: z.number().int().min(0).optional(),
    languageMap: z.boolean().optional(),
});

const apiQueryValueSchema = z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

const apiEndpointListSchema = z.object({
    search: z.string().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
    includeBlocked: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
});

const apiGetSchema = z.object({
    path: z.string().min(1),
    query: z.record(apiQueryValueSchema).optional(),
});

const apiMutateSchema = z.object({
    method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(1),
    query: z.record(apiQueryValueSchema).optional(),
    body: z.object({}).passthrough().optional(),
});

const writeOptionsShape = {
    projectUuid: z.string().uuid().optional(),
    slug: z.string().min(1).optional(),
    skipSpaceCreate: z.boolean().optional(),
    publicSpaceCreate: z.boolean().optional(),
    force: z.boolean().optional(),
    spaceNames: z.record(z.string()).optional(),
};

const dashboardInputSchema = z.object({
    ...writeOptionsShape,
    dashboard: z.object({ slug: z.string().min(1).optional() }).passthrough(),
});

const chartInputSchema = z.object({
    ...writeOptionsShape,
    chart: z.object({ slug: z.string().min(1).optional() }).passthrough(),
});

const sqlChartInputSchema = z.object({
    ...writeOptionsShape,
    sqlChart: z.object({ slug: z.string().min(1).optional() }).passthrough(),
});

const createSpaceSchema = z.object({
    projectUuid: z.string().uuid().optional(),
    spaceSlug: z.string().min(1),
    name: z.string().min(1).optional(),
    publicSpaceCreate: z.boolean().optional(),
});

const updateSpaceSchema = z.object({
    spaceUuid: z.string().uuid(),
    space: z
        .object({
            name: z.string().min(1),
            inheritParentPermissions: z.boolean().optional(),
            projectMemberAccessRole: z.string().nullable().optional(),
            colorPaletteUuid: z.string().uuid().nullable().optional(),
        })
        .passthrough(),
});

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_API_RESPONSE_CHARS = 200_000;
const SAFE_API_PREFIXES = ['/api/v1/', '/api/v2/'];
const BLOCKED_API_PATH_PREFIXES = [
    '/api/v1/mcp',
    '/api/v1/oauth',
    '/api/v1/login',
    '/api/v1/logout',
    '/api/v1/user/me/personal-access-tokens',
    '/api/v1/user/warehousecredentials',
    '/api/v1/org/warehouse-credentials',
    '/api/v1/service-accounts',
    '/api/v1/scim',
    '/api/v1/file',
    '/api/v1/support',
];

type ApiMethod = (typeof HTTP_METHODS)[number];
type ApiEndpointSpec = {
    operationId?: string;
    summary?: string;
    description?: string;
    tags?: string[];
};
type OpenApiSpec = {
    paths: Record<string, Partial<Record<ApiMethod, ApiEndpointSpec>>>;
};

const isBlockedApiPath = (pathname: string): boolean => {
    const normalizedPath = pathname.toLowerCase();
    return BLOCKED_API_PATH_PREFIXES.some(
        (blockedPrefix) =>
            normalizedPath === blockedPrefix ||
            normalizedPath.startsWith(`${blockedPrefix}/`),
    );
};

const assertAllowedApiPath = (pathname: string): void => {
    if (!SAFE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        throw new ParameterError(
            'Only relative /api/v1/* and /api/v2/* Lightdash API paths are allowed.',
        );
    }

    if (isBlockedApiPath(pathname)) {
        throw new ForbiddenError(
            `MCP API bridge does not allow calling protected auth/token/credential path: ${pathname}`,
        );
    }
};

const normalizeApiPath = (
    pathValue: string,
    query?: Record<
        string,
        string | number | boolean | (string | number | boolean)[]
    >,
): { pathname: string; search: string } => {
    if (/^https?:\/\//i.test(pathValue)) {
        throw new ParameterError(
            'Use a relative Lightdash API path, for example /api/v1/projects.',
        );
    }

    const parsed = new URL(pathValue, 'http://lightdash.local');
    assertAllowedApiPath(parsed.pathname);

    Object.entries(query ?? {}).forEach(([key, value]) => {
        parsed.searchParams.delete(key);
        const values = Array.isArray(value) ? value : [value];
        values.forEach((item) => {
            parsed.searchParams.append(key, String(item));
        });
    });

    return {
        pathname: parsed.pathname,
        search: parsed.search,
    };
};

const getAuthorizationHeader = (
    deps: ProtopieMcpToolDeps,
    context: ProtopieMcpContext,
): string => {
    const { account } = deps.getAccount(context);
    const token = context.authInfo?.token;

    if (!token) {
        throw new ForbiddenError('MCP request is missing authentication info.');
    }

    if (account.authentication.type === 'pat') {
        return token.startsWith('ApiKey ') ? token : `ApiKey ${token}`;
    }

    return token.startsWith('Bearer ') ? token : `Bearer ${token}`;
};

const extractProjectUuidFromPath = (pathname: string): string | null =>
    pathname.match(/\/projects\/([^/]+)/)?.[1] ?? null;

const apiToolResponse = (payload: unknown) => {
    const text = JSON.stringify(payload, null, 2);
    if (text.length <= MAX_API_RESPONSE_CHARS) {
        return {
            content: [
                {
                    type: 'text' as const,
                    text,
                },
            ],
        };
    }

    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(
                    {
                        truncated: true,
                        originalCharLength: text.length,
                        preview: text.slice(0, MAX_API_RESPONSE_CHARS),
                    },
                    null,
                    2,
                ),
            },
        ],
    };
};

const callLightdashApi = async ({
    deps,
    context,
    method,
    pathname,
    search,
    body,
}: {
    deps: ProtopieMcpToolDeps;
    context: ProtopieMcpContext;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    pathname: string;
    search: string;
    body?: Record<string, unknown>;
}) => {
    const requestUrl = new URL(`${pathname}${search}`, deps.siteUrl);
    const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: getAuthorizationHeader(deps, context),
    };

    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(requestUrl, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    const contentType = response.headers.get('content-type') ?? '';
    let responseBody: unknown = null;

    if (response.status !== 204) {
        if (contentType.includes('application/json')) {
            responseBody = (await response.json()) as unknown;
        } else {
            responseBody = await response.text();
        }
    }

    return apiToolResponse({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
    });
};

const listApiEndpoints = ({
    search,
    method,
    includeBlocked,
    limit = 100,
}: {
    search?: string;
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    includeBlocked?: boolean;
    limit?: number;
}) => {
    const normalizedSearch = search?.trim().toLowerCase();
    const { paths } = apiSpec as OpenApiSpec;
    const endpoints = Object.entries(paths).flatMap(([apiPath, operations]) =>
        HTTP_METHODS.flatMap((httpMethod) => {
            const operation = operations[httpMethod];
            if (!operation) return [];

            const blocked = isBlockedApiPath(apiPath);
            if (blocked && !includeBlocked) return [];

            const endpoint = {
                method: httpMethod.toUpperCase(),
                path: apiPath,
                operationId: operation.operationId,
                summary: operation.summary,
                tags: operation.tags ?? [],
                blocked,
            };
            return [endpoint];
        }),
    );

    const filteredEndpoints = endpoints.filter((endpoint) => {
        if (method && endpoint.method !== method) return false;
        if (!normalizedSearch) return true;

        return [
            endpoint.path,
            endpoint.method,
            endpoint.operationId,
            endpoint.summary,
            ...(endpoint.tags ?? []),
        ]
            .filter(Boolean)
            .some((value) =>
                String(value).toLowerCase().includes(normalizedSearch),
            );
    });

    return {
        total: filteredEndpoints.length,
        returned: Math.min(limit, filteredEndpoints.length),
        limit,
        blockedEndpointsOmitted: !includeBlocked,
        endpoints: filteredEndpoints.slice(0, limit),
    };
};

const resolveProjectUuid = async (
    deps: ProtopieMcpToolDeps,
    context: ProtopieMcpContext,
    projectUuid?: string,
): Promise<string> => projectUuid ?? deps.resolveProjectUuid(context);

const requireSlug = (
    explicitSlug: string | undefined,
    content: { slug?: string },
    type: string,
): string => {
    const slug = explicitSlug ?? content.slug;
    if (!slug) {
        throw new ParameterError(`${type} slug is required.`);
    }

    return slug;
};

const requireWriteAccess = async (
    deps: ProtopieMcpToolDeps,
    context: ProtopieMcpContext,
): Promise<{
    user: ReturnType<ProtopieMcpToolDeps['getAccount']>['user'];
    organizationUuid: string;
}> => {
    requireMcpWriteScope(context);
    const accountContext = deps.getAccount(context);
    await requireOrganizationMcpWriteEnabled(
        deps,
        accountContext.organizationUuid,
    );
    return {
        user: accountContext.user,
        organizationUuid: accountContext.organizationUuid,
    };
};

export const registerProtopieMcpTools = (deps: ProtopieMcpToolDeps): void => {
    deps.mcpServer.registerTool(
        'protopie_get_overview',
        {
            description:
                'Return the Protopie MCP operating guide: tool catalogue, three-layer permission model, recommended workflow, and common gotchas. Call this once per session before invoking any other `protopie_*` tool.',
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async () => ({
            content: [
                {
                    type: 'text' as const,
                    text: PROTOPIE_MCP_OVERVIEW_MARKDOWN,
                },
            ],
        }),
    );

    // Best-effort resource registration. Clients that don't support resources
    // (or older SDK versions) can still fetch the same content via the tool.
    try {
        deps.mcpServer.registerResource(
            'protopie-overview',
            PROTOPIE_MCP_OVERVIEW_URI,
            {
                title: 'Protopie MCP Operating Guide',
                description:
                    'Workflow, permissions, and gotchas for the Protopie content-as-code MCP tools.',
                mimeType: 'text/markdown',
            },
            async () => ({
                contents: [
                    {
                        uri: PROTOPIE_MCP_OVERVIEW_URI,
                        mimeType: 'text/markdown',
                        text: PROTOPIE_MCP_OVERVIEW_MARKDOWN,
                    },
                ],
            }),
        );
    } catch (error) {
        Logger.warn(
            `Failed to register Protopie MCP overview resource: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }

    deps.mcpServer.registerTool(
        'protopie_get_content_as_code_schema',
        {
            description: `Return the JSON schemas agents should use when creating or updating Lightdash content-as-code payloads. ${OVERVIEW_HINT}`,
            inputSchema: {},
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async () =>
            jsonToolResponse({
                chartAsCodeSchema,
                dashboardAsCodeSchema,
                sqlChartHint:
                    'Use the Lightdash SqlChartAsCode shape exported by @lightdash/common. The tool validates permissions through CoderService.',
                overviewUri: PROTOPIE_MCP_OVERVIEW_URI,
            }),
    );

    deps.mcpServer.registerTool(
        'lightdash_list_api_endpoints',
        {
            description:
                'List available Lightdash REST API endpoints from the generated OpenAPI spec. Use this before lightdash_api_get or lightdash_api_mutate when you need to perform a UI-backed action that does not have a dedicated MCP tool.',
            inputSchema: deps.getMcpCompatibleSchema(apiEndpointListSchema),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (rawArgs) => {
            const args = apiEndpointListSchema.parse(rawArgs);
            return jsonToolResponse(listApiEndpoints(args));
        },
    );

    deps.mcpServer.registerTool(
        'lightdash_api_get',
        {
            description:
                'Call a read-only Lightdash REST API endpoint as the authenticated MCP user. This covers UI resources that do not yet have dedicated MCP read tools. Only relative /api/v1/* and /api/v2/* paths are allowed; auth/token/credential paths are blocked.',
            inputSchema: deps.getMcpCompatibleSchema(apiGetSchema),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = apiGetSchema.parse(rawArgs);
            const context = extra as ProtopieMcpContext;
            const { pathname, search } = normalizeApiPath(
                args.path,
                args.query,
            );

            return callLightdashApi({
                deps,
                context,
                method: 'GET',
                pathname,
                search,
            });
        },
    );

    deps.mcpServer.registerTool(
        'lightdash_api_mutate',
        {
            description:
                'Call a write-capable Lightdash REST API endpoint as the authenticated MCP user. Use this for UI-backed create/update/delete actions that do not yet have dedicated MCP tools. Requires mcp:write and organization MCP write opt-in. Only relative /api/v1/* and /api/v2/* paths are allowed; auth/token/credential paths are blocked.',
            inputSchema: deps.getMcpCompatibleSchema(apiMutateSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = apiMutateSchema.parse(rawArgs);
            const context = extra as ProtopieMcpContext;
            await requireWriteAccess(deps, context);
            const { pathname, search } = normalizeApiPath(
                args.path,
                args.query,
            );

            return withMcpWriteAudit({
                deps,
                context,
                toolName: 'lightdash_api_mutate',
                projectUuid: extractProjectUuidFromPath(pathname),
                inputSummary: {
                    method: args.method,
                    path: pathname,
                },
                run: async () =>
                    callLightdashApi({
                        deps,
                        context,
                        method: args.method,
                        pathname,
                        search,
                        body: args.body,
                    }),
            });
        },
    );

    deps.mcpServer.registerTool(
        'protopie_get_dashboards_as_code',
        {
            description: `Export dashboards as Lightdash content-as-code for the active project or a provided projectUuid. Use this to read an existing dashboard before patching and upserting it back. ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(projectScopedReadSchema),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = projectScopedReadSchema.parse(rawArgs);
            const context = extra as ProtopieMcpContext;
            const { user } = deps.getAccount(context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );

            return jsonToolResponse(
                await deps.coderService.getDashboards(
                    user,
                    projectUuid,
                    args.ids,
                    args.offset,
                    args.languageMap,
                ),
            );
        },
    );

    deps.mcpServer.registerTool(
        'protopie_get_charts_as_code',
        {
            description: `Export saved charts as Lightdash content-as-code for the active project or a provided projectUuid. ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(projectScopedReadSchema),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = projectScopedReadSchema.parse(rawArgs);
            const context = extra as ProtopieMcpContext;
            const { user } = deps.getAccount(context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );

            return jsonToolResponse(
                await deps.coderService.getCharts(
                    user,
                    projectUuid,
                    args.ids,
                    args.offset,
                    args.languageMap,
                ),
            );
        },
    );

    deps.mcpServer.registerTool(
        'protopie_get_sql_charts_as_code',
        {
            description: `Export SQL charts as Lightdash content-as-code for the active project or a provided projectUuid. ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(projectScopedReadSchema),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = projectScopedReadSchema.parse(rawArgs);
            const context = extra as ProtopieMcpContext;
            const { user } = deps.getAccount(context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );

            return jsonToolResponse(
                await deps.coderService.getSqlCharts(
                    user,
                    projectUuid,
                    args.ids,
                    args.offset,
                ),
            );
        },
    );

    deps.mcpServer.registerTool(
        'protopie_upsert_dashboard_as_code',
        {
            description: `Create or update a Lightdash dashboard from a DashboardAsCode payload. Idempotent by slug — re-running with the same payload returns \`no_changes\`. Dashboard tile chart references use chart slugs (not UUIDs), so upsert the chart first. Returns a per-entity action summary (create/update/no_changes/delete). ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(dashboardInputSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = dashboardInputSchema.parse(
                rawArgs,
            ) as UpsertDashboardAsCodeArgs;
            const context = extra as ProtopieMcpContext;
            const { user } = await requireWriteAccess(deps, context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );
            const slug = requireSlug(args.slug, args.dashboard, 'Dashboard');

            return withMcpWriteAudit({
                deps,
                context,
                toolName: 'protopie_upsert_dashboard_as_code',
                projectUuid,
                inputSummary: { slug },
                run: async () =>
                    jsonToolResponse(
                        summarizePromotionChanges(
                            await deps.coderService.upsertDashboard(
                                user,
                                projectUuid,
                                slug,
                                args.dashboard as DashboardAsCode,
                                args.skipSpaceCreate,
                                args.publicSpaceCreate,
                                args.force,
                                args.spaceNames,
                            ),
                        ),
                    ),
            });
        },
    );

    deps.mcpServer.registerTool(
        'protopie_upsert_chart_as_code',
        {
            description: `Create or update a Lightdash saved chart from a ChartAsCode payload. Idempotent by slug. Use a long, descriptive slug prefixed with \`protopie-\` (Lightdash slugs are not uniquely enforced at the DB level). Validate the underlying metric query with \`run_metric_query\` before upserting. ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(chartInputSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = chartInputSchema.parse(
                rawArgs,
            ) as UpsertChartAsCodeArgs;
            const context = extra as ProtopieMcpContext;
            const { user } = await requireWriteAccess(deps, context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );
            const slug = requireSlug(args.slug, args.chart, 'Chart');

            return withMcpWriteAudit({
                deps,
                context,
                toolName: 'protopie_upsert_chart_as_code',
                projectUuid,
                inputSummary: { slug },
                run: async () =>
                    jsonToolResponse(
                        summarizePromotionChanges(
                            await deps.coderService.upsertChart(
                                user,
                                projectUuid,
                                slug,
                                args.chart as ChartAsCode,
                                args.skipSpaceCreate,
                                args.publicSpaceCreate,
                                args.force,
                                args.spaceNames,
                            ),
                        ),
                    ),
            });
        },
    );

    deps.mcpServer.registerTool(
        'protopie_upsert_sql_chart_as_code',
        {
            description: `Create or update a Lightdash SQL chart from a SqlChartAsCode payload. SQL charts are stored separately from saved (metric) charts. Validate the SQL with \`run_sql\` before upserting. Idempotent by slug. ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(sqlChartInputSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = sqlChartInputSchema.parse(
                rawArgs,
            ) as UpsertSqlChartAsCodeArgs;
            const context = extra as ProtopieMcpContext;
            const { user } = await requireWriteAccess(deps, context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );
            const slug = requireSlug(args.slug, args.sqlChart, 'SQL chart');

            return withMcpWriteAudit({
                deps,
                context,
                toolName: 'protopie_upsert_sql_chart_as_code',
                projectUuid,
                inputSummary: { slug },
                run: async () =>
                    jsonToolResponse(
                        summarizePromotionChanges(
                            await deps.coderService.upsertSqlChart(
                                user,
                                projectUuid,
                                slug,
                                args.sqlChart as SqlChartAsCode,
                                args.skipSpaceCreate,
                                args.publicSpaceCreate,
                                args.force,
                                args.spaceNames,
                            ),
                        ),
                    ),
            });
        },
    );

    deps.mcpServer.registerTool(
        'protopie_create_space',
        {
            description: `Get or create a Lightdash space by content-as-code path. Idempotent — returns the existing space if the slug already resolves. Use slash-separated paths for nested spaces (e.g. \`protopie/sales-ops\`). ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(createSpaceSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = createSpaceSchema.parse(rawArgs);
            const context = extra as ProtopieMcpContext;
            const { user } = await requireWriteAccess(deps, context);
            const projectUuid = await resolveProjectUuid(
                deps,
                context,
                args.projectUuid,
            );

            return withMcpWriteAudit({
                deps,
                context,
                toolName: 'protopie_create_space',
                projectUuid,
                inputSummary: { spaceSlug: args.spaceSlug },
                run: async () =>
                    jsonToolResponse(
                        await deps.coderService.getOrCreateSpace(
                            projectUuid,
                            args.spaceSlug,
                            user,
                            false,
                            args.publicSpaceCreate,
                            args.name ? { [args.spaceSlug]: args.name } : {},
                        ),
                    ),
            });
        },
    );

    deps.mcpServer.registerTool(
        'protopie_update_space',
        {
            description: `Update a Lightdash space's metadata (name, inherit-parent-permissions, project-member access role, color palette). Does NOT mutate the membership list — that goes through separate SpaceService calls. ${OVERVIEW_HINT}`,
            inputSchema: deps.getMcpCompatibleSchema(updateSpaceSchema),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
            },
        },
        async (
            rawArgs,
            extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
            const args = updateSpaceSchema.parse(rawArgs) as UpdateSpaceArgs;
            const context = extra as ProtopieMcpContext;
            const { user } = await requireWriteAccess(deps, context);

            return withMcpWriteAudit({
                deps,
                context,
                toolName: 'protopie_update_space',
                inputSummary: { spaceUuid: args.spaceUuid },
                run: async () =>
                    jsonToolResponse(
                        await deps.spaceService.updateSpace(
                            user,
                            args.spaceUuid,
                            args.space,
                        ),
                    ),
            });
        },
    );
};
