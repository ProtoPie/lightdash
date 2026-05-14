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
        user,
    }: {
        projectUuid: string;
        user: SessionUser;
    }): Promise<Protopie.ChurnScoreConfigWithFactors> {
        this.requireProjectView(user, projectUuid);
        return this.getOrCreateActiveConfig(projectUuid);
    }

    async listVersions({
        projectUuid,
        user,
    }: {
        projectUuid: string;
        user: SessionUser;
    }): Promise<ProtopieChurnScoreConfigRecord[]> {
        this.requireProjectView(user, projectUuid);
        await this.getOrCreateActiveConfig(projectUuid);
        return this.churnScoreConfigModel.listVersions({ projectUuid });
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
        this.requireProjectManage(user, projectUuid);
        const validated = validateChurnScoreConfigInput(payload);

        return this.database.transaction(async (trx) => {
            const name =
                validated.name ?? Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;
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

    async enqueueRecompute({
        projectUuid,
        user,
        triggeredBy = 'manual',
    }: {
        projectUuid: string;
        user: SessionUser;
        triggeredBy?: Protopie.ChurnScoreRunTrigger;
    }): Promise<{ runUuid: string; status: 'queued' }> {
        this.requireProjectManage(user, projectUuid);
        const organizationUuid = ChurnScoreService.requireOrganization(user);
        const { config } = await this.getOrCreateActiveConfig(projectUuid);

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
        const { config } = await this.getOrCreateActiveConfig(projectUuid);
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

    private async getOrCreateActiveConfig(
        projectUuid: string,
    ): Promise<Protopie.ChurnScoreConfigWithFactors> {
        const active = await this.churnScoreConfigModel.getActiveConfig({
            projectUuid,
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

    private static getWarehouseSchema(
        credentials: CreateWarehouseCredentials,
    ): string {
        if ('schema' in credentials) {
            return credentials.schema;
        }

        throw new ParameterError(
            'Churn score requires a warehouse connection with a schema.',
        );
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

    private requireProjectManage(user: SessionUser, projectUuid: string): void {
        const organizationUuid = ChurnScoreService.requireOrganization(user);
        const ability = this.createAuditedAbility(user);
        const projectSubject = subject('Project', {
            organizationUuid,
            projectUuid,
        });
        const organizationSubject = subject('Organization', {
            organizationUuid,
        });

        if (
            ability.cannot('manage', projectSubject) &&
            ability.cannot('manage', organizationSubject)
        ) {
            throw new ForbiddenError();
        }
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
