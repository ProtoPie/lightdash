import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

const DEFAULT_CONFIG_NAME = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;

/**
 * Switches the default churn rubric to ChurnZero-faithful stepwise scoring:
 * - adds per-factor `window_days` (factors) and `churn_score` = 100 - health (scores)
 * - archives the active linear "Default Churn Score" per project and seeds a
 *   new active version with stepwise buckets + per-factor windows (history
 *   stays as-was: old rows keep their config_uuid).
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable(
        ProtopieTableName.ChurnScoreFactors,
        (table) => {
            table.integer('window_days').nullable();
        },
    );

    await knex.schema.alterTable(ProtopieTableName.ChurnScores, (table) => {
        table.decimal('churn_score', 6, 2).nullable();
    });

    // Backfill churn risk for existing health rows.
    await knex(ProtopieTableName.ChurnScores).update({
        churn_score: knex.raw('GREATEST(0, 100 - normalized_score)'),
    });

    await knex.schema.alterTable(ProtopieTableName.ChurnScores, (table) => {
        table.decimal('churn_score', 6, 2).notNullable().alter();
    });

    const projects = await knex<{ project_uuid: string }>('projects').select(
        'project_uuid',
    );

    // eslint-disable-next-line no-restricted-syntax
    for (const project of projects) {
        // eslint-disable-next-line no-await-in-loop
        await knex(ProtopieTableName.ChurnScoreConfigs)
            .where({
                project_uuid: project.project_uuid,
                name: DEFAULT_CONFIG_NAME,
                status: 'active',
            })
            .whereNull('effective_to')
            .update({ status: 'archived', effective_to: knex.fn.now() });

        // eslint-disable-next-line no-await-in-loop
        const versionRow = await knex(ProtopieTableName.ChurnScoreConfigs)
            .where({
                project_uuid: project.project_uuid,
                name: DEFAULT_CONFIG_NAME,
            })
            .max<{ max: number | null }[]>('version as max')
            .first();
        const nextVersion = (versionRow?.max ?? 0) + 1;

        // eslint-disable-next-line no-await-in-loop
        const [config] = await knex(ProtopieTableName.ChurnScoreConfigs)
            .insert({
                project_uuid: project.project_uuid,
                name: DEFAULT_CONFIG_NAME,
                version: nextVersion,
                lookback_days: Protopie.DEFAULT_CHURN_SCORE_LOOKBACK_DAYS,
                score_function: Protopie.DEFAULT_CHURN_SCORE_FUNCTION,
                risk_band_thresholds:
                    Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
                status: 'active',
            })
            .returning<{ config_uuid: string }[]>('config_uuid');

        // eslint-disable-next-line no-await-in-loop
        await knex(ProtopieTableName.ChurnScoreFactors).insert(
            Protopie.DEFAULT_CHURN_SCORE_FACTORS.map((factor) => ({
                config_uuid: config.config_uuid,
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
        );
    }
}

export async function down(knex: Knex): Promise<void> {
    // Lossy: drops the new columns. The stepwise config versions remain (they
    // are immutable history); reactivating the prior linear version is manual.
    await knex.schema.alterTable(ProtopieTableName.ChurnScores, (table) => {
        table.dropColumn('churn_score');
    });
    await knex.schema.alterTable(
        ProtopieTableName.ChurnScoreFactors,
        (table) => {
            table.dropColumn('window_days');
        },
    );
}
