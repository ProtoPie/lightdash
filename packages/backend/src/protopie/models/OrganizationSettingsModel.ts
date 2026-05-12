import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

type DbProtopieOrganizationSettings = {
    organization_uuid: string;
    mcp_write_enabled: boolean;
    created_by_user_uuid: string | null;
    updated_by_user_uuid: string | null;
    created_at: Date;
    updated_at: Date;
};

export type ProtopieOrganizationSettings = {
    organizationUuid: string;
    mcpWriteEnabled: boolean;
    createdByUserUuid: string | null;
    updatedByUserUuid: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export class ProtopieOrganizationSettingsModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async get(
        organizationUuid: string,
    ): Promise<ProtopieOrganizationSettings | undefined> {
        const row = await this.database<DbProtopieOrganizationSettings>(
            ProtopieTableName.OrganizationSettings,
        )
            .where({ organization_uuid: organizationUuid })
            .first();

        return row
            ? ProtopieOrganizationSettingsModel.toRecord(row)
            : undefined;
    }

    async isMcpWriteEnabled(organizationUuid: string): Promise<boolean> {
        const settings = await this.get(organizationUuid);
        return settings?.mcpWriteEnabled ?? false;
    }

    async upsert({
        organizationUuid,
        mcpWriteEnabled,
        userUuid,
    }: {
        organizationUuid: string;
        mcpWriteEnabled: boolean;
        userUuid: string;
    }): Promise<ProtopieOrganizationSettings> {
        const [row] = await this.database<DbProtopieOrganizationSettings>(
            ProtopieTableName.OrganizationSettings,
        )
            .insert({
                organization_uuid: organizationUuid,
                mcp_write_enabled: mcpWriteEnabled,
                created_by_user_uuid: userUuid,
                updated_by_user_uuid: userUuid,
            })
            .onConflict('organization_uuid')
            .merge({
                mcp_write_enabled: mcpWriteEnabled,
                updated_by_user_uuid: userUuid,
                updated_at: this.database.fn.now(),
            })
            .returning('*');

        return ProtopieOrganizationSettingsModel.toRecord(row);
    }

    private static toRecord(
        row: DbProtopieOrganizationSettings,
    ): ProtopieOrganizationSettings {
        return {
            organizationUuid: row.organization_uuid,
            mcpWriteEnabled: row.mcp_write_enabled,
            createdByUserUuid: row.created_by_user_uuid,
            updatedByUserUuid: row.updated_by_user_uuid,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}
