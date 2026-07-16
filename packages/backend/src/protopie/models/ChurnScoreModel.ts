import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type DbChurnScore = {
    score_uuid: string;
    project_uuid: string;
    account_key: string;
    namespace: string | null;
    cloud_url: string | null;
    sf_account_name: string | null;
    account_owner: string | null;
    sf_plan_category: string | null;
    sf_account_region: string | null;
    sf_account_country: string | null;
    scored_for_date: string | Date;
    lookback_days: number;
    config_uuid: string;
    config_version: number;
    total_points: string | number;
    max_points: string | number;
    score_percent: string | number;
    normalized_score: string | number;
    churn_score: string | number;
    risk_band: Protopie.ChurnScoreRiskBand;
    factor_scores: Protopie.ChurnScoreFactorScores;
    computed_at: Date;
    run_uuid: string;
};

const CHURN_SCORE_SORT_BY = new Set<Protopie.ChurnScoreSortBy>([
    'score',
    'risk',
    'namespace',
    'computed_at',
]);

const CHURN_SCORE_SORT_DIRECTIONS = new Set<Protopie.ChurnScoreSortDirection>([
    'asc',
    'desc',
]);

export type ProtopieChurnScoreRecord = Protopie.ChurnScore;

export type ProtopieChurnScoreInsert = Omit<
    ProtopieChurnScoreRecord,
    'scoreUuid' | 'computedAt'
>;

export class ChurnScoreModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    private static getSort({
        sortBy,
        sortDirection,
    }: Protopie.ChurnScoreLatestFilters): {
        sortBy: Protopie.ChurnScoreSortBy;
        sortDirection: Protopie.ChurnScoreSortDirection;
    } {
        return {
            sortBy:
                sortBy && CHURN_SCORE_SORT_BY.has(sortBy) ? sortBy : 'score',
            sortDirection:
                sortDirection && CHURN_SCORE_SORT_DIRECTIONS.has(sortDirection)
                    ? sortDirection
                    : 'asc',
        };
    }

    private static applyScoreSort(
        query: Knex.QueryBuilder,
        filters: Protopie.ChurnScoreLatestFilters,
    ): void {
        const { sortBy, sortDirection } = ChurnScoreModel.getSort(filters);

        if (sortBy === 'score') {
            // 'score' now means churn score (100 - health); higher = more at risk.
            void query.orderBy('churn_score', sortDirection);
        } else if (sortBy === 'risk') {
            void query.orderByRaw(
                `CASE risk_band WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END ${sortDirection}`,
            );
        } else if (sortBy === 'namespace') {
            void query.orderByRaw(`namespace ${sortDirection} NULLS LAST`);
        } else if (sortBy === 'computed_at') {
            void query.orderBy('computed_at', sortDirection);
        }

        void query.orderBy('account_key', 'asc');
    }

    /** Maps each filter facet to its snapshot column. */
    private static readonly FACET_COLUMNS: Record<
        Protopie.ChurnScoreFacetKey,
        string
    > = {
        accountOwner: 'account_owner',
        sfPlanCategory: 'sf_plan_category',
        sfAccountRegion: 'sf_account_region',
        sfAccountCountry: 'sf_account_country',
    };

    /** Columns scanned by the unified free-text search (OR ilike). */
    private static readonly SEARCH_COLUMNS = [
        'sf_account_name',
        'namespace',
        'cloud_url',
        'account_owner',
        'sf_plan_category',
        'sf_account_region',
        'sf_account_country',
    ];

    /**
     * Applies one multi-select SF facet filter. `values` may include
     * CHURN_SCORE_FILTER_NONE_VALUE to also match null rows via OR. Empty or
     * undefined = unfiltered (never emits an invalid `WHERE col IN ()`).
     */
    private static applyFacetFilter(
        query: Knex.QueryBuilder,
        column: string,
        values: string[] | undefined,
    ): void {
        if (!values || values.length === 0) {
            return;
        }
        const includeNone = values.includes(
            Protopie.CHURN_SCORE_FILTER_NONE_VALUE,
        );
        const concrete = values.filter(
            (value) => value !== Protopie.CHURN_SCORE_FILTER_NONE_VALUE,
        );
        void query.where((builder) => {
            if (concrete.length > 0) {
                void builder.whereIn(column, concrete);
            }
            if (includeNone) {
                void builder.orWhereNull(column);
            }
        });
    }

    /**
     * Applies every score filter to `query`. Pass `excludeFacet` to skip that
     * one facet's own selection — used when computing faceted option counts so
     * a facet never constrains its own value list (standard faceted-search).
     */
    private static applyScoreFilters(
        query: Knex.QueryBuilder,
        filters: Protopie.ChurnScoreLatestFilters,
        excludeFacet?: Protopie.ChurnScoreFacetKey,
    ): void {
        if (filters.riskBand) {
            void query.where('risk_band', filters.riskBand);
        }
        if (filters.minScore !== undefined) {
            void query.where('normalized_score', '>=', filters.minScore);
        }
        if (filters.maxScore !== undefined) {
            void query.where('normalized_score', '<=', filters.maxScore);
        }
        if (filters.namespace) {
            void query.where('namespace', 'ilike', `%${filters.namespace}%`);
        }
        const search = filters.search?.trim();
        if (search) {
            const like = `%${search}%`;
            void query.where((builder) => {
                ChurnScoreModel.SEARCH_COLUMNS.forEach((column) => {
                    void builder.orWhere(column, 'ilike', like);
                });
            });
        }
        const facetValues: Record<
            Protopie.ChurnScoreFacetKey,
            string[] | undefined
        > = {
            accountOwner: filters.accountOwner,
            sfPlanCategory: filters.sfPlanCategory,
            sfAccountRegion: filters.sfAccountRegion,
            sfAccountCountry: filters.sfAccountCountry,
        };
        (
            Object.keys(
                ChurnScoreModel.FACET_COLUMNS,
            ) as Protopie.ChurnScoreFacetKey[]
        ).forEach((facetKey) => {
            if (facetKey === excludeFacet) {
                return;
            }
            ChurnScoreModel.applyFacetFilter(
                query,
                ChurnScoreModel.FACET_COLUMNS[facetKey],
                facetValues[facetKey],
            );
        });
    }

    async upsertScores(rows: ProtopieChurnScoreInsert[]): Promise<void> {
        if (rows.length === 0) {
            return;
        }

        await this.database<DbChurnScore>(ProtopieTableName.ChurnScores)
            .insert(
                rows.map((row) => ({
                    project_uuid: row.projectUuid,
                    account_key: row.accountKey,
                    namespace: row.namespace,
                    cloud_url: row.cloudUrl,
                    sf_account_name: row.sfAccountName,
                    account_owner: row.accountOwner,
                    sf_plan_category: row.sfPlanCategory,
                    sf_account_region: row.sfAccountRegion,
                    sf_account_country: row.sfAccountCountry,
                    scored_for_date: row.scoredForDate,
                    lookback_days: row.lookbackDays,
                    config_uuid: row.configUuid,
                    config_version: row.configVersion,
                    total_points: row.totalPoints,
                    max_points: row.maxPoints,
                    score_percent: row.scorePercent,
                    normalized_score: row.normalizedScore,
                    churn_score: row.churnScore,
                    risk_band: row.riskBand,
                    factor_scores: row.factorScores,
                    run_uuid: row.runUuid,
                })),
            )
            .onConflict([
                'account_key',
                'scored_for_date',
                'lookback_days',
                'config_uuid',
            ])
            .merge({
                namespace: this.database.raw('excluded.namespace'),
                cloud_url: this.database.raw('excluded.cloud_url'),
                sf_account_name: this.database.raw('excluded.sf_account_name'),
                account_owner: this.database.raw('excluded.account_owner'),
                sf_plan_category: this.database.raw(
                    'excluded.sf_plan_category',
                ),
                sf_account_region: this.database.raw(
                    'excluded.sf_account_region',
                ),
                sf_account_country: this.database.raw(
                    'excluded.sf_account_country',
                ),
                config_version: this.database.raw('excluded.config_version'),
                total_points: this.database.raw('excluded.total_points'),
                max_points: this.database.raw('excluded.max_points'),
                score_percent: this.database.raw('excluded.score_percent'),
                normalized_score: this.database.raw(
                    'excluded.normalized_score',
                ),
                churn_score: this.database.raw('excluded.churn_score'),
                risk_band: this.database.raw('excluded.risk_band'),
                factor_scores: this.database.raw('excluded.factor_scores'),
                run_uuid: this.database.raw('excluded.run_uuid'),
                computed_at: this.database.fn.now(),
            });
    }

    /**
     * The latest-run snapshot for one (project, config): the newest scored row
     * per account_key from the most recent run. Shared by `listLatestScores`
     * and `listFilterOptions` so filter dropdowns and the scores list always
     * agree on which accounts exist. Returns an aliased subquery (`latest_scores`)
     * to nest inside an outer query.
     */
    private latestScoresSubquery({
        projectUuid,
        configUuid,
    }: {
        projectUuid: string;
        configUuid: string;
    }): Knex.QueryBuilder {
        const latestRun = this.database<DbChurnScore>(
            ProtopieTableName.ChurnScores,
        )
            .select('run_uuid')
            .where({
                project_uuid: projectUuid,
                config_uuid: configUuid,
            })
            .orderBy('scored_for_date', 'desc')
            .orderBy('computed_at', 'desc')
            .limit(1);
        return this.database<DbChurnScore>(ProtopieTableName.ChurnScores)
            .distinctOn('account_key')
            .select('*')
            .where({
                project_uuid: projectUuid,
                config_uuid: configUuid,
            })
            .whereIn('run_uuid', latestRun)
            .orderBy('account_key', 'asc')
            .orderBy('scored_for_date', 'desc')
            .orderBy('computed_at', 'desc')
            .as('latest_scores');
    }

    /**
     * Distinct non-null SF attribute values for the filter dropdowns, scoped to
     * the same latest-run snapshot the scores list uses.
     */
    async listFilterOptions({
        projectUuid,
        configUuid,
        filters,
    }: {
        projectUuid: string;
        configUuid: string;
        filters: Protopie.ChurnScoreLatestFilters;
    }): Promise<Protopie.ChurnScoreFilterOptions> {
        const computeFacet = async (
            facetKey: Protopie.ChurnScoreFacetKey,
        ): Promise<Protopie.ChurnScoreFacet> => {
            const column = ChurnScoreModel.FACET_COLUMNS[facetKey];
            // Apply every OTHER active filter (not this facet's own selection)
            // so its value list stays broadenable — the faceted-search rule.
            const base = this.database.from(
                this.latestScoresSubquery({ projectUuid, configUuid }),
            );
            ChurnScoreModel.applyScoreFilters(base, filters, facetKey);

            const optionRows = (await base
                .clone()
                .whereNotNull(column)
                .groupBy(column)
                .orderBy(column, 'asc')
                .select(column)
                .count({ count: '*' })) as Record<string, unknown>[];

            const noneRow = (await base
                .clone()
                .whereNull(column)
                .count({ count: '*' })
                .first()) as { count?: string | number } | undefined;

            return {
                options: optionRows.map((row) => ({
                    value: String(row[column]),
                    count: Number(row.count),
                })),
                noneCount: Number(noneRow?.count ?? 0),
            };
        };

        const [
            accountOwner,
            sfPlanCategory,
            sfAccountRegion,
            sfAccountCountry,
        ] = await Promise.all([
            computeFacet('accountOwner'),
            computeFacet('sfPlanCategory'),
            computeFacet('sfAccountRegion'),
            computeFacet('sfAccountCountry'),
        ]);

        return {
            accountOwner,
            sfPlanCategory,
            sfAccountRegion,
            sfAccountCountry,
        };
    }

    async listLatestScores({
        projectUuid,
        configUuid,
        filters,
    }: {
        projectUuid: string;
        configUuid: string;
        filters: Protopie.ChurnScoreLatestFilters;
    }): Promise<ProtopieChurnScoreRecord[]> {
        const latestScores = this.latestScoresSubquery({
            projectUuid,
            configUuid,
        });
        const offset = Math.max(filters.offset ?? 0, 0);
        const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
        const query = this.database
            .select<DbChurnScore[]>('*')
            .from(latestScores)
            .limit(limit)
            .offset(offset);

        ChurnScoreModel.applyScoreFilters(query, filters);

        ChurnScoreModel.applyScoreSort(query, filters);

        const rows = await query;
        return rows.map((row) => ChurnScoreModel.toRecord(row));
    }

    async getLatestScoreByAccount({
        projectUuid,
        accountKey,
        configUuid,
    }: {
        projectUuid: string;
        accountKey: string;
        configUuid?: string;
    }): Promise<ProtopieChurnScoreRecord | undefined> {
        const query = this.database<DbChurnScore>(ProtopieTableName.ChurnScores)
            .where({
                project_uuid: projectUuid,
                account_key: accountKey,
            })
            .orderBy('scored_for_date', 'desc')
            .orderBy('computed_at', 'desc')
            .first();

        if (configUuid) {
            void query.where('config_uuid', configUuid);
        }

        const row = await query;
        return row ? ChurnScoreModel.toRecord(row) : undefined;
    }

    async getAccountHistory({
        projectUuid,
        accountKey,
        limit,
    }: {
        projectUuid: string;
        accountKey: string;
        limit: number;
    }): Promise<ProtopieChurnScoreRecord[]> {
        const rows = await this.database<DbChurnScore>(
            ProtopieTableName.ChurnScores,
        )
            .where({
                project_uuid: projectUuid,
                account_key: accountKey,
            })
            .orderBy('scored_for_date', 'desc')
            .orderBy('computed_at', 'desc')
            .limit(limit);

        return rows.map((row) => ChurnScoreModel.toRecord(row));
    }

    private static toRecord(row: DbChurnScore): ProtopieChurnScoreRecord {
        return {
            scoreUuid: row.score_uuid,
            projectUuid: row.project_uuid,
            accountKey: row.account_key,
            namespace: row.namespace,
            cloudUrl: row.cloud_url,
            sfAccountName: row.sf_account_name,
            accountOwner: row.account_owner,
            sfPlanCategory: row.sf_plan_category,
            sfAccountRegion: row.sf_account_region,
            sfAccountCountry: row.sf_account_country,
            scoredForDate:
                row.scored_for_date instanceof Date
                    ? row.scored_for_date.toISOString().slice(0, 10)
                    : row.scored_for_date,
            lookbackDays: Number(row.lookback_days),
            configUuid: row.config_uuid,
            configVersion: Number(row.config_version),
            totalPoints: Number(row.total_points),
            maxPoints: Number(row.max_points),
            scorePercent: Number(row.score_percent),
            normalizedScore: Number(row.normalized_score),
            churnScore: Number(row.churn_score),
            riskBand: row.risk_band,
            factorScores: row.factor_scores,
            computedAt: row.computed_at,
            runUuid: row.run_uuid,
        };
    }
}
