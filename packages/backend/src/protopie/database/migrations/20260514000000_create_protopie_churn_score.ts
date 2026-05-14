import { Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

const DEFAULT_CONFIG_NAME = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable(
        ProtopieTableName.ChurnScoreConfigs,
        (table) => {
            table
                .uuid('config_uuid')
                .primary()
                .defaultTo(knex.raw('uuid_generate_v4()'));
            table
                .uuid('project_uuid')
                .notNullable()
                .references('project_uuid')
                .inTable('projects')
                .onDelete('CASCADE');
            table.text('name').notNullable().defaultTo(DEFAULT_CONFIG_NAME);
            table.integer('version').notNullable();
            table
                .integer('lookback_days')
                .notNullable()
                .defaultTo(Protopie.DEFAULT_CHURN_SCORE_LOOKBACK_DAYS);
            table.text('score_function').notNullable().defaultTo('linear');
            table
                .jsonb('risk_band_thresholds')
                .notNullable()
                .defaultTo(
                    knex.raw(
                        `'${JSON.stringify(
                            Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
                        )}'::jsonb`,
                    ),
                );
            table
                .timestamp('effective_from', { useTz: true })
                .notNullable()
                .defaultTo(knex.fn.now());
            table.timestamp('effective_to', { useTz: true }).nullable();
            table.text('status').notNullable().defaultTo('active');
            table
                .uuid('created_by_user_uuid')
                .nullable()
                .references('user_uuid')
                .inTable('users')
                .onDelete('SET NULL');
            table
                .uuid('updated_by_user_uuid')
                .nullable()
                .references('user_uuid')
                .inTable('users')
                .onDelete('SET NULL');
            table.timestamps(true, true);
            table.unique(['project_uuid', 'name', 'version']);
        },
    );

    await knex.schema.createTable(
        ProtopieTableName.ChurnScoreFactors,
        (table) => {
            table
                .uuid('factor_uuid')
                .primary()
                .defaultTo(knex.raw('uuid_generate_v4()'));
            table
                .uuid('config_uuid')
                .notNullable()
                .references('config_uuid')
                .inTable(ProtopieTableName.ChurnScoreConfigs)
                .onDelete('CASCADE');
            table.text('factor_key').notNullable();
            table.text('label').notNullable();
            table.decimal('max_points', 5, 2).notNullable();
            table.decimal('goal_value', 14, 4).notNullable();
            table.text('goal_unit').notNullable();
            table.text('aggregation').notNullable();
            table.jsonb('event_group').notNullable();
            table.jsonb('step_thresholds').nullable();
            table.integer('sort_order').notNullable();
            table.unique(['config_uuid', 'factor_key']);
        },
    );

    await knex.schema.createTable(ProtopieTableName.ChurnScoreRuns, (table) => {
        table
            .uuid('run_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table
            .uuid('config_uuid')
            .notNullable()
            .references('config_uuid')
            .inTable(ProtopieTableName.ChurnScoreConfigs)
            .onDelete('RESTRICT');
        table.text('triggered_by').notNullable();
        table
            .uuid('triggered_by_user_uuid')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL');
        table.text('status').notNullable().defaultTo('queued');
        table.timestamp('started_at', { useTz: true }).nullable();
        table.timestamp('finished_at', { useTz: true }).nullable();
        table.integer('accounts_scored').notNullable().defaultTo(0);
        table.text('error_message').nullable();
        table
            .timestamp('created_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
    });

    await knex.schema.createTable(ProtopieTableName.ChurnScores, (table) => {
        table
            .uuid('score_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table.text('account_key').notNullable();
        table.text('namespace').nullable();
        table.text('cloud_url').nullable();
        table.date('scored_for_date').notNullable();
        table.integer('lookback_days').notNullable();
        table
            .uuid('config_uuid')
            .notNullable()
            .references('config_uuid')
            .inTable(ProtopieTableName.ChurnScoreConfigs)
            .onDelete('RESTRICT');
        table.integer('config_version').notNullable();
        table.decimal('total_points', 6, 2).notNullable();
        table.decimal('max_points', 6, 2).notNullable();
        table.decimal('score_percent', 5, 4).notNullable();
        table.decimal('normalized_score', 6, 2).notNullable();
        table.text('risk_band').notNullable();
        table.jsonb('factor_scores').notNullable();
        table
            .timestamp('computed_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
        table
            .uuid('run_uuid')
            .notNullable()
            .references('run_uuid')
            .inTable(ProtopieTableName.ChurnScoreRuns)
            .onDelete('CASCADE');
        table.unique([
            'account_key',
            'scored_for_date',
            'lookback_days',
            'config_uuid',
        ]);
    });

    await knex.raw(`
        CREATE UNIQUE INDEX protopie_churn_score_configs_active_idx
            ON ${ProtopieTableName.ChurnScoreConfigs} (project_uuid, name)
            WHERE status = 'active' AND effective_to IS NULL
    `);
    await knex.raw(`
        CREATE INDEX protopie_churn_score_factors_config_sort_idx
            ON ${ProtopieTableName.ChurnScoreFactors} (config_uuid, sort_order)
    `);
    await knex.raw(`
        CREATE INDEX protopie_churn_score_runs_project_created_idx
            ON ${ProtopieTableName.ChurnScoreRuns} (project_uuid, created_at DESC)
    `);
    await knex.raw(`
        CREATE INDEX protopie_churn_score_account_date_idx
            ON ${ProtopieTableName.ChurnScores} (account_key, scored_for_date DESC)
    `);
    await knex.raw(`
        CREATE INDEX protopie_churn_score_project_risk_date_idx
            ON ${ProtopieTableName.ChurnScores} (project_uuid, risk_band, scored_for_date DESC)
    `);

    const projects = await knex<{ project_uuid: string }>('projects').select(
        'project_uuid',
    );

    // Seed one active default rubric per existing project. Fresh local databases
    // with no projects get the same seed lazily on first API read.
    // eslint-disable-next-line no-restricted-syntax
    for (const project of projects) {
        // eslint-disable-next-line no-await-in-loop
        const [config] = await knex(ProtopieTableName.ChurnScoreConfigs)
            .insert({
                project_uuid: project.project_uuid,
                name: DEFAULT_CONFIG_NAME,
                version: 1,
                lookback_days: Protopie.DEFAULT_CHURN_SCORE_LOOKBACK_DAYS,
                score_function: 'linear',
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
                sort_order: factor.sortOrder,
            })),
        );
    }
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists(ProtopieTableName.ChurnScores);
    await knex.schema.dropTableIfExists(ProtopieTableName.ChurnScoreRuns);
    await knex.schema.dropTableIfExists(ProtopieTableName.ChurnScoreFactors);
    await knex.schema.dropTableIfExists(ProtopieTableName.ChurnScoreConfigs);
}
