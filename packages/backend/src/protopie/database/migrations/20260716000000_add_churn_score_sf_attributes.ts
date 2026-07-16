import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

/**
 * Adds Salesforce account attributes to churn score snapshots. Sourced from
 * `protopie_account_user_counts` during recompute and persisted so the scores
 * screen can display `sf_account_name` and filter by owner / plan / region /
 * country without re-querying the warehouse.
 *
 * All nullable: existing rows (and any account whose SF attrs are absent) stay
 * NULL until the next recompute repopulates them.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable(ProtopieTableName.ChurnScores, (table) => {
        table.text('sf_account_name').nullable();
        table.text('account_owner').nullable();
        table.text('sf_plan_category').nullable();
        table.text('sf_account_region').nullable();
        table.text('sf_account_country').nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable(ProtopieTableName.ChurnScores, (table) => {
        table.dropColumn('sf_account_name');
        table.dropColumn('account_owner');
        table.dropColumn('sf_plan_category');
        table.dropColumn('sf_account_region');
        table.dropColumn('sf_account_country');
    });
}
