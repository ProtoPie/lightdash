import {
    ApiErrorPayload,
    ApiSuccess,
    assertRegisteredAccount,
    Protopie,
} from '@lightdash/common';
import {
    Body,
    Get,
    Middlewares,
    OperationId,
    Path,
    Post,
    Query,
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
import { type ProtopieFormSubmissionRecord } from '../models/FormSubmissionModel';
import { getProtopieServices } from '../services';

type ApiProtopieFormSchemasResponse = ApiSuccess<
    Protopie.ProtopieClientFormDefinition[]
>;

type ApiProtopieFormSubmissionResponse =
    ApiSuccess<ProtopieFormSubmissionRecord>;

type ApiProtopieFormSubmissionsResponse = ApiSuccess<
    ProtopieFormSubmissionRecord[]
>;

@Route('/api/v1/projects/{projectUuid}/protopie/forms')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('Protopie')
export class ProtopieFormController extends BaseController {
    /**
     * List code-defined Protopie forms available for the project.
     * @summary List Protopie forms
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('schemas')
    @OperationId('ListProtopieFormSchemas')
    async listSchemas(
        @Path() projectUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiProtopieFormSchemasResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).formService.listSchemas({
                projectUuid,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Submit a Protopie form payload.
     * @summary Submit Protopie form
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('201', 'Created')
    @Post('{formKey}/submissions')
    @OperationId('SubmitProtopieForm')
    async submit(
        @Path() projectUuid: string,
        @Path() formKey: string,
        @Body() body: Record<string, unknown>,
        @Request() req: express.Request,
    ): Promise<ApiProtopieFormSubmissionResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(201);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).formService.submit({
                projectUuid,
                formKey,
                payload: body,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * List submitted Protopie form payloads.
     * @summary List Protopie form submissions
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('{formKey}/submissions')
    @OperationId('ListProtopieFormSubmissions')
    async listSubmissions(
        @Path() projectUuid: string,
        @Path() formKey: string,
        @Request() req: express.Request,
        @Query() accountKey?: string,
        @Query() limit?: number,
        @Query() offset?: number,
    ): Promise<ApiProtopieFormSubmissionsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).formService.listSubmissions({
                projectUuid,
                formKey,
                accountKey,
                limit,
                offset,
                user: toSessionUser(req.account),
            }),
        };
    }
}
