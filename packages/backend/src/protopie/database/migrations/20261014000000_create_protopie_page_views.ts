import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

/**
 * One row per entry into a Protopie churn page (list or account detail).
 * Written by the frontend on page mount, read only by ad-hoc SQL for usage
 * reporting. "Visit" is derived at query time (30-minute gap rule), so this
 * table stores raw events, not sessions.
 *
 * user_uuid is nullable with ON DELETE SET NULL so counts survive user
 * deletion; project_uuid cascades because views of a deleted project are
 * meaningless.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable(ProtopieTableName.PageViews, (table) => {
        table.bigIncrements('view_id');
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table
            .uuid('user_uuid')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL');
        table.text('page').notNullable();
        table.text('account_key').nullable();
        table
            .timestamp('viewed_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
    });

    await knex.raw(`
        ALTER TABLE ${ProtopieTableName.PageViews}
            ADD CONSTRAINT protopie_page_views_page_check
            CHECK (page IN ('churn_list', 'churn_account'))
    `);
    await knex.raw(`
        CREATE INDEX protopie_page_views_project_viewed_idx
            ON ${ProtopieTableName.PageViews} (project_uuid, viewed_at DESC)
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists(ProtopieTableName.PageViews);
}
