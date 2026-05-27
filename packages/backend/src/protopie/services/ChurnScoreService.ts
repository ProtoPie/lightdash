import { subject } from '@casl/ability';
import {
    ForbiddenError,
    getErrorMessage,
    NotFoundError,
    ParameterError,
    Protopie,
    QueryExecutionContext,
    type CreateWarehouseCredentials,
    type SessionUser,
} from '@lightdash/common';
import { type Knex } from 'knex';
import { type ProjectModel } from '../../models/ProjectModel/ProjectModel';
import { SchedulerClient } from '../../scheduler/SchedulerClient';
import { BaseService } from '../../services/BaseService';
import { type ProjectService } from '../../services/ProjectService/ProjectService';
import {
    ChurnScoreConfigModel,
    type ProtopieChurnScoreConfigRecord,
} from '../models/ChurnScoreConfigModel';
import {
    ChurnScoreFactorModel,
    type ProtopieChurnScoreFactorRecord,
} from '../models/ChurnScoreFactorModel';
import {
    ChurnScoreModel,
    type ProtopieChurnScoreInsert,
    type ProtopieChurnScoreRecord,
} from '../models/ChurnScoreModel';
import {
    ChurnScoreRunModel,
    type ProtopieChurnScoreRunRecord,
} from '../models/ChurnScoreRunModel';
import { buildAggregationQuery } from './churnScore/buildAggregationQuery';
import {
    scoreAccount,
    type ChurnScoreAccountAggregationRow,
} from './churnScore/scoreAccount';
import { validateChurnScoreConfigInput } from './churnScore/validateChurnScoreConfigInput';

type ChurnScoreServiceArguments = {
    database: Knex;
    projectModel: ProjectModel;
    projectService: ProjectService;
    schedulerClient: SchedulerClient;
    churnScoreConfigModel: ChurnScoreConfigModel;
    churnScoreFactorModel: ChurnScoreFactorModel;
    churnScoreModel: ChurnScoreModel;
    churnScoreRunModel: ChurnScoreRunModel;
};

type ChurnScoreAccountEventUsageRow = {
    event_date: Date | string;
    event_name: string;
    event_count: string | number;
    active_users: string | number;
    first_seen_at: Date | string | null;
    last_seen_at: Date | string | null;
    event_total_count: string | number;
    event_active_users: string | number;
    event_active_days: string | number;
};

type ChurnScoreEventUsageDateRange = {
    dateFrom: string;
    dateTo: string;
};

export class ChurnScoreService extends BaseService {
    private readonly database: Knex;

    private readonly projectModel: ProjectModel;

    private readonly projectService: ProjectService;

    private readonly schedulerClient: SchedulerClient;

    private readonly churnScoreConfigModel: ChurnScoreConfigModel;

    private readonly churnScoreFactorModel: ChurnScoreFactorModel;

    private readonly churnScoreModel: ChurnScoreModel;

    private readonly churnScoreRunModel: ChurnScoreRunModel;

    constructor({
        database,
        projectModel,
        projectService,
        schedulerClient,
        churnScoreConfigModel,
        churnScoreFactorModel,
        churnScoreModel,
        churnScoreRunModel,
    }: ChurnScoreServiceArguments) {
        super();
        this.database = database;
        this.projectModel = projectModel;
        this.projectService = projectService;
        this.schedulerClient = schedulerClient;
        this.churnScoreConfigModel = churnScoreConfigModel;
        this.churnScoreFactorModel = churnScoreFactorModel;
        this.churnScoreModel = churnScoreModel;
        this.churnScoreRunModel = churnScoreRunModel;
    }

    async getActiveConfig({
        projectUuid,
        name,
        user,
    }: {
        projectUuid: string;
        name?: string;
        user: SessionUser;
    }): Promise<Protopie.ChurnScoreConfigWithFactors> {
        this.requireProjectView(user, projectUuid);
        const configWithFactors = await this.getActiveConfigByName({
            projectUuid,
            name,
        });
        this.requireConfigView(user, projectUuid, configWithFactors.config);
        return configWithFactors;
    }

    async listActiveConfigs({
        projectUuid,
        user,
    }: {
        projectUuid: string;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreConfigRecord[]> {
        this.requireProjectView(user, projectUuid);
        await this.getOrCreateDefaultConfig(projectUuid);

        const configs = await this.churnScoreConfigModel.listActiveConfigs({
            projectUuid,
        });

        if (this.canManageProject(user, projectUuid)) {
            return ChurnScoreService.sortDefaultFirst(configs);
        }

        return ChurnScoreService.sortDefaultFirst(
            configs.filter(
                (config) =>
                    ChurnScoreService.isDefaultConfig(config.name) ||
                    config.createdByUserUuid === user.userUuid,
            ),
        );
    }

    async listVersions({
        projectUuid,
        name,
        user,
    }: {
        projectUuid: string;
        name?: string;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreConfigRecord[]> {
        this.requireProjectView(user, projectUuid);
        const configName =
            name?.trim() || Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;
        if (ChurnScoreService.isDefaultConfig(configName)) {
            await this.getOrCreateDefaultConfig(projectUuid);
        }
        const versions = await this.churnScoreConfigModel.listVersions({
            projectUuid,
            name: configName,
        });
        if (
            !ChurnScoreService.isDefaultConfig(configName) &&
            versions.length > 0
        ) {
            this.requireConfigView(user, projectUuid, versions[0]);
        }

        return versions;
    }

    async upsertConfigAsNewVersion({
        projectUuid,
        payload,
        user,
    }: {
        projectUuid: string;
        payload: Protopie.ChurnScoreConfigInput;
        user: SessionUser;
    }): Promise<Protopie.ChurnScoreConfigWithFactors> {
        const validated = validateChurnScoreConfigInput(payload);
        const name = validated.name ?? Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;
        const active = await this.churnScoreConfigModel.getActiveConfig({
            projectUuid,
            name,
        });
        this.requireConfigEdit(user, projectUuid, active, name);

        return this.database.transaction(async (trx) => {
            const version = await this.churnScoreConfigModel.getNextVersion({
                projectUuid,
                name,
                trx,
            });

            await this.churnScoreConfigModel.archiveActive({
                projectUuid,
                name,
                userUuid: user.userUuid,
                trx,
            });

            const config = await this.churnScoreConfigModel.insertConfig({
                projectUuid,
                name,
                version,
                lookbackDays: validated.lookbackDays,
                scoreFunction: validated.scoreFunction,
                riskBandThresholds: validated.riskBandThresholds,
                userUuid: user.userUuid,
                trx,
            });
            const factors = await this.churnScoreFactorModel.insertFactors({
                configUuid: config.configUuid,
                factors: validated.factors,
                trx,
            });

            return { config, factors };
        });
    }

    async restoreConfigVersion({
        projectUuid,
        configUuid,
        user,
    }: {
        projectUuid: string;
        configUuid: string;
        user: SessionUser;
    }): Promise<Protopie.ChurnScoreConfigWithFactors> {
        return this.database.transaction(async (trx) => {
            const sourceConfig = await this.churnScoreConfigModel.getByUuid({
                configUuid,
                trx,
            });

            if (!sourceConfig || sourceConfig.projectUuid !== projectUuid) {
                throw new NotFoundError(
                    `Churn score config ${configUuid} was not found.`,
                );
            }
            this.requireConfigEdit(
                user,
                projectUuid,
                sourceConfig,
                sourceConfig.name,
            );

            const sourceFactors =
                await this.churnScoreFactorModel.listByConfigUuid({
                    configUuid: sourceConfig.configUuid,
                    trx,
                });
            ChurnScoreService.assertFactorWeightsTotal(sourceFactors);

            if (sourceConfig.status === 'active') {
                return {
                    config: sourceConfig,
                    factors: sourceFactors,
                };
            }

            const version = await this.churnScoreConfigModel.getNextVersion({
                projectUuid,
                name: sourceConfig.name,
                trx,
            });

            await this.churnScoreConfigModel.archiveActive({
                projectUuid,
                name: sourceConfig.name,
                userUuid: user.userUuid,
                trx,
            });

            const config = await this.churnScoreConfigModel.insertConfig({
                projectUuid,
                name: sourceConfig.name,
                version,
                lookbackDays: sourceConfig.lookbackDays,
                scoreFunction: sourceConfig.scoreFunction,
                riskBandThresholds: sourceConfig.riskBandThresholds,
                userUuid: user.userUuid,
                trx,
            });
            const factors = await this.churnScoreFactorModel.insertFactors({
                configUuid: config.configUuid,
                factors: sourceFactors.map(ChurnScoreService.toFactorInput),
                trx,
            });

            return { config, factors };
        });
    }

    async enqueueRecompute({
        projectUuid,
        name,
        configUuid,
        user,
        triggeredBy = 'manual',
    }: {
        projectUuid: string;
        name?: string;
        configUuid?: string;
        user: SessionUser;
        triggeredBy?: Protopie.ChurnScoreRunTrigger;
    }): Promise<{ runUuid: string; status: 'queued' }> {
        const organizationUuid = ChurnScoreService.requireOrganization(user);
        const config = await this.getConfigForRun({
            projectUuid,
            name,
            configUuid,
        });
        this.requireConfigEdit(user, projectUuid, config, config.name);
        const factors = await this.churnScoreFactorModel.listByConfigUuid({
            configUuid: config.configUuid,
        });
        ChurnScoreService.assertFactorWeightsTotal(factors);

        const run = await this.churnScoreRunModel.insertRun({
            projectUuid,
            configUuid: config.configUuid,
            triggeredBy,
            triggeredByUserUuid: user.userUuid,
        });

        try {
            await this.schedulerClient.protopieRecomputeChurnScore({
                organizationUuid,
                projectUuid,
                userUuid: user.userUuid,
                runUuid: run.runUuid,
                triggeredBy,
                triggeredByUserUuid: user.userUuid,
            });
        } catch (error) {
            await this.churnScoreRunModel.markFailed({
                runUuid: run.runUuid,
                errorMessage: getErrorMessage(error),
            });
            throw error;
        }

        return { runUuid: run.runUuid, status: 'queued' };
    }

    async listRuns({
        projectUuid,
        limit,
        user,
    }: {
        projectUuid: string;
        limit?: number;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreRunRecord[]> {
        this.requireProjectView(user, projectUuid);
        return this.churnScoreRunModel.list({
            projectUuid,
            limit: Math.min(Math.max(limit ?? 20, 1), 100),
        });
    }

    async getRun({
        projectUuid,
        runUuid,
        user,
    }: {
        projectUuid: string;
        runUuid: string;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreRunRecord> {
        this.requireProjectView(user, projectUuid);
        const run = await this.churnScoreRunModel.get({
            projectUuid,
            runUuid,
        });

        if (!run) {
            throw new NotFoundError(
                `Churn score run does not exist: ${runUuid}`,
            );
        }

        return run;
    }

    async listLatestScores({
        projectUuid,
        filters,
        user,
    }: {
        projectUuid: string;
        filters: Protopie.ChurnScoreLatestFilters;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreRecord[]> {
        this.requireProjectView(user, projectUuid);
        const config = await this.getConfigForScores({
            projectUuid,
            configUuid: filters.configUuid,
        });
        this.requireConfigView(user, projectUuid, config);
        return this.churnScoreModel.listLatestScores({
            projectUuid,
            configUuid: config.configUuid,
            filters,
        });
    }

    async getAccountHistory({
        projectUuid,
        accountKey,
        limit,
        user,
    }: {
        projectUuid: string;
        accountKey: string;
        limit?: number;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreRecord[]> {
        this.requireProjectView(user, projectUuid);
        return this.churnScoreModel.getAccountHistory({
            projectUuid,
            accountKey,
            limit: Math.min(Math.max(limit ?? 30, 1), 365),
        });
    }

    async getAccountDetails({
        projectUuid,
        accountKey,
        configUuid,
        user,
        dateFrom,
        dateTo,
    }: {
        projectUuid: string;
        accountKey: string;
        configUuid?: string;
        user: SessionUser;
        dateFrom?: string;
        dateTo?: string;
    }): Promise<Protopie.ChurnScoreAccountDetails> {
        this.requireProjectView(user, projectUuid);
        const trimmedAccountKey = accountKey.trim();
        if (!trimmedAccountKey) {
            throw new ParameterError('accountKey is required.');
        }

        const score = await this.churnScoreModel.getLatestScoreByAccount({
            projectUuid,
            accountKey: trimmedAccountKey,
            configUuid,
        });
        if (!score) {
            throw new NotFoundError('Churn score account was not found.');
        }

        const config = await this.churnScoreConfigModel.getByUuid({
            configUuid: score.configUuid,
        });
        if (!config) {
            throw new NotFoundError('Churn score rubric was not found.');
        }
        this.requireConfigView(user, projectUuid, config);

        const factors = await this.churnScoreFactorModel.listByConfigUuid({
            configUuid: score.configUuid,
        });
        const eventUsage = await this.getAccountEventUsage({
            projectUuid,
            namespace: score.namespace ?? trimmedAccountKey,
            config,
            factors,
            dateRange: ChurnScoreService.resolveEventUsageDateRange({
                scoredForDate: score.scoredForDate,
                lookbackDays: config.lookbackDays,
                dateFrom,
                dateTo,
            }),
        });

        return {
            score,
            config,
            factors: factors.map((factor) => {
                const factorScore = score.factorScores[factor.factorKey] ?? {
                    raw: 0,
                    goal: factor.goalValue,
                    points: 0,
                };
                const goal = Number(factorScore.goal || factor.goalValue || 0);
                const achievementPercent =
                    goal > 0
                        ? Math.min(Number(factorScore.raw || 0) / goal, 1) * 100
                        : 0;

                return {
                    ...factor,
                    score: {
                        ...factorScore,
                        achievementPercent: ChurnScoreService.round(
                            achievementPercent,
                            2,
                        ),
                    },
                };
            }),
            eventUsage,
        };
    }

    async listEventNames({
        projectUuid,
        search,
        limit,
        user,
    }: {
        projectUuid: string;
        search?: string;
        limit?: number;
        user: SessionUser;
    }): Promise<string[]> {
        this.requireProjectView(user, projectUuid);
        const credentials =
            await this.projectModel.getWarehouseCredentialsForProject(
                projectUuid,
            );
        const schema = ChurnScoreService.getWarehouseSchema(credentials);
        const safeLimit = Math.min(Math.max(limit ?? 100, 1), 500);
        const values: string[] = [];
        const searchTerm = search?.trim();
        const searchPredicate = searchTerm
            ? `AND event_name ILIKE $${values.push(`%${searchTerm}%`)}`
            : '';
        const sql = `
            SELECT DISTINCT event_name
            FROM ${schema}.dim_product_all_events
            WHERE event_name IS NOT NULL
              ${searchPredicate}
            ORDER BY event_name
            LIMIT ${safeLimit}
        `;
        const { warehouseClient, sshTunnel } =
            await this.projectService._getWarehouseClient(
                projectUuid,
                credentials,
            );

        try {
            const results = await warehouseClient.runQuery(
                sql,
                {
                    project_uuid: projectUuid,
                    query_context: QueryExecutionContext.API,
                },
                credentials.dataTimezone,
                values,
            );

            return results.rows
                .map((row) => row.event_name)
                .filter((eventName): eventName is string => Boolean(eventName));
        } finally {
            await sshTunnel.disconnect();
        }
    }

    async executeRecompute(runUuid: string): Promise<void> {
        const run = await this.churnScoreRunModel.getByUuid(runUuid);
        if (!run) {
            throw new NotFoundError(
                `Churn score run does not exist: ${runUuid}`,
            );
        }

        await this.churnScoreRunModel.markRunning(runUuid);

        try {
            const config = await this.churnScoreConfigModel.getByUuid({
                configUuid: run.configUuid,
            });
            if (!config) {
                throw new NotFoundError(
                    `Churn score config does not exist: ${run.configUuid}`,
                );
            }

            const factors = await this.churnScoreFactorModel.listByConfigUuid({
                configUuid: config.configUuid,
            });
            ChurnScoreService.assertFactorWeightsTotal(factors);
            const warehouseRows = await this.getWarehouseAggregationRows({
                projectUuid: run.projectUuid,
                config,
                factors,
            });
            const rowsByAccountKey = new Map<
                string,
                ChurnScoreAccountAggregationRow
            >();
            warehouseRows.forEach((row) => {
                rowsByAccountKey.set(row.account_key, row);
            });
            const uniqueWarehouseRows = [...rowsByAccountKey.values()];
            const scoredForDate = new Date().toISOString().slice(0, 10);
            const scores = uniqueWarehouseRows.map((row) => {
                const result = scoreAccount({
                    factors,
                    row,
                    thresholds: config.riskBandThresholds,
                });
                return {
                    projectUuid: run.projectUuid,
                    accountKey: result.accountKey,
                    namespace: result.namespace,
                    cloudUrl: result.cloudUrl,
                    scoredForDate,
                    lookbackDays: config.lookbackDays,
                    configUuid: config.configUuid,
                    configVersion: config.version,
                    totalPoints: result.totalPoints,
                    maxPoints: result.maxPoints,
                    scorePercent: result.scorePercent,
                    normalizedScore: result.normalizedScore,
                    riskBand: result.riskBand,
                    factorScores: result.factorScores,
                    runUuid,
                } satisfies ProtopieChurnScoreInsert;
            });

            await this.churnScoreModel.upsertScores(scores);
            await this.churnScoreRunModel.markCompleted({
                runUuid,
                accountsScored: scores.length,
            });
        } catch (error) {
            await this.churnScoreRunModel.markFailed({
                runUuid,
                errorMessage: getErrorMessage(error),
            });
            throw error;
        }
    }

    private async getActiveConfigByName({
        projectUuid,
        name,
    }: {
        projectUuid: string;
        name?: string;
    }): Promise<Protopie.ChurnScoreConfigWithFactors> {
        const configName =
            name?.trim() || Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;

        if (ChurnScoreService.isDefaultConfig(configName)) {
            return this.getOrCreateDefaultConfig(projectUuid);
        }

        const active = await this.churnScoreConfigModel.getActiveConfig({
            projectUuid,
            name: configName,
        });

        if (!active) {
            throw new NotFoundError(
                `Churn score rubric does not exist: ${configName}`,
            );
        }

        return {
            config: active,
            factors: await this.churnScoreFactorModel.listByConfigUuid({
                configUuid: active.configUuid,
            }),
        };
    }

    private async getConfigForRun({
        projectUuid,
        name,
        configUuid,
    }: {
        projectUuid: string;
        name?: string;
        configUuid?: string;
    }): Promise<ProtopieChurnScoreConfigRecord> {
        if (configUuid) {
            const config = await this.churnScoreConfigModel.getByUuid({
                configUuid,
            });
            if (!config || config.projectUuid !== projectUuid) {
                throw new NotFoundError(
                    `Churn score config ${configUuid} was not found.`,
                );
            }
            return config;
        }

        const { config } = await this.getActiveConfigByName({
            projectUuid,
            name,
        });
        return config;
    }

    private async getConfigForScores({
        projectUuid,
        configUuid,
    }: {
        projectUuid: string;
        configUuid?: string;
    }): Promise<ProtopieChurnScoreConfigRecord> {
        if (configUuid) {
            const config = await this.churnScoreConfigModel.getByUuid({
                configUuid,
            });
            if (!config || config.projectUuid !== projectUuid) {
                throw new NotFoundError(
                    `Churn score config ${configUuid} was not found.`,
                );
            }
            return config;
        }

        const { config } = await this.getOrCreateDefaultConfig(projectUuid);
        return config;
    }

    private async getOrCreateDefaultConfig(
        projectUuid: string,
    ): Promise<Protopie.ChurnScoreConfigWithFactors> {
        const active = await this.churnScoreConfigModel.getActiveConfig({
            projectUuid,
            name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        });

        if (active) {
            return {
                config: active,
                factors: await this.churnScoreFactorModel.listByConfigUuid({
                    configUuid: active.configUuid,
                }),
            };
        }

        return this.database.transaction(async (trx) => {
            const existing = await this.churnScoreConfigModel.getActiveConfig({
                projectUuid,
                name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
                trx,
            });
            if (existing) {
                return {
                    config: existing,
                    factors: await this.churnScoreFactorModel.listByConfigUuid({
                        configUuid: existing.configUuid,
                        trx,
                    }),
                };
            }

            const config = await this.churnScoreConfigModel.insertConfig({
                projectUuid,
                name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
                version: 1,
                lookbackDays: Protopie.DEFAULT_CHURN_SCORE_LOOKBACK_DAYS,
                scoreFunction: 'linear',
                riskBandThresholds:
                    Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
                userUuid: null,
                trx,
            });
            const factors = await this.churnScoreFactorModel.insertFactors({
                configUuid: config.configUuid,
                factors: Protopie.DEFAULT_CHURN_SCORE_FACTORS,
                trx,
            });

            return { config, factors };
        });
    }

    private async getAccountEventUsage({
        projectUuid,
        namespace,
        config,
        factors,
        dateRange,
    }: {
        projectUuid: string;
        namespace: string;
        config: ProtopieChurnScoreConfigRecord;
        factors: ProtopieChurnScoreFactorRecord[];
        dateRange: ChurnScoreEventUsageDateRange;
    }): Promise<Protopie.ChurnScoreAccountEventUsage> {
        const selectedEventNames = Array.from(
            new Set(
                factors.flatMap((factor) =>
                    factor.aggregation === 'active_days'
                        ? []
                        : factor.eventGroup.events,
                ),
            ),
        ).filter(Boolean);

        if (selectedEventNames.length === 0) {
            return {
                lookbackDays: config.lookbackDays,
                dateFrom: dateRange.dateFrom,
                dateTo: dateRange.dateTo,
                totalEvents: 0,
                selectedEventNames,
                events: [],
                daily: [],
            };
        }

        const credentials =
            await this.projectModel.getWarehouseCredentialsForProject(
                projectUuid,
            );
        const schema = ChurnScoreService.getWarehouseSchema(credentials);
        const values = [namespace, dateRange.dateFrom, dateRange.dateTo];
        const eventPlaceholders = selectedEventNames.map((eventName) => {
            values.push(eventName);
            return `$${values.length}`;
        });
        const sql = `
            WITH account_teams AS (
                SELECT DISTINCT
                    t.team_id
                FROM ${schema}.dim_team_summary t
                WHERE t.namespace = $1
                  AND t.team_id IS NOT NULL
            ), date_filter AS (
                SELECT
                    $2::date AS date_from,
                    ($3::date + 1) AS date_to_exclusive
            ), event_attribution AS (
                SELECT DISTINCT
                    e.event_id,
                    DATE_TRUNC('day', e.event_time) AS event_date,
                    e.event_time,
                    e.event_name,
                    e.user_id
                FROM ${schema}.dim_product_all_events e
                LEFT JOIN ${schema}.dim_product_all_event_properties ep
                    ON e.event_id = ep.event_id
                INNER JOIN account_teams at
                    ON at.team_id = ep.team_id
                CROSS JOIN date_filter df
                WHERE e.event_time >= df.date_from
                  AND e.event_time < df.date_to_exclusive
                  AND e.event_name IN (${eventPlaceholders.join(', ')})
            )
            , daily AS (
                SELECT
                    event_date,
                    event_name,
                    COUNT(DISTINCT event_id) AS event_count,
                    COUNT(DISTINCT user_id) AS active_users
                FROM event_attribution
                GROUP BY event_date, event_name
            ), event_summary AS (
                SELECT
                    event_name,
                    COUNT(DISTINCT event_id) AS event_total_count,
                    COUNT(DISTINCT user_id) AS event_active_users,
                    COUNT(DISTINCT event_date) AS event_active_days,
                    MIN(event_time) AS first_seen_at,
                    MAX(event_time) AS last_seen_at
                FROM event_attribution
                GROUP BY event_name
            )
            SELECT
                d.event_date,
                d.event_name,
                d.event_count,
                d.active_users,
                s.event_total_count,
                s.event_active_users,
                s.event_active_days,
                s.first_seen_at,
                s.last_seen_at
            FROM daily d
            JOIN event_summary s
                ON d.event_name = s.event_name
            ORDER BY d.event_date, d.event_name
        `;
        const { warehouseClient, sshTunnel } =
            await this.projectService._getWarehouseClient(
                projectUuid,
                credentials,
            );

        try {
            const results = await warehouseClient.runQuery(
                sql,
                {
                    project_uuid: projectUuid,
                    query_context: QueryExecutionContext.API,
                },
                credentials.dataTimezone,
                values,
            );
            return ChurnScoreService.toAccountEventUsage({
                lookbackDays: config.lookbackDays,
                dateRange,
                selectedEventNames,
                rows: results.rows as ChurnScoreAccountEventUsageRow[],
            });
        } finally {
            await sshTunnel.disconnect();
        }
    }

    private async getWarehouseAggregationRows({
        projectUuid,
        config,
        factors,
    }: {
        projectUuid: string;
        config: ProtopieChurnScoreConfigRecord;
        factors: ProtopieChurnScoreFactorRecord[];
    }): Promise<ChurnScoreAccountAggregationRow[]> {
        const credentials =
            await this.projectModel.getWarehouseCredentialsForProject(
                projectUuid,
            );
        const schema = ChurnScoreService.getWarehouseSchema(credentials);
        const { sql, values } = buildAggregationQuery({
            schema,
            lookbackDays: config.lookbackDays,
            factors,
        });
        const { warehouseClient, sshTunnel } =
            await this.projectService._getWarehouseClient(
                projectUuid,
                credentials,
            );

        try {
            const results = await warehouseClient.runQuery(
                sql,
                {
                    project_uuid: projectUuid,
                    query_context: QueryExecutionContext.API,
                },
                credentials.dataTimezone,
                values,
            );
            return results.rows as ChurnScoreAccountAggregationRow[];
        } finally {
            await sshTunnel.disconnect();
        }
    }

    private static resolveEventUsageDateRange({
        scoredForDate,
        lookbackDays,
        dateFrom,
        dateTo,
    }: {
        scoredForDate: string;
        lookbackDays: number;
        dateFrom?: string;
        dateTo?: string;
    }): ChurnScoreEventUsageDateRange {
        const resolvedDateTo = dateTo?.trim() || scoredForDate;
        ChurnScoreService.validateDateString(resolvedDateTo, 'dateTo');

        const resolvedDateFrom =
            dateFrom?.trim() ||
            ChurnScoreService.addDays(
                resolvedDateTo,
                -(Math.max(Math.floor(lookbackDays), 1) - 1),
            );
        ChurnScoreService.validateDateString(resolvedDateFrom, 'dateFrom');

        const fromDate = new Date(`${resolvedDateFrom}T00:00:00.000Z`);
        const toDate = new Date(`${resolvedDateTo}T00:00:00.000Z`);
        if (fromDate > toDate) {
            throw new ParameterError(
                'dateFrom must be before or equal to dateTo.',
            );
        }

        const days =
            Math.floor(
                (toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000),
            ) + 1;
        if (days > 366) {
            throw new ParameterError(
                'Event usage date range cannot exceed 366 days.',
            );
        }

        return {
            dateFrom: resolvedDateFrom,
            dateTo: resolvedDateTo,
        };
    }

    private static validateDateString(value: string, label: string): void {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            throw new ParameterError(`${label} must use YYYY-MM-DD format.`);
        }
        const parsed = new Date(`${value}T00:00:00.000Z`);
        if (
            Number.isNaN(parsed.getTime()) ||
            parsed.toISOString().slice(0, 10) !== value
        ) {
            throw new ParameterError(`${label} must be a valid calendar date.`);
        }
    }

    private static addDays(value: string, days: number): string {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        parsed.setUTCDate(parsed.getUTCDate() + days);
        return parsed.toISOString().slice(0, 10);
    }

    private static toAccountEventUsage({
        lookbackDays,
        dateRange,
        selectedEventNames,
        rows,
    }: {
        lookbackDays: number;
        dateRange: ChurnScoreEventUsageDateRange;
        selectedEventNames: string[];
        rows: ChurnScoreAccountEventUsageRow[];
    }): Protopie.ChurnScoreAccountEventUsage {
        const events = new Map<string, Protopie.ChurnScoreAccountEventSummary>(
            selectedEventNames.map((eventName) => [
                eventName,
                {
                    eventName,
                    eventCount: 0,
                    activeUsers: 0,
                    activeDays: 0,
                    shareOfEvents: 0,
                    firstSeenAt: null,
                    lastSeenAt: null,
                },
            ]),
        );
        const activeDaysByEvent = new Map<string, Set<string>>();
        const userCountByEvent = new Map<string, number>();
        const daily = rows.map((row) => {
            const eventName = String(row.event_name);
            const eventDate = ChurnScoreService.toDateString(row.event_date);
            const eventCount = ChurnScoreService.numberValue(row.event_count);
            const activeUsers = ChurnScoreService.numberValue(row.active_users);
            const firstSeenAt = ChurnScoreService.toIsoString(
                row.first_seen_at,
            );
            const lastSeenAt = ChurnScoreService.toIsoString(row.last_seen_at);
            const summary = events.get(eventName) ?? {
                eventName,
                eventCount: 0,
                activeUsers: 0,
                activeDays: 0,
                shareOfEvents: 0,
                firstSeenAt: null,
                lastSeenAt: null,
            };

            summary.eventCount = ChurnScoreService.numberValue(
                row.event_total_count,
            );
            summary.activeUsers = ChurnScoreService.numberValue(
                row.event_active_users,
            );
            summary.activeDays = ChurnScoreService.numberValue(
                row.event_active_days,
            );
            summary.firstSeenAt = firstSeenAt;
            summary.lastSeenAt = lastSeenAt;
            events.set(eventName, summary);

            const activeDays = activeDaysByEvent.get(eventName) ?? new Set();
            activeDays.add(eventDate);
            activeDaysByEvent.set(eventName, activeDays);
            userCountByEvent.set(eventName, summary.activeUsers);

            return {
                eventDate,
                eventName,
                eventCount,
                activeUsers,
            };
        });
        const totalEvents = Array.from(events.values()).reduce(
            (sum, event) => sum + event.eventCount,
            0,
        );
        const eventSummaries = Array.from(events.values())
            .map((event) => ({
                ...event,
                activeUsers:
                    event.activeUsers ||
                    userCountByEvent.get(event.eventName) ||
                    0,
                activeDays:
                    event.activeDays ||
                    activeDaysByEvent.get(event.eventName)?.size ||
                    0,
                shareOfEvents:
                    totalEvents > 0
                        ? ChurnScoreService.round(
                              event.eventCount / totalEvents,
                              4,
                          )
                        : 0,
            }))
            .sort((a, b) => b.eventCount - a.eventCount);

        return {
            lookbackDays,
            dateFrom: dateRange.dateFrom,
            dateTo: dateRange.dateTo,
            totalEvents,
            selectedEventNames,
            events: eventSummaries,
            daily,
        };
    }

    private static numberValue(value: unknown): number {
        const parsed = Number(value ?? 0);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private static round(value: number, decimals: number): number {
        const multiplier = 10 ** decimals;
        return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
    }

    private static toDateString(value: Date | string): string {
        if (value instanceof Date) {
            return value.toISOString().slice(0, 10);
        }

        return String(value).slice(0, 10);
    }

    private static toIsoString(value: Date | string | null): string | null {
        if (!value) return null;
        if (value instanceof Date) return value.toISOString();
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime())
            ? String(value)
            : parsed.toISOString();
    }

    private static getWarehouseSchema(
        credentials: CreateWarehouseCredentials,
    ): string {
        if ('schema' in credentials) {
            ChurnScoreService.validateWarehouseIdentifier(
                credentials.schema,
                'warehouse schema',
            );
            return credentials.schema;
        }

        throw new ParameterError(
            'Churn score requires a warehouse connection with a schema.',
        );
    }

    private static validateWarehouseIdentifier(
        value: string,
        label: string,
    ): void {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
            throw new ParameterError(`Invalid ${label}: ${value}`);
        }
    }

    private static assertFactorWeightsTotal(
        factors: Array<{ maxPoints: number }>,
    ): void {
        const total = factors.reduce(
            (sum, factor) => sum + Number(factor.maxPoints || 0),
            0,
        );
        if (Math.abs(total - 100) > 0.000001) {
            throw new ParameterError(
                `Churn score factor weights must total 100. Current total is ${total}.`,
            );
        }
    }

    private static toFactorInput(
        factor: ProtopieChurnScoreFactorRecord,
    ): Protopie.ChurnScoreFactorInput {
        return {
            factorKey: factor.factorKey,
            label: factor.label,
            maxPoints: factor.maxPoints,
            goalValue: factor.goalValue,
            goalUnit: factor.goalUnit,
            aggregation: factor.aggregation,
            eventGroup: factor.eventGroup,
            stepThresholds: factor.stepThresholds ?? null,
            sortOrder: factor.sortOrder,
        };
    }

    private requireProjectView(user: SessionUser, projectUuid: string): void {
        const organizationUuid = ChurnScoreService.requireOrganization(user);
        const ability = this.createAuditedAbility(user);
        if (
            ability.cannot(
                'view',
                subject('Project', {
                    organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }
    }

    private canManageProject(user: SessionUser, projectUuid: string): boolean {
        const organizationUuid = ChurnScoreService.requireOrganization(user);
        const ability = this.createAuditedAbility(user);
        const projectSubject = subject('Project', {
            organizationUuid,
            projectUuid,
        });
        const organizationSubject = subject('Organization', {
            organizationUuid,
        });

        return (
            ability.can('manage', projectSubject) ||
            ability.can('manage', organizationSubject)
        );
    }

    private requireProjectManage(user: SessionUser, projectUuid: string): void {
        if (!this.canManageProject(user, projectUuid)) {
            throw new ForbiddenError();
        }
    }

    private requireConfigView(
        user: SessionUser,
        projectUuid: string,
        config: ProtopieChurnScoreConfigRecord,
    ): void {
        this.requireProjectView(user, projectUuid);
        if (
            ChurnScoreService.isDefaultConfig(config.name) ||
            config.createdByUserUuid === user.userUuid ||
            this.canManageProject(user, projectUuid)
        ) {
            return;
        }

        throw new ForbiddenError(
            'You can only view your own churn score rubrics.',
        );
    }

    private requireConfigEdit(
        user: SessionUser,
        projectUuid: string,
        config: ProtopieChurnScoreConfigRecord | undefined,
        name: string,
    ): void {
        const isDefault = ChurnScoreService.isDefaultConfig(name);
        if (isDefault) {
            this.requireProjectManage(user, projectUuid);
            return;
        }

        this.requireProjectView(user, projectUuid);
        if (
            !config ||
            config.createdByUserUuid === user.userUuid ||
            this.canManageProject(user, projectUuid)
        ) {
            return;
        }

        throw new ForbiddenError(
            `A churn score rubric named "${name}" already exists. Choose a different name.`,
        );
    }

    private static isDefaultConfig(name: string): boolean {
        return name === Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;
    }

    private static sortDefaultFirst(
        configs: ProtopieChurnScoreConfigRecord[],
    ): ProtopieChurnScoreConfigRecord[] {
        return [...configs].sort((a, b) => {
            const aDefault = ChurnScoreService.isDefaultConfig(a.name);
            const bDefault = ChurnScoreService.isDefaultConfig(b.name);
            if (aDefault && !bDefault) return -1;
            if (!aDefault && bDefault) return 1;
            return a.name.localeCompare(b.name);
        });
    }

    private static requireOrganization(user: SessionUser): string {
        if (!user.organizationUuid) {
            throw new ForbiddenError(
                'Churn score recompute requires an organization-scoped user.',
            );
        }

        return user.organizationUuid;
    }
}
