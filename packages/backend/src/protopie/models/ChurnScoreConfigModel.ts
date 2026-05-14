import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type Queryable = Knex | Knex.Transaction;

type DbChurnScoreConfig = {
    config_uuid: string;
    project_uuid: string;
    name: string;
    version: number;
    lookback_days: number;
    score_function: Protopie.ChurnScoreFunction;
    risk_band_thresholds: Protopie.ChurnScoreRiskBandThresholds;
    effective_from: Date;
    effective_to: Date | null;
    status: Protopie.ChurnScoreConfigStatus;
    created_by_user_uuid: string | null;
    updated_by_user_uuid: string | null;
    created_at: Date;
    updated_at: Date;
};

export type ProtopieChurnScoreConfigRecord = Protopie.ChurnScoreConfig;

export class ChurnScoreConfigModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async getActiveConfig({
        projectUuid,
        name = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        trx,
    }: {
        projectUuid: string;
        name?: string;
        trx?: Knex.Transaction;
    }): Promise<ProtopieChurnScoreConfigRecord | undefined> {
        const row = await this.query(trx)
            .where({
                project_uuid: projectUuid,
                name,
                status: 'active',
            })
            .whereNull('effective_to')
            .first();

        return row ? ChurnScoreConfigModel.toRecord(row) : undefined;
    }

    async getByUuid({
        configUuid,
        trx,
    }: {
        configUuid: string;
        trx?: Knex.Transaction;
    }): Promise<ProtopieChurnScoreConfigRecord | undefined> {
        const row = await this.query(trx)
            .where('config_uuid', configUuid)
            .first();

        return row ? ChurnScoreConfigModel.toRecord(row) : undefined;
    }

    async listVersions({
        projectUuid,
        name = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
    }: {
        projectUuid: string;
        name?: string;
    }): Promise<ProtopieChurnScoreConfigRecord[]> {
        const rows = await this.query()
            .where({
                project_uuid: projectUuid,
                name,
            })
            .orderBy('version', 'desc');

        return rows.map((row) => ChurnScoreConfigModel.toRecord(row));
    }

    async getNextVersion({
        projectUuid,
        name = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        trx,
    }: {
        projectUuid: string;
        name?: string;
        trx?: Knex.Transaction;
    }): Promise<number> {
        const row = await this.query(trx)
            .where({
                project_uuid: projectUuid,
                name,
            })
            .max<{ maxVersion: string | number | null }[]>({
                maxVersion: 'version',
            })
            .first();

        return Number(row?.maxVersion ?? 0) + 1;
    }

    async archiveActive({
        projectUuid,
        name = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        userUuid,
        trx,
    }: {
        projectUuid: string;
        name?: string;
        userUuid: string | null;
        trx: Knex.Transaction;
    }): Promise<void> {
        await this.query(trx)
            .where({
                project_uuid: projectUuid,
                name,
                status: 'active',
            })
            .whereNull('effective_to')
            .update({
                status: 'archived',
                effective_to: trx.fn.now(),
                updated_by_user_uuid: userUuid,
                updated_at: trx.fn.now(),
            });
    }

    async insertConfig({
        projectUuid,
        name = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        version,
        lookbackDays,
        scoreFunction,
        riskBandThresholds,
        status = 'active',
        userUuid,
        trx,
    }: {
        projectUuid: string;
        name?: string;
        version: number;
        lookbackDays: number;
        scoreFunction: Protopie.ChurnScoreFunction;
        riskBandThresholds: Protopie.ChurnScoreRiskBandThresholds;
        status?: Protopie.ChurnScoreConfigStatus;
        userUuid: string | null;
        trx: Knex.Transaction;
    }): Promise<ProtopieChurnScoreConfigRecord> {
        const [row] = await this.query(trx)
            .insert({
                project_uuid: projectUuid,
                name,
                version,
                lookback_days: lookbackDays,
                score_function: scoreFunction,
                risk_band_thresholds: riskBandThresholds,
                status,
                created_by_user_uuid: userUuid,
                updated_by_user_uuid: userUuid,
            })
            .returning('*');

        return ChurnScoreConfigModel.toRecord(row);
    }

    private query(trx?: Queryable) {
        return (trx ?? this.database)<DbChurnScoreConfig>(
            ProtopieTableName.ChurnScoreConfigs,
        );
    }

    private static toRecord(
        row: DbChurnScoreConfig,
    ): ProtopieChurnScoreConfigRecord {
        return {
            configUuid: row.config_uuid,
            projectUuid: row.project_uuid,
            name: row.name,
            version: Number(row.version),
            lookbackDays: Number(row.lookback_days),
            scoreFunction: row.score_function,
            riskBandThresholds: row.risk_band_thresholds,
            effectiveFrom: row.effective_from,
            effectiveTo: row.effective_to,
            status: row.status,
            createdByUserUuid: row.created_by_user_uuid,
            updatedByUserUuid: row.updated_by_user_uuid,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
