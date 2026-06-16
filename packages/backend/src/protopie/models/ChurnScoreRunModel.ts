import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type DbChurnScoreRun = {
    run_uuid: string;
    project_uuid: string;
    config_uuid: string;
    triggered_by: Protopie.ChurnScoreRunTrigger;
    triggered_by_user_uuid: string | null;
    status: Protopie.ChurnScoreRunStatus;
    started_at: Date | null;
    finished_at: Date | null;
    accounts_scored: number;
    error_message: string | null;
    created_at: Date;
};

export type ProtopieChurnScoreRunRecord = Protopie.ChurnScoreRun;

export class ChurnScoreRunModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async insertRun({
        projectUuid,
        configUuid,
        triggeredBy,
        triggeredByUserUuid,
    }: {
        projectUuid: string;
        configUuid: string;
        triggeredBy: Protopie.ChurnScoreRunTrigger;
        triggeredByUserUuid: string | null;
    }): Promise<ProtopieChurnScoreRunRecord> {
        const [row] = await this.database<DbChurnScoreRun>(
            ProtopieTableName.ChurnScoreRuns,
        )
            .insert({
                project_uuid: projectUuid,
                config_uuid: configUuid,
                triggered_by: triggeredBy,
                triggered_by_user_uuid: triggeredByUserUuid,
                status: 'queued',
            })
            .returning('*');

        return ChurnScoreRunModel.toRecord(row);
    }

    async get({
        projectUuid,
        runUuid,
    }: {
        projectUuid: string;
        runUuid: string;
    }): Promise<ProtopieChurnScoreRunRecord | undefined> {
        const row = await this.database<DbChurnScoreRun>(
            ProtopieTableName.ChurnScoreRuns,
        )
            .where({
                project_uuid: projectUuid,
                run_uuid: runUuid,
            })
            .first();

        return row ? ChurnScoreRunModel.toRecord(row) : undefined;
    }

    async getByUuid(
        runUuid: string,
    ): Promise<ProtopieChurnScoreRunRecord | undefined> {
        const row = await this.database<DbChurnScoreRun>(
            ProtopieTableName.ChurnScoreRuns,
        )
            .where('run_uuid', runUuid)
            .first();

        return row ? ChurnScoreRunModel.toRecord(row) : undefined;
    }

    async list({
        projectUuid,
        limit,
    }: {
        projectUuid: string;
        limit: number;
    }): Promise<ProtopieChurnScoreRunRecord[]> {
        const rows = await this.database<DbChurnScoreRun>(
            ProtopieTableName.ChurnScoreRuns,
        )
            .where('project_uuid', projectUuid)
            .orderBy('created_at', 'desc')
            .limit(limit);

        return rows.map((row) => ChurnScoreRunModel.toRecord(row));
    }

    async markRunning(runUuid: string): Promise<void> {
        await this.database<DbChurnScoreRun>(ProtopieTableName.ChurnScoreRuns)
            .where('run_uuid', runUuid)
            .update({
                status: 'running',
                started_at: this.database.fn.now(),
                error_message: null,
            });
    }

    async markCompleted({
        runUuid,
        accountsScored,
    }: {
        runUuid: string;
        accountsScored: number;
    }): Promise<void> {
        await this.database<DbChurnScoreRun>(ProtopieTableName.ChurnScoreRuns)
            .where('run_uuid', runUuid)
            .update({
                status: 'completed',
                finished_at: this.database.fn.now(),
                accounts_scored: accountsScored,
                error_message: null,
            });
    }

    async markSkipped({
        runUuid,
        reason,
    }: {
        runUuid: string;
        reason: string;
    }): Promise<void> {
        await this.database<DbChurnScoreRun>(ProtopieTableName.ChurnScoreRuns)
            .where('run_uuid', runUuid)
            .update({
                status: 'skipped',
                finished_at: this.database.fn.now(),
                accounts_scored: 0,
                error_message: reason,
            });
    }

    async markFailed({
        runUuid,
        errorMessage,
    }: {
        runUuid: string;
        errorMessage: string;
    }): Promise<void> {
        await this.database<DbChurnScoreRun>(ProtopieTableName.ChurnScoreRuns)
            .where('run_uuid', runUuid)
            .update({
                status: 'failed',
                finished_at: this.database.fn.now(),
                error_message: errorMessage,
            });
    }

    private static toRecord(row: DbChurnScoreRun): ProtopieChurnScoreRunRecord {
        return {
            runUuid: row.run_uuid,
            projectUuid: row.project_uuid,
            configUuid: row.config_uuid,
            triggeredBy: row.triggered_by,
            triggeredByUserUuid: row.triggered_by_user_uuid,
            status: row.status,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            accountsScored: Number(row.accounts_scored),
            errorMessage: row.error_message,
            createdAt: row.created_at,
        };
    }
}
