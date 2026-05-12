import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type DbProtopieFormSubmission = {
    form_submission_uuid: string;
    organization_uuid: string;
    project_uuid: string;
    form_definition_uuid: string;
    form_key: string;
    schema_version: number;
    account_key: string | null;
    cloud_url: string | null;
    salesforce_account_id: string | null;
    payload: Record<string, unknown>;
    created_by_user_uuid: string;
    created_at: Date;
    updated_at: Date;
    deleted_at: Date | null;
};

export type ProtopieFormSubmissionRecord = {
    formSubmissionUuid: string;
    organizationUuid: string;
    projectUuid: string;
    formDefinitionUuid: string;
    formKey: string;
    schemaVersion: number;
    accountKey: string | null;
    cloudUrl: string | null;
    salesforceAccountId: string | null;
    payload: Record<string, unknown>;
    createdByUserUuid: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
};

export class FormSubmissionModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async insertSubmission({
        organizationUuid,
        projectUuid,
        formDefinitionUuid,
        formKey,
        schemaVersion,
        accountKey,
        cloudUrl,
        salesforceAccountId,
        payload,
        createdByUserUuid,
    }: {
        organizationUuid: string;
        projectUuid: string;
        formDefinitionUuid: string;
        formKey: string;
        schemaVersion: number;
        accountKey: string | null;
        cloudUrl: string | null;
        salesforceAccountId: string | null;
        payload: Record<string, unknown>;
        createdByUserUuid: string;
    }): Promise<ProtopieFormSubmissionRecord> {
        const [row] = await this.database<DbProtopieFormSubmission>(
            ProtopieTableName.FormSubmissions,
        )
            .insert({
                organization_uuid: organizationUuid,
                project_uuid: projectUuid,
                form_definition_uuid: formDefinitionUuid,
                form_key: formKey,
                schema_version: schemaVersion,
                account_key: accountKey,
                cloud_url: cloudUrl,
                salesforce_account_id: salesforceAccountId,
                payload,
                created_by_user_uuid: createdByUserUuid,
            })
            .returning('*');

        return FormSubmissionModel.toRecord(row);
    }

    async listSubmissions({
        organizationUuid,
        projectUuid,
        formKey,
        accountKey,
        limit,
        offset,
    }: {
        organizationUuid: string;
        projectUuid: string;
        formKey: string;
        accountKey?: string;
        limit: number;
        offset: number;
    }): Promise<ProtopieFormSubmissionRecord[]> {
        const query = this.database<DbProtopieFormSubmission>(
            ProtopieTableName.FormSubmissions,
        )
            .where({
                organization_uuid: organizationUuid,
                project_uuid: projectUuid,
                form_key: formKey,
            })
            .whereNull('deleted_at')
            .orderBy('created_at', 'desc')
            .limit(limit)
            .offset(offset);

        if (accountKey) {
            void query.andWhere('account_key', accountKey);
        }

        const rows = await query.select('*');
        return rows.map((row) => FormSubmissionModel.toRecord(row));
    }

    private static toRecord(
        row: DbProtopieFormSubmission,
    ): ProtopieFormSubmissionRecord {
        return {
            formSubmissionUuid: row.form_submission_uuid,
            organizationUuid: row.organization_uuid,
            projectUuid: row.project_uuid,
            formDefinitionUuid: row.form_definition_uuid,
            formKey: row.form_key,
            schemaVersion: row.schema_version,
            accountKey: row.account_key,
            cloudUrl: row.cloud_url,
            salesforceAccountId: row.salesforce_account_id,
            payload: row.payload,
            createdByUserUuid: row.created_by_user_uuid,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            deletedAt: row.deleted_at,
        };
    }
}
