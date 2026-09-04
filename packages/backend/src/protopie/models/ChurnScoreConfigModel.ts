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
    visibility: Protopie.ChurnScoreConfigVisibility;
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

    async listActiveConfigs({
        projectUuid,
    }: {
        projectUuid: string;
    }): Promise<ProtopieChurnScoreConfigRecord[]> {
        const rows = await this.query()
            .where({
                project_uuid: projectUuid,
                status: 'active',
            })
            .whereNull('effective_to')
            .orderBy('name', 'asc');

        return rows.map((row) => ChurnScoreConfigModel.toRecord(row));
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
        visibility = Protopie.DEFAULT_CHURN_SCORE_VISIBILITY,
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
        visibility?: Protopie.ChurnScoreConfigVisibility;
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
                visibility,
                status,
                created_by_user_uuid: userUuid,
                updated_by_user_uuid: userUuid,
            })
            .returning('*');

        return ChurnScoreConfigModel.toRecord(row);
    }

    /**
     * Soft-delete every version of a rubric (by name) in one project. Scores and
     * runs that FK-reference these configs stay intact for audit; the rubric just
     * leaves every active-status query. Returns the number of rows marked.
     */
    async softDeleteByName({
        projectUuid,
        name,
        userUuid,
        trx,
    }: {
        projectUuid: string;
        name: string;
        userUuid: string | null;
        trx: Knex.Transaction;
    }): Promise<number> {
        return this.query(trx)
            .where({
                project_uuid: projectUuid,
                name,
            })
            .whereNot('status', 'deleted')
            .update({
                status: 'deleted',
                effective_to: trx.fn.now(),
                updated_by_user_uuid: userUuid,
                updated_at: trx.fn.now(),
            });
    }

    /**
     * Rename every version of a rubric. Scores key off config_uuid, not name, so
     * this is a label-only change. Returns the number of rows updated.
     */
    async renameByName({
        projectUuid,
        currentName,
        newName,
        userUuid,
        trx,
    }: {
        projectUuid: string;
        currentName: string;
        newName: string;
        userUuid: string | null;
        trx: Knex.Transaction;
    }): Promise<number> {
        return this.query(trx)
            .where({
                project_uuid: projectUuid,
                name: currentName,
            })
            .update({
                name: newName,
                updated_by_user_uuid: userUuid,
                updated_at: trx.fn.now(),
            });
    }

    /**
     * Load specific config versions by uuid, any status. Used to resolve which
     * rubrics a caller may read when a result set spans several of them.
     */
    async listConfigsByUuids({
        configUuids,
        trx,
    }: {
        configUuids: string[];
        trx?: Knex.Transaction;
    }): Promise<ProtopieChurnScoreConfigRecord[]> {
        if (configUuids.length === 0) {
            return [];
        }

        const rows = await this.query(trx).whereIn('config_uuid', configUuids);

        return rows.map((row) => ChurnScoreConfigModel.toRecord(row));
    }

    /**
     * Set visibility on every version of a rubric. Visibility belongs to the
     * rubric, not to one version — leaving old versions behind would produce a
     * rubric whose version history is half-shared. Returns rows updated.
     */
    async updateVisibilityByName({
        projectUuid,
        name,
        visibility,
        userUuid,
        trx,
    }: {
        projectUuid: string;
        name: string;
        visibility: Protopie.ChurnScoreConfigVisibility;
        userUuid: string | null;
        trx: Knex.Transaction;
    }): Promise<number> {
        return this.query(trx)
            .where({
                project_uuid: projectUuid,
                name,
            })
            .update({
                visibility,
                updated_by_user_uuid: userUuid,
                updated_at: trx.fn.now(),
            });
    }

    /**
     * True if any row (any status, including deleted) already uses this name in
     * the project. Rename collision guard: a deleted rubric still owns its
     * (project, name, version) rows, so renaming onto that name would violate the
     * unique index.
     */
    async nameExistsInAnyStatus({
        projectUuid,
        name,
        trx,
    }: {
        projectUuid: string;
        name: string;
        trx?: Knex.Transaction;
    }): Promise<boolean> {
        const row = await this.query(trx)
            .where({
                project_uuid: projectUuid,
                name,
            })
            .first();

        return Boolean(row);
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
            visibility: row.visibility,
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
