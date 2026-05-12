import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

export type ProtopieMcpAuditLogEntry = {
    organizationUuid: string;
    projectUuid?: string | null;
    userUuid?: string | null;
    authenticationType?: string | null;
    toolName: string;
    inputSummary?: Record<string, unknown>;
    outcome: 'success' | 'error';
    errorMessage?: string | null;
};

export class ProtopieMcpAuditLogModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async insert(entry: ProtopieMcpAuditLogEntry): Promise<void> {
        await this.database(ProtopieTableName.McpAuditLog).insert({
            organization_uuid: entry.organizationUuid,
            project_uuid: entry.projectUuid ?? null,
            user_uuid: entry.userUuid ?? null,
            authentication_type: entry.authenticationType ?? null,
            tool_name: entry.toolName,
            input_summary: entry.inputSummary ?? {},
            outcome: entry.outcome,
            error_message: entry.errorMessage ?? null,
        });
    }
}
