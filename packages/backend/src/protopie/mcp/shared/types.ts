import {
    type Account,
    type ChartAsCode,
    type DashboardAsCode,
    type SessionUser,
    type SqlChartAsCode,
    type UpdateSpace,
} from '@lightdash/common';
// eslint-disable-next-line import/extensions
import { type AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
// eslint-disable-next-line import/extensions
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type ZodRawShape, type ZodSchema } from 'zod';
import { type CoderService } from '../../../services/CoderService/CoderService';
import { type SpaceService } from '../../../services/SpaceService/SpaceService';
import { type ProtopieMcpAuditLogEntry } from '../../models/McpAuditLogModel';
import { type ProtopieOrganizationSettingsModel } from '../../models/OrganizationSettingsModel';

export type ProtopieMcpContext = {
    authInfo?: AuthInfo & {
        extra: {
            user: SessionUser;
            account: Account;
        };
    };
};

export type ProtopieMcpToolResult = {
    content: Array<{ type: 'text'; text: string }>;
};

export type ProtopieMcpToolDeps = {
    mcpServer: McpServer;
    siteUrl: string;
    coderService: CoderService;
    spaceService: SpaceService;
    getAccount: (context: ProtopieMcpContext) => {
        user: SessionUser;
        organizationUuid: string;
        account: Account;
    };
    resolveProjectUuid: (context: ProtopieMcpContext) => Promise<string>;
    getMcpCompatibleSchema: (schema: ZodSchema<unknown>) => ZodRawShape;
    organizationSettingsModel?: ProtopieOrganizationSettingsModel;
    audit?: (entry: ProtopieMcpAuditLogEntry) => Promise<void>;
};

export type UpsertDashboardAsCodeArgs = {
    projectUuid?: string;
    slug?: string;
    dashboard: DashboardAsCode;
    skipSpaceCreate?: boolean;
    publicSpaceCreate?: boolean;
    force?: boolean;
    spaceNames?: Record<string, string>;
};

export type UpsertChartAsCodeArgs = {
    projectUuid?: string;
    slug?: string;
    chart: ChartAsCode;
    skipSpaceCreate?: boolean;
    publicSpaceCreate?: boolean;
    force?: boolean;
    spaceNames?: Record<string, string>;
};

export type UpsertSqlChartAsCodeArgs = {
    projectUuid?: string;
    slug?: string;
    sqlChart: SqlChartAsCode;
    skipSpaceCreate?: boolean;
    publicSpaceCreate?: boolean;
    force?: boolean;
    spaceNames?: Record<string, string>;
};

export type UpdateSpaceArgs = {
    spaceUuid: string;
    space: UpdateSpace;
};
