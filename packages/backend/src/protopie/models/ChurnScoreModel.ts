import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type DbChurnScore = {
    score_uuid: string;
    project_uuid: string;
    account_key: string;
    namespace: string | null;
    cloud_url: string | null;
    scored_for_date: string | Date;
    lookback_days: number;
    config_uuid: string;
    config_version: number;
    total_points: string | number;
    max_points: string | number;
    score_percent: string | number;
    normalized_score: string | number;
    risk_band: Protopie.ChurnScoreRiskBand;
    factor_scores: Protopie.ChurnScoreFactorScores;
    computed_at: Date;
    run_uuid: string;
};

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
                    scored_for_date: row.scoredForDate,
                    lookback_days: row.lookbackDays,
                    config_uuid: row.configUuid,
                    config_version: row.configVersion,
                    total_points: row.totalPoints,
                    max_points: row.maxPoints,
                    score_percent: row.scorePercent,
                    normalized_score: row.normalizedScore,
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
                config_version: this.database.raw('excluded.config_version'),
                total_points: this.database.raw('excluded.total_points'),
                max_points: this.database.raw('excluded.max_points'),
                score_percent: this.database.raw('excluded.score_percent'),
                normalized_score: this.database.raw(
                    'excluded.normalized_score',
                ),
                risk_band: this.database.raw('excluded.risk_band'),
                factor_scores: this.database.raw('excluded.factor_scores'),
                run_uuid: this.database.raw('excluded.run_uuid'),
                computed_at: this.database.fn.now(),
            });
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
        const latestScores = this.database<DbChurnScore>(
            ProtopieTableName.ChurnScores,
        )
            .distinctOn('account_key')
            .select('*')
            .where({
                project_uuid: projectUuid,
                config_uuid: configUuid,
            })
            .orderBy('account_key', 'asc')
            .orderBy('scored_for_date', 'desc')
            .orderBy('computed_at', 'desc')
            .as('latest_scores');
        const offset = Math.max(filters.offset ?? 0, 0);
        const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
        const query = this.database
            .select<DbChurnScore[]>('*')
            .from(latestScores)
            .orderBy('normalized_score', 'asc')
            .limit(limit)
            .offset(offset);

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

        const rows = await query;
        return rows.map((row) => ChurnScoreModel.toRecord(row));
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
            riskBand: row.risk_band,
            factorScores: row.factor_scores,
            computedAt: row.computed_at,
            runUuid: row.run_uuid,
        };
    }
}
