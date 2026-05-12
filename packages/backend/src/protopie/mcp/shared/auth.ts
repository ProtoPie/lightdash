import { ForbiddenError } from '@lightdash/common';
import { type ProtopieMcpContext, type ProtopieMcpToolDeps } from './types';

const MCP_WRITE_SCOPE = 'mcp:write';

export const requireMcpWriteScope = (context: ProtopieMcpContext): void => {
    const scopes = context.authInfo?.scopes ?? [];

    if (!scopes.includes(MCP_WRITE_SCOPE)) {
        throw new ForbiddenError(
            `MCP tool requires the ${MCP_WRITE_SCOPE} scope.`,
        );
    }
};

export const requireOrganizationMcpWriteEnabled = async (
    deps: ProtopieMcpToolDeps,
    organizationUuid: string,
): Promise<void> => {
    const enabled =
        (await deps.organizationSettingsModel?.isMcpWriteEnabled(
            organizationUuid,
        )) ?? false;

    if (!enabled) {
        throw new ForbiddenError(
            'MCP write tools are disabled for this organization.',
        );
    }
};
