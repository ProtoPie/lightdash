/**
 * Worked `ChartAsCode` / `DashboardAsCode` / `SqlChartAsCode` templates served
 * by the `protopie_get_chart_examples` MCP tool.
 *
 * These are intentionally minimal but **valid** payloads agents can patch and
 * upsert directly. The schemas alone (returned by
 * `protopie_get_content_as_code_schema`) are too abstract for one-shot
 * generation; examples bridge that gap.
 *
 * Field names in the metricQuery follow the Lightdash convention
 * `<table>_<column>` — e.g. dimension `orders.order_date` becomes
 * `orders_order_date` and metric `orders.total_revenue` becomes
 * `orders_total_revenue`. Replace `<table>` and `<column>` with values
 * discovered via `find_explores` / `find_fields`.
 */
export const PROTOPIE_CHART_EXAMPLES = {
    barChart: {
        name: 'Total Revenue by Month',
        description: 'Monthly total revenue from the orders explore.',
        tableName: 'orders',
        slug: 'protopie-total-revenue-by-month',
        version: 1,
        spaceSlug: 'protopie/sales-ops',
        dashboardSlug: undefined,
        metricQuery: {
            exploreName: 'orders',
            dimensions: ['orders_order_month'],
            metrics: ['orders_total_revenue'],
            filters: {},
            sorts: [{ fieldId: 'orders_order_month', descending: false }],
            limit: 365,
            tableCalculations: [],
            additionalMetrics: [],
            customDimensions: [],
        },
        chartConfig: {
            type: 'cartesian',
            config: {
                layout: {
                    xField: 'orders_order_month',
                    yField: ['orders_total_revenue'],
                    showGridX: false,
                    showGridY: true,
                },
                eChartsConfig: {
                    series: [
                        {
                            encode: {
                                xRef: { field: 'orders_order_month' },
                                yRef: { field: 'orders_total_revenue' },
                            },
                            type: 'bar',
                            yAxisIndex: 0,
                        },
                    ],
                },
            },
        },
        tableConfig: { columnOrder: [] },
    },

    tableChart: {
        name: 'Event Inventory',
        description: 'Distinct event names and their JSON property keys.',
        tableName: 'dim_event_info',
        slug: 'protopie-event-inventory',
        version: 1,
        spaceSlug: 'protopie/sales-ops',
        dashboardSlug: undefined,
        metricQuery: {
            exploreName: 'dim_event_info',
            dimensions: [
                'dim_event_info_event_name',
                'dim_event_info_json_keys',
            ],
            metrics: [],
            filters: {},
            sorts: [
                {
                    fieldId: 'dim_event_info_event_name',
                    descending: false,
                },
            ],
            limit: 500,
            tableCalculations: [],
            additionalMetrics: [],
            customDimensions: [],
        },
        chartConfig: {
            type: 'table',
            config: {
                showRowCalculation: false,
                showColumnCalculation: false,
                showResultsTotal: false,
                showSubtotals: false,
                showTableNames: true,
                hideRowNumbers: false,
                metricsAsRows: false,
                columns: {},
                conditionalFormattings: [],
            },
        },
        tableConfig: {
            columnOrder: [
                'dim_event_info_event_name',
                'dim_event_info_json_keys',
            ],
        },
    },

    bigNumberChart: {
        name: 'Active Accounts (90d)',
        description: 'Distinct active accounts in the last 90 days.',
        tableName: 'mart_account_usage_90d',
        slug: 'protopie-active-accounts-90d',
        version: 1,
        spaceSlug: 'protopie/sales-ops',
        dashboardSlug: undefined,
        metricQuery: {
            exploreName: 'mart_account_usage_90d',
            dimensions: [],
            metrics: ['mart_account_usage_90d_active_account_count'],
            filters: {},
            sorts: [],
            limit: 1,
            tableCalculations: [],
            additionalMetrics: [],
            customDimensions: [],
        },
        chartConfig: {
            type: 'big_number',
            config: {
                label: 'Active Accounts (90d)',
                style: 'thousands',
                showBigNumberLabel: true,
                showComparison: false,
            },
        },
        tableConfig: { columnOrder: [] },
    },

    sqlChart: {
        name: 'Custom Account Cohort',
        description: 'A SQL chart for an ad-hoc cohort that has no explore.',
        slug: 'protopie-custom-account-cohort',
        version: 1,
        chartKind: 'vertical_bar',
        spaceSlug: 'protopie/sales-ops',
        sql: `select
    date_trunc('month', created_at) as cohort_month,
    count(*) as accounts
from warehouse.dim_team_summary
group by 1
order by 1`,
        limit: 1000,
        config: {
            metadata: {
                version: 1,
            },
            type: 'vertical_bar',
            fieldConfig: {
                x: { reference: 'cohort_month', type: 'category' },
                y: [{ reference: 'accounts', aggregation: 'sum' }],
                groupBy: undefined,
            },
            display: undefined,
        },
    },

    dashboard: {
        name: 'Protopie — Sales Ops Demo',
        description: 'Worked dashboard pulling charts via slug references.',
        slug: 'protopie-sales-ops-demo',
        version: 1,
        spaceSlug: 'protopie/sales-ops',
        filters: { dimensions: [], metrics: [], tableCalculations: [] },
        parameters: {},
        tabs: [],
        tiles: [
            {
                type: 'saved_chart',
                uuid: '00000000-0000-0000-0000-000000000001',
                x: 0,
                y: 0,
                w: 18,
                h: 6,
                tabUuid: null,
                properties: {
                    title: 'Total Revenue by Month',
                    chartSlug: 'protopie-total-revenue-by-month',
                    hideTitle: false,
                    belongsToDashboard: false,
                },
            },
            {
                type: 'markdown',
                uuid: '00000000-0000-0000-0000-000000000002',
                x: 18,
                y: 0,
                w: 18,
                h: 6,
                tabUuid: null,
                properties: {
                    title: 'Notes',
                    content:
                        '## Sales Ops Demo\\nThis dashboard is bootstrapped via content-as-code.',
                    hideTitle: false,
                },
            },
        ],
    },
} as const;

export const PROTOPIE_CHART_EXAMPLES_GUIDE = `# Worked Chart-as-Code Examples

These payloads are MINIMAL but VALID. Copy one, replace the field
identifiers with values discovered via \`find_explores\` /
\`find_fields\`, validate saved-chart queries with \`run_metric_query\`
and SQL chart queries with \`run_sql\`, then submit via
\`protopie_upsert_chart_as_code\` or \`protopie_upsert_sql_chart_as_code\`.

## Field identifier convention

Lightdash flattens \`<table>.<column>\` to a single identifier
\`<table>_<column>\`. So a dimension on table \`orders\` column \`order_date\`
appears as \`orders_order_date\`. Always confirm the identifier with
\`find_fields\` — some explores use joined tables, in which case the prefix
is the JOIN ALIAS rather than the base table.

## Chart types covered

- \`barChart\` — cartesian (bar) chart with one X dimension and one Y metric.
- \`tableChart\` — tabular layout with explicit column order.
- \`bigNumberChart\` — single-value KPI tile.
- \`sqlChart\` — raw SQL chart for use cases without a Lightdash explore.
- \`dashboard\` — a dashboard combining a chart tile and a markdown tile.

## Slug rules (repeated for emphasis)

- Every Protopie slug should start with \`protopie-\` to avoid collisions.
- Slugs are NOT uniquely enforced in the database; long descriptive slugs
  are safer than short generic ones.
- Tile chart references in a dashboard use the chart's slug, not its UUID.
  CoderService resolves slug → UUID at upsert time.
- Use slash paths for nested spaces, e.g. \`protopie/sales-ops\`.
`;
