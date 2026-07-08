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
import { type SlackClient } from '../../clients/Slack/SlackClient';
import Logger from '../../logging/logger';
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
    slackClient: SlackClient;
    churnScoreConfigModel: ChurnScoreConfigModel;
    churnScoreFactorModel: ChurnScoreFactorModel;
    churnScoreModel: ChurnScoreModel;
    churnScoreRunModel: ChurnScoreRunModel;
};

/**
 * Max age (in days) of the churn marts' latest event before a recompute is
 * skipped. ChurnScore is a 90-day rolling metric, so a 1-2 day lag is
 * immaterial; this guard only protects against an empty or clearly-broken
 * (e.g. dbt failed) mart, never overwriting good scores with garbage.
 */
const MART_STALE_MAX_AGE_DAYS = 2;

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
    minSelectableDate: string;
    maxSelectableDate: string;
};

export class ChurnScoreService extends BaseService {
    private readonly database: Knex;

    private readonly projectModel: ProjectModel;

    private readonly projectService: ProjectService;

    private readonly schedulerClient: SchedulerClient;

    private readonly slackClient: SlackClient;

    private readonly churnScoreConfigModel: ChurnScoreConfigModel;

    private readonly churnScoreFactorModel: ChurnScoreFactorModel;

    private readonly churnScoreModel: ChurnScoreModel;

    private readonly churnScoreRunModel: ChurnScoreRunModel;

    constructor({
        database,
        projectModel,
        projectService,
        schedulerClient,
        slackClient,
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
        this.slackClient = slackClient;
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

    async deleteConfig({
        projectUuid,
        name,
        user,
    }: {
        projectUuid: string;
        name: string;
        user: SessionUser;
    }): Promise<{ deleted: true }> {
        const trimmedName = name?.trim();
        if (!trimmedName) {
            throw new ParameterError('A rubric name is required.');
        }
        if (ChurnScoreService.isDefaultConfig(trimmedName)) {
            throw new ForbiddenError(
                'The default churn score rubric cannot be deleted.',
            );
        }

        const active = await this.churnScoreConfigModel.getActiveConfig({
            projectUuid,
            name: trimmedName,
        });
        if (!active) {
            throw new NotFoundError(
                `Churn score rubric does not exist: ${trimmedName}`,
            );
        }
        this.requireConfigEdit(user, projectUuid, active, trimmedName);

        await this.database.transaction(async (trx) => {
            await this.churnScoreConfigModel.softDeleteByName({
                projectUuid,
                name: trimmedName,
                userUuid: user.userUuid,
                trx,
            });
        });

        return { deleted: true };
    }

    async renameConfig({
        projectUuid,
        currentName,
        newName,
        user,
    }: {
        projectUuid: string;
        currentName: string;
        newName: string;
        user: SessionUser;
    }): Promise<Protopie.ChurnScoreConfigWithFactors> {
        const trimmedCurrentName = currentName?.trim();
        const trimmedNewName = newName?.trim();

        if (!trimmedCurrentName || !trimmedNewName) {
            throw new ParameterError(
                'Both current and new names are required.',
            );
        }
        if (ChurnScoreService.isDefaultConfig(trimmedCurrentName)) {
            throw new ForbiddenError(
                'The default churn score rubric cannot be renamed.',
            );
        }
        if (ChurnScoreService.isDefaultConfig(trimmedNewName)) {
            throw new ParameterError(
                'A rubric cannot use the default rubric name.',
            );
        }
        if (trimmedNewName === trimmedCurrentName) {
            throw new ParameterError('The new name must be different.');
        }

        const active = await this.churnScoreConfigModel.getActiveConfig({
            projectUuid,
            name: trimmedCurrentName,
        });
        if (!active) {
            throw new NotFoundError(
                `Churn score rubric does not exist: ${trimmedCurrentName}`,
            );
        }
        this.requireConfigEdit(user, projectUuid, active, trimmedCurrentName);

        // Collision guard: a soft-deleted rubric still owns its
        // (project, name, version) rows, so renaming onto any existing name —
        // active, archived, or deleted — would violate the unique index.
        const taken = await this.churnScoreConfigModel.nameExistsInAnyStatus({
            projectUuid,
            name: trimmedNewName,
        });
        if (taken) {
            throw new ParameterError(
                `A churn score rubric named "${trimmedNewName}" already exists. Choose a different name.`,
            );
        }

        await this.database.transaction(async (trx) => {
            await this.churnScoreConfigModel.renameByName({
                projectUuid,
                currentName: trimmedCurrentName,
                newName: trimmedNewName,
                userUuid: user.userUuid,
                trx,
            });
        });

        return this.getActiveConfigByName({
            projectUuid,
            name: trimmedNewName,
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

        // External deep links (e.g. the honmoon license card) omit configUuid.
        // Rather than fall back to "latest computed row across all configs" —
        // non-deterministic when several configs are active — resolve the
        // canonical default rubric by its stable name. config_uuid changes on
        // every re-version but the name does not, so the link always tracks the
        // latest active "Default Churn Score" without callers hardcoding a UUID.
        const resolvedConfigUuid =
            configUuid ??
            (
                await this.churnScoreConfigModel.getActiveConfig({
                    projectUuid,
                    name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
                })
            )?.configUuid;

        const score = await this.churnScoreModel.getLatestScoreByAccount({
            projectUuid,
            accountKey: trimmedAccountKey,
            configUuid: resolvedConfigUuid,
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
            accountUrl: score.cloudUrl ?? trimmedAccountKey,
            config,
            factors,
            scoredForDate: score.scoredForDate,
            dateFrom,
            dateTo,
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

    async executeRecompute(
        runUuid: string,
        organizationUuid: string | null = null,
    ): Promise<void> {
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

            // Freshness gate: never overwrite good scores from an empty/stale
            // mart (e.g. dbt failed). Skip + alert, preserve prior scores.
            const freshness = await this.checkMartFreshness(run.projectUuid);
            if (!freshness.fresh) {
                await this.churnScoreRunModel.markSkipped({
                    runUuid,
                    reason: freshness.reason,
                });
                await this.notifyRecomputeSkipped({
                    organizationUuid,
                    projectUuid: run.projectUuid,
                    reason: freshness.reason,
                    maxEventDate: freshness.maxEventDate,
                    runUuid,
                });
                return;
            }

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
                    scoreFunction: config.scoreFunction,
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
                    churnScore: result.churnScore,
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
                scoreFunction: Protopie.DEFAULT_CHURN_SCORE_FUNCTION,
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
        accountUrl,
        config,
        factors,
        scoredForDate,
        dateFrom,
        dateTo,
    }: {
        projectUuid: string;
        accountUrl: string;
        config: ProtopieChurnScoreConfigRecord;
        factors: ProtopieChurnScoreFactorRecord[];
        scoredForDate: string;
        dateFrom?: string;
        dateTo?: string;
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

        const credentials =
            await this.projectModel.getWarehouseCredentialsForProject(
                projectUuid,
            );
        const schema = ChurnScoreService.getWarehouseSchema(credentials);
        const { warehouseClient, sshTunnel } =
            await this.projectService._getWarehouseClient(
                projectUuid,
                credentials,
            );

        try {
            // Selectable bounds are anchored to the mart-wide latest event_date
            // (across all accounts), not this account's data or the score date.
            const martMaxResult = await warehouseClient.runQuery(
                `SELECT max(event_date) AS mart_max FROM ${schema}.protopie_account_event_usage`,
                {
                    project_uuid: projectUuid,
                    query_context: QueryExecutionContext.API,
                },
                credentials.dataTimezone,
                [],
            );
            const martMaxRaw = (
                martMaxResult.rows[0] as
                    | { mart_max?: Date | string | null }
                    | undefined
            )?.mart_max;
            const martMax = martMaxRaw
                ? ChurnScoreService.toDateString(martMaxRaw)
                : scoredForDate;
            const dateRange = ChurnScoreService.resolveEventUsageDateRange({
                martMax,
                dateFrom,
                dateTo,
            });

            if (selectedEventNames.length === 0) {
                return ChurnScoreService.toAccountEventUsage({
                    lookbackDays: config.lookbackDays,
                    dateRange,
                    selectedEventNames,
                    rows: [],
                });
            }

            const values = [accountUrl, dateRange.dateFrom, dateRange.dateTo];
            const eventPlaceholders = selectedEventNames.map((eventName) => {
                values.push(eventName);
                return `$${values.length}`;
            });
            const sql = `
            WITH account_usage AS (
                SELECT
                    event_date,
                    event_name,
                    user_id,
                    event_count,
                    first_seen_at,
                    last_seen_at
                FROM ${schema}.protopie_account_event_usage
                WHERE account_url = $1
                  AND event_date >= $2::date
                  AND event_date <= $3::date
                  AND event_name IN (${eventPlaceholders.join(', ')})
            ), daily AS (
                SELECT
                    event_date,
                    event_name,
                    SUM(event_count) AS event_count,
                    COUNT(DISTINCT user_id) AS active_users
                FROM account_usage
                GROUP BY event_date, event_name
            ), event_summary AS (
                SELECT
                    event_name,
                    SUM(event_count) AS event_total_count,
                    COUNT(DISTINCT user_id) AS event_active_users,
                    COUNT(DISTINCT event_date) AS event_active_days,
                    MIN(first_seen_at) AS first_seen_at,
                    MAX(last_seen_at) AS last_seen_at
                FROM account_usage
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

    private async checkMartFreshness(projectUuid: string): Promise<{
        fresh: boolean;
        reason: string;
        maxEventDate: string | null;
    }> {
        const credentials =
            await this.projectModel.getWarehouseCredentialsForProject(
                projectUuid,
            );
        const schema = ChurnScoreService.getWarehouseSchema(credentials);
        const sql = `
            SELECT
                MAX(event_date) AS max_event_date,
                COUNT(*) AS row_count
            FROM ${schema}.protopie_account_event_usage
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
                [],
            );
            const row = (results.rows[0] ?? {}) as {
                max_event_date?: Date | string | null;
                row_count?: number | string;
            };
            const rowCount = ChurnScoreService.numberValue(row.row_count);
            const maxEventDate = row.max_event_date
                ? ChurnScoreService.toDateString(row.max_event_date)
                : null;

            if (rowCount === 0 || !maxEventDate) {
                return {
                    fresh: false,
                    reason: 'Churn mart protopie_account_event_usage is empty.',
                    maxEventDate: null,
                };
            }

            const ageDays = ChurnScoreService.daysAgo(maxEventDate);
            if (ageDays > MART_STALE_MAX_AGE_DAYS) {
                return {
                    fresh: false,
                    reason: `Churn mart is stale: last event ${maxEventDate} (${ageDays} days old, threshold ${MART_STALE_MAX_AGE_DAYS}).`,
                    maxEventDate,
                };
            }

            return { fresh: true, reason: '', maxEventDate };
        } finally {
            await sshTunnel.disconnect();
        }
    }

    private async notifyRecomputeSkipped({
        organizationUuid,
        projectUuid,
        reason,
        maxEventDate,
        runUuid,
    }: {
        organizationUuid: string | null;
        projectUuid: string;
        reason: string;
        maxEventDate: string | null;
        runUuid: string;
    }): Promise<void> {
        const scoredForDate = new Date().toISOString().slice(0, 10);
        const text = [
            ':warning: *Churn score recompute skipped*',
            `• Project: ${projectUuid}`,
            `• Date: ${scoredForDate}`,
            `• Reason: ${reason}`,
            `• Mart last event: ${maxEventDate ?? 'n/a'}`,
            '• Previous scores preserved (not overwritten).',
            `• Run: ${runUuid}`,
        ].join('\n');

        if (!organizationUuid) {
            Logger.warn(
                `Churn recompute skipped for project ${projectUuid} (no organizationUuid for Slack alert): ${reason}`,
            );
            return;
        }

        try {
            await this.slackClient.postMessageToNotificationChannel({
                organizationUuid,
                text,
            });
        } catch (error) {
            // An alert failure must never crash the recompute worker.
            Logger.warn(
                `Failed to send churn recompute skip alert to Slack: ${getErrorMessage(
                    error,
                )}`,
            );
        }
    }

    private static daysAgo(dateString: string): number {
        const then = new Date(`${dateString}T00:00:00.000Z`).getTime();
        const today = new Date(
            `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
        ).getTime();
        return Math.floor((today - then) / (24 * 60 * 60 * 1000));
    }

    private static resolveEventUsageDateRange({
        martMax,
        dateFrom,
        dateTo,
    }: {
        martMax: string;
        dateFrom?: string;
        dateTo?: string;
    }): ChurnScoreEventUsageDateRange {
        ChurnScoreService.validateDateString(martMax, 'martMax');
        // The selectable window is the most recent N days of the mart, anchored
        // to its latest event_date across all accounts.
        const maxSelectableDate = martMax;
        const minSelectableDate = ChurnScoreService.addDays(
            martMax,
            -(Protopie.CHURN_SCORE_EVENT_USAGE_WINDOW_DAYS - 1),
        );

        const resolvedDateTo = dateTo?.trim() || maxSelectableDate;
        ChurnScoreService.validateDateString(resolvedDateTo, 'dateTo');
        const resolvedDateFrom = dateFrom?.trim() || minSelectableDate;
        ChurnScoreService.validateDateString(resolvedDateFrom, 'dateFrom');

        // Validated YYYY-MM-DD strings compare chronologically as strings.
        if (
            resolvedDateFrom < minSelectableDate ||
            resolvedDateFrom > maxSelectableDate
        ) {
            throw new ParameterError(
                `dateFrom must be between ${minSelectableDate} and ${maxSelectableDate}.`,
            );
        }
        if (
            resolvedDateTo < minSelectableDate ||
            resolvedDateTo > maxSelectableDate
        ) {
            throw new ParameterError(
                `dateTo must be between ${minSelectableDate} and ${maxSelectableDate}.`,
            );
        }
        if (resolvedDateFrom > resolvedDateTo) {
            throw new ParameterError(
                'dateFrom must be before or equal to dateTo.',
            );
        }

        return {
            dateFrom: resolvedDateFrom,
            dateTo: resolvedDateTo,
            minSelectableDate,
            maxSelectableDate,
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
            minSelectableDate: dateRange.minSelectableDate,
            maxSelectableDate: dateRange.maxSelectableDate,
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
            windowDays: factor.windowDays ?? null,
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
