import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type Queryable = Knex | Knex.Transaction;

type DbChurnScoreFactor = {
    factor_uuid: string;
    config_uuid: string;
    factor_key: string;
    label: string;
    max_points: string | number;
    goal_value: string | number;
    goal_unit: Protopie.ChurnScoreGoalUnit;
    aggregation: Protopie.ChurnScoreAggregation;
    event_group: Protopie.ChurnScoreEventGroup;
    step_thresholds: Protopie.ChurnScoreStepThresholds | null;
    window_days: number | null;
    sort_order: number;
};

export type ProtopieChurnScoreFactorRecord = Protopie.ChurnScoreFactor;

export class ChurnScoreFactorModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async listByConfigUuid({
        configUuid,
        trx,
    }: {
        configUuid: string;
        trx?: Knex.Transaction;
    }): Promise<ProtopieChurnScoreFactorRecord[]> {
        const rows = await this.query(trx)
            .where('config_uuid', configUuid)
            .orderBy('sort_order', 'asc');

        return rows.map((row) => ChurnScoreFactorModel.toRecord(row));
    }

    async insertFactors({
        configUuid,
        factors,
        trx,
    }: {
        configUuid: string;
        factors: Protopie.ChurnScoreFactorInput[];
        trx: Knex.Transaction;
    }): Promise<ProtopieChurnScoreFactorRecord[]> {
        if (factors.length === 0) {
            return [];
        }

        const rows = await this.query(trx)
            .insert(
                factors.map((factor) => ({
                    config_uuid: configUuid,
                    factor_key: factor.factorKey,
                    label: factor.label,
                    max_points: factor.maxPoints,
                    goal_value: factor.goalValue,
                    goal_unit: factor.goalUnit,
                    aggregation: factor.aggregation,
                    event_group: factor.eventGroup,
                    step_thresholds: factor.stepThresholds ?? null,
                    window_days: factor.windowDays ?? null,
                    sort_order: factor.sortOrder,
                })),
            )
            .returning('*');

        return rows.map((row) => ChurnScoreFactorModel.toRecord(row));
    }

    private query(trx?: Queryable) {
        return (trx ?? this.database)<DbChurnScoreFactor>(
            ProtopieTableName.ChurnScoreFactors,
        );
    }

    private static toRecord(
        row: DbChurnScoreFactor,
    ): ProtopieChurnScoreFactorRecord {
        return {
            factorUuid: row.factor_uuid,
            configUuid: row.config_uuid,
            factorKey: row.factor_key,
            label: row.label,
            maxPoints: Number(row.max_points),
            goalValue: Number(row.goal_value),
            goalUnit: row.goal_unit,
            aggregation: row.aggregation,
            eventGroup: row.event_group,
            stepThresholds: row.step_thresholds,
            windowDays:
                row.window_days === null ? null : Number(row.window_days),
            sortOrder: Number(row.sort_order),
        };
    }
}
