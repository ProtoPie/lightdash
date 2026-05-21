import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

const MESSAGES_FACTOR = Protopie.DEFAULT_CHURN_SCORE_FACTORS.find(
    (factor) => factor.factorKey === 'number_of_messages_received',
);

type ChurnScoreConfigRow = {
    config_uuid: string;
    project_uuid: string;
    name: string;
    lookback_days: number;
    score_function: Protopie.ChurnScoreFunction;
    risk_band_thresholds: Protopie.ChurnScoreRiskBandThresholds;
};

type ChurnScoreFactorRow = {
    factor_key: string;
    label: string;
    max_points: string | number;
    goal_value: string | number;
    goal_unit: Protopie.ChurnScoreGoalUnit;
    aggregation: Protopie.ChurnScoreAggregation;
    event_group: Protopie.ChurnScoreEventGroup;
    step_thresholds: Record<string, unknown> | null;
    sort_order: number;
};

export async function up(knex: Knex): Promise<void> {
    if (!MESSAGES_FACTOR) {
        return;
    }

    const activeConfigsMissingMessages = await knex
        .select<ChurnScoreConfigRow[]>([
            'c.config_uuid as config_uuid',
            'c.project_uuid as project_uuid',
            'c.name as name',
            'c.lookback_days as lookback_days',
            'c.score_function as score_function',
            'c.risk_band_thresholds as risk_band_thresholds',
        ])
        .from(`${ProtopieTableName.ChurnScoreConfigs} as c`)
        .where('c.status', 'active')
        .whereNull('c.effective_to')
        .whereNotExists(function missingFactor() {
            void this.select(knex.raw('1'))
                .from(`${ProtopieTableName.ChurnScoreFactors} as f`)
                .whereRaw('f.config_uuid = c.config_uuid')
                .where('f.factor_key', MESSAGES_FACTOR.factorKey);
        });

    // Each project gets a new active version so existing rubric history stays immutable.
    // eslint-disable-next-line no-restricted-syntax
    for (const sourceConfig of activeConfigsMissingMessages) {
        // eslint-disable-next-line no-await-in-loop
        await knex.transaction(async (trx) => {
            const [{ maxVersion }] = await trx(
                ProtopieTableName.ChurnScoreConfigs,
            )
                .where({
                    project_uuid: sourceConfig.project_uuid,
                    name: sourceConfig.name,
                })
                .max<{ maxVersion: string | number | null }[]>({
                    maxVersion: 'version',
                });

            const sourceFactors = await trx<ChurnScoreFactorRow>(
                ProtopieTableName.ChurnScoreFactors,
            )
                .select(
                    'factor_key',
                    'label',
                    'max_points',
                    'goal_value',
                    'goal_unit',
                    'aggregation',
                    'event_group',
                    'step_thresholds',
                    'sort_order',
                )
                .where('config_uuid', sourceConfig.config_uuid)
                .orderBy('sort_order', 'asc');

            await trx(ProtopieTableName.ChurnScoreConfigs)
                .where('config_uuid', sourceConfig.config_uuid)
                .update({
                    status: 'archived',
                    effective_to: trx.fn.now(),
                    updated_at: trx.fn.now(),
                });

            const [newConfig] = await trx(ProtopieTableName.ChurnScoreConfigs)
                .insert({
                    project_uuid: sourceConfig.project_uuid,
                    name: sourceConfig.name,
                    version: Number(maxVersion ?? 0) + 1,
                    lookback_days: sourceConfig.lookback_days,
                    score_function: sourceConfig.score_function,
                    risk_band_thresholds: sourceConfig.risk_band_thresholds,
                    status: 'active',
                })
                .returning<{ config_uuid: string }[]>('config_uuid');

            await trx(ProtopieTableName.ChurnScoreFactors).insert(
                [
                    ...sourceFactors.map((factor) => ({
                        factor_key: factor.factor_key,
                        label: factor.label,
                        max_points: factor.max_points,
                        goal_value: factor.goal_value,
                        goal_unit: factor.goal_unit,
                        aggregation: factor.aggregation,
                        event_group: factor.event_group,
                        step_thresholds: factor.step_thresholds,
                        sort_order:
                            factor.factor_key === 'active_days'
                                ? 100
                                : factor.sort_order,
                    })),
                    {
                        factor_key: MESSAGES_FACTOR.factorKey,
                        label: MESSAGES_FACTOR.label,
                        max_points: MESSAGES_FACTOR.maxPoints,
                        goal_value: MESSAGES_FACTOR.goalValue,
                        goal_unit: MESSAGES_FACTOR.goalUnit,
                        aggregation: MESSAGES_FACTOR.aggregation,
                        event_group: MESSAGES_FACTOR.eventGroup,
                        step_thresholds: MESSAGES_FACTOR.stepThresholds,
                        sort_order: MESSAGES_FACTOR.sortOrder,
                    },
                ].map((factor) => ({
                    config_uuid: newConfig.config_uuid,
                    ...factor,
                })),
            );
        });
    }
}

export async function down(): Promise<void> {
    // Data migration only. Restoring previous active versions would be unsafe
    // after users may have edited the rubric again.
}
