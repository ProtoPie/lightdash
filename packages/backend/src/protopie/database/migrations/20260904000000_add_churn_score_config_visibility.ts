import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

/**
 * Adds read visibility to churn score rubrics.
 *
 * Before this, every rubric other than "Default Churn Score" was implicitly
 * private — readable only by its creator and project/org admins. Rubrics are
 * more useful shared than hidden, so `public` becomes the default and hiding
 * one is now the deliberate act.
 *
 * The NOT NULL DEFAULT deliberately applies to existing rows too: the rubrics
 * already in the table become public, which is the agreed rollout (they are a
 * handful of weight experiments, not confidential material). Owners can flip
 * any of them back to private from the rubric editor after deploy.
 *
 * Edit rights are untouched — a public rubric is still editable only by its
 * owner and admins.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable(
        ProtopieTableName.ChurnScoreConfigs,
        (table) => {
            table.text('visibility').notNullable().defaultTo('public');
        },
    );
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable(
        ProtopieTableName.ChurnScoreConfigs,
        (table) => {
            table.dropColumn('visibility');
        },
    );
}
