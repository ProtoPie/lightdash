import { NotFoundError, Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type DbProtopieFormDefinition = {
    form_definition_uuid: string;
    project_uuid: string;
    form_key: string;
    schema_version: number;
    title: string;
    description: string | null;
    schema: Protopie.ProtopieClientFormDefinition;
    status: 'active' | 'archived';
    created_by_user_uuid: string;
    updated_by_user_uuid: string;
    created_at: Date;
    updated_at: Date;
    archived_at: Date | null;
};

export type ProtopieFormDefinitionRecord = {
    formDefinitionUuid: string;
    projectUuid: string;
    formKey: string;
    schemaVersion: number;
    title: string;
    description: string | null;
    schema: Protopie.ProtopieClientFormDefinition;
    status: 'active' | 'archived';
    createdByUserUuid: string;
    updatedByUserUuid: string;
    createdAt: Date;
    updatedAt: Date;
    archivedAt: Date | null;
};

export class FormDefinitionModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async upsertCodeDefinedForm({
        projectUuid,
        form,
        userUuid,
    }: {
        projectUuid: string;
        form: Protopie.ProtopieFormDefinition;
        userUuid: string;
    }): Promise<ProtopieFormDefinitionRecord> {
        const schema = Protopie.toClientFormDefinition(form);
        const [row] = await this.database<DbProtopieFormDefinition>(
            ProtopieTableName.FormDefinitions,
        )
            .insert({
                project_uuid: projectUuid,
                form_key: form.key,
                schema_version: form.version,
                title: form.title,
                description: form.description ?? null,
                schema,
                status: 'active',
                created_by_user_uuid: userUuid,
                updated_by_user_uuid: userUuid,
            })
            .onConflict(['project_uuid', 'form_key', 'schema_version'])
            .merge({
                title: form.title,
                description: form.description ?? null,
                schema,
                status: 'active',
                updated_by_user_uuid: userUuid,
                updated_at: this.database.fn.now(),
                archived_at: null,
            })
            .returning('*');

        return FormDefinitionModel.toRecord(row);
    }

    async getActiveForm({
        projectUuid,
        formKey,
        schemaVersion,
    }: {
        projectUuid: string;
        formKey: string;
        schemaVersion: number;
    }): Promise<ProtopieFormDefinitionRecord> {
        const row = await this.database<DbProtopieFormDefinition>(
            ProtopieTableName.FormDefinitions,
        )
            .where({
                project_uuid: projectUuid,
                form_key: formKey,
                schema_version: schemaVersion,
                status: 'active',
            })
            .whereNull('archived_at')
            .first();

        if (!row) {
            throw new NotFoundError(
                `Protopie form definition does not exist: ${formKey}`,
            );
        }

        return FormDefinitionModel.toRecord(row);
    }

    private static toRecord(
        row: DbProtopieFormDefinition,
    ): ProtopieFormDefinitionRecord {
        return {
            formDefinitionUuid: row.form_definition_uuid,
            projectUuid: row.project_uuid,
            formKey: row.form_key,
            schemaVersion: row.schema_version,
            title: row.title,
            description: row.description,
            schema: row.schema,
            status: row.status,
            createdByUserUuid: row.created_by_user_uuid,
            updatedByUserUuid: row.updated_by_user_uuid,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            archivedAt: row.archived_at,
        };
    }
}
