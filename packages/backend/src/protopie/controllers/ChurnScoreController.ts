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
    Put,
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
import { getProtopieServices } from '../services';

type ApiChurnScoreConfigResponse =
    ApiSuccess<Protopie.ChurnScoreConfigWithFactors>;

type ApiChurnScoreConfigVersionsResponse = ApiSuccess<
    Protopie.ChurnScoreConfig[]
>;

type ApiChurnScoreRunQueuedResponse = ApiSuccess<{
    runUuid: string;
    status: 'queued';
}>;

type ApiChurnScoreRunResponse = ApiSuccess<Protopie.ChurnScoreRun>;

type ApiChurnScoreRunsResponse = ApiSuccess<Protopie.ChurnScoreRun[]>;

type ApiChurnScoresResponse = ApiSuccess<Protopie.ChurnScore[]>;

@Route('/api/v1/projects/{projectUuid}/protopie/churn')
@Response<ApiErrorPayload>('default', 'Error')
@Tags('Protopie')
export class ProtopieChurnScoreController extends BaseController {
    /**
     * Get the active churn score rubric and factors.
     * @summary Get Protopie churn score rubric
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('config')
    @OperationId('GetProtopieChurnScoreConfig')
    async getConfig(
        @Path() projectUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreConfigResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.getActiveConfig({
                projectUuid,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * List churn score rubric versions.
     * @summary List Protopie churn score rubric versions
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('config/versions')
    @OperationId('ListProtopieChurnScoreConfigVersions')
    async listVersions(
        @Path() projectUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreConfigVersionsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listVersions({
                projectUuid,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Restore a previous churn score rubric version as a new active version.
     * @summary Restore Protopie churn score rubric version
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Post('config/versions/{configUuid}/restore')
    @OperationId('RestoreProtopieChurnScoreConfigVersion')
    async restoreVersion(
        @Path() projectUuid: string,
        @Path() configUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreConfigResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.restoreConfigVersion({
                projectUuid,
                configUuid,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Save edited churn score factors as a new active rubric version.
     * @summary Update Protopie churn score rubric
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Put('config')
    @OperationId('UpdateProtopieChurnScoreConfig')
    async updateConfig(
        @Path() projectUuid: string,
        @Body() body: Protopie.ChurnScoreConfigInput,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreConfigResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.upsertConfigAsNewVersion({
                projectUuid,
                payload: body,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Enqueue a manual churn score recompute.
     * @summary Recompute Protopie churn scores
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('202', 'Accepted')
    @Post('recompute')
    @OperationId('RecomputeProtopieChurnScores')
    async recompute(
        @Path() projectUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreRunQueuedResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(202);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.enqueueRecompute({
                projectUuid,
                user: toSessionUser(req.account),
                triggeredBy: 'manual',
            }),
        };
    }

    /**
     * List churn score recompute runs.
     * @summary List Protopie churn score runs
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('runs')
    @OperationId('ListProtopieChurnScoreRuns')
    async listRuns(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() limit?: number,
    ): Promise<ApiChurnScoreRunsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listRuns({
                projectUuid,
                limit,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Get one churn score recompute run.
     * @summary Get Protopie churn score run
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('runs/{runUuid}')
    @OperationId('GetProtopieChurnScoreRun')
    async getRun(
        @Path() projectUuid: string,
        @Path() runUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreRunResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.getRun({
                projectUuid,
                runUuid,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * List latest churn scores for the active rubric.
     * @summary List latest Protopie churn scores
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('scores/latest')
    @OperationId('ListLatestProtopieChurnScores')
    async listLatestScores(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() riskBand?: Protopie.ChurnScoreRiskBand,
        @Query() minScore?: number,
        @Query() maxScore?: number,
        @Query() namespace?: string,
        @Query() limit?: number,
        @Query() offset?: number,
    ): Promise<ApiChurnScoresResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listLatestScores({
                projectUuid,
                filters: {
                    riskBand,
                    minScore,
                    maxScore,
                    namespace,
                    limit,
                    offset,
                },
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Get churn score history for one account key.
     * @summary Get Protopie churn score account history
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('scores/{accountKey}')
    @OperationId('GetProtopieChurnScoreAccountHistory')
    async getAccountHistory(
        @Path() projectUuid: string,
        @Path() accountKey: string,
        @Request() req: express.Request,
        @Query() limit?: number,
    ): Promise<ApiChurnScoresResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.getAccountHistory({
                projectUuid,
                accountKey,
                limit,
                user: toSessionUser(req.account),
            }),
        };
    }
}
