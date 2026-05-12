import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable(
        ProtopieTableName.FormDefinitions,
        (table) => {
            table
                .uuid('form_definition_uuid')
                .primary()
                .defaultTo(knex.raw('uuid_generate_v4()'));
            table
                .uuid('project_uuid')
                .notNullable()
                .references('project_uuid')
                .inTable('projects')
                .onDelete('CASCADE');
            table.text('form_key').notNullable();
            table.integer('schema_version').notNullable();
            table.text('title').notNullable();
            table.text('description').nullable();
            table.jsonb('schema').notNullable();
            table.text('status').notNullable().defaultTo('active');
            table
                .uuid('created_by_user_uuid')
                .notNullable()
                .references('user_uuid')
                .inTable('users')
                .onDelete('RESTRICT');
            table
                .uuid('updated_by_user_uuid')
                .notNullable()
                .references('user_uuid')
                .inTable('users')
                .onDelete('RESTRICT');
            table.timestamps(true, true);
            table.timestamp('archived_at').nullable();
            table.unique(['project_uuid', 'form_key', 'schema_version']);
        },
    );

    await knex.schema.createTable(
        ProtopieTableName.FormSubmissions,
        (table) => {
            table
                .uuid('form_submission_uuid')
                .primary()
                .defaultTo(knex.raw('uuid_generate_v4()'));
            table
                .uuid('organization_uuid')
                .notNullable()
                .references('organization_uuid')
                .inTable('organizations')
                .onDelete('CASCADE');
            table
                .uuid('project_uuid')
                .notNullable()
                .references('project_uuid')
                .inTable('projects')
                .onDelete('CASCADE');
            table
                .uuid('form_definition_uuid')
                .notNullable()
                .references('form_definition_uuid')
                .inTable(ProtopieTableName.FormDefinitions)
                .onDelete('RESTRICT');
            table.text('form_key').notNullable();
            table.integer('schema_version').notNullable();
            table.text('account_key').nullable();
            table.text('cloud_url').nullable();
            table.text('salesforce_account_id').nullable();
            table.jsonb('payload').notNullable();
            table
                .uuid('created_by_user_uuid')
                .notNullable()
                .references('user_uuid')
                .inTable('users')
                .onDelete('RESTRICT');
            table.timestamps(true, true);
            table.timestamp('deleted_at').nullable();
        },
    );

    await knex.schema.createTable(
        ProtopieTableName.OrganizationSettings,
        (table) => {
            table
                .uuid('organization_uuid')
                .primary()
                .references('organization_uuid')
                .inTable('organizations')
                .onDelete('CASCADE');
            table.boolean('mcp_write_enabled').notNullable().defaultTo(false);
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
        },
    );

    await knex.schema.createTable(ProtopieTableName.McpAuditLog, (table) => {
        table
            .uuid('audit_log_uuid')
            .primary()
            .defaultTo(knex.raw('uuid_generate_v4()'));
        table
            .uuid('organization_uuid')
            .notNullable()
            .references('organization_uuid')
            .inTable('organizations')
            .onDelete('CASCADE');
        table
            .uuid('project_uuid')
            .nullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('SET NULL');
        table
            .uuid('user_uuid')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL');
        table.text('authentication_type').nullable();
        table.text('tool_name').notNullable();
        table.jsonb('input_summary').notNullable().defaultTo('{}');
        table.text('outcome').notNullable();
        table.text('error_message').nullable();
        table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });

    await knex.raw(`
        CREATE INDEX protopie_form_submissions_project_form_created_idx
            ON ${ProtopieTableName.FormSubmissions} (project_uuid, form_key, created_at DESC)
            WHERE deleted_at IS NULL
    `);
    await knex.raw(`
        CREATE INDEX protopie_form_submissions_account_idx
            ON ${ProtopieTableName.FormSubmissions} (organization_uuid, account_key)
            WHERE deleted_at IS NULL AND account_key IS NOT NULL
    `);
    await knex.raw(`
        CREATE INDEX protopie_mcp_audit_log_org_created_idx
            ON ${ProtopieTableName.McpAuditLog} (organization_uuid, created_at DESC)
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists(ProtopieTableName.McpAuditLog);
    await knex.schema.dropTableIfExists(ProtopieTableName.OrganizationSettings);
    await knex.schema.dropTableIfExists(ProtopieTableName.FormSubmissions);
    await knex.schema.dropTableIfExists(ProtopieTableName.FormDefinitions);
}
