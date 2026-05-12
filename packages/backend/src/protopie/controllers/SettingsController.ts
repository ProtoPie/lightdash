import {
    ApiErrorPayload,
    ApiSuccess,
    assertRegisteredAccount,
} from '@lightdash/common';
import {
    Body,
    Get,
    Middlewares,
    OperationId,
    Patch,
    Request,
    Response,
    Route,
    SuccessResponse,
    Tags,
} from '@tsoa/runtime';
import express from 'express';
import { toSessionUser } from '../../auth/account';
import {
    allowApiKeyAuthentication,
    isAuthenticated,
    unauthorisedInDemo,
} from '../../controllers/authentication';
import { BaseController } from '../../controllers/baseController';
import { type ProtopieOrganizationSettings } from '../models/OrganizationSettingsModel';
import { getProtopieServices } from '../services';

type ApiProtopieMcpSettingsResponse = ApiSuccess<{
    mcpWriteEnabled: boolean;
    settings?: ProtopieOrganizationSettings;
}>;

type UpdateProtopieMcpSettingsBody = {
    mcpWriteEnabled: boolean;
};

@Route('/api/v1/protopie/mcp-settings')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('Protopie')
export class ProtopieSettingsController extends BaseController {
    /**
     * Get Protopie MCP write settings for the current organization.
     * @summary Get Protopie MCP settings
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('/')
    @OperationId('GetProtopieMcpSettings')
    async getMcpSettings(
        @Request() req: express.Request,
    ): Promise<ApiProtopieMcpSettingsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        const settings = await getProtopieServices(
            this.services,
        ).settingsService.getMcpSettings({
            user: toSessionUser(req.account),
        });

        return {
            status: 'ok',
            results: {
                mcpWriteEnabled: settings?.mcpWriteEnabled ?? false,
                settings,
            },
        };
    }

    /**
     * Enable or disable Protopie MCP write tools for the current organization.
     * @summary Update Protopie MCP settings
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Patch('/')
    @OperationId('UpdateProtopieMcpSettings')
    async updateMcpSettings(
        @Body() body: UpdateProtopieMcpSettingsBody,
        @Request() req: express.Request,
    ): Promise<ApiProtopieMcpSettingsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        const settings = await getProtopieServices(
            this.services,
        ).settingsService.updateMcpSettings({
            user: toSessionUser(req.account),
            mcpWriteEnabled: body.mcpWriteEnabled,
        });

        return {
            status: 'ok',
            results: {
                mcpWriteEnabled: settings.mcpWriteEnabled,
                settings,
            },
        };
    }
}
