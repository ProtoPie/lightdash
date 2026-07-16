import {
    ApiErrorPayload,
    ApiSuccess,
    assertRegisteredAccount,
    Protopie,
} from '@lightdash/common';
import {
    Body,
    Delete,
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

type ApiChurnScoreConfigsResponse = ApiSuccess<Protopie.ChurnScoreConfig[]>;

type ApiChurnScoreConfigVersionsResponse = ApiSuccess<
    Protopie.ChurnScoreConfig[]
>;

type ApiChurnScoreConfigDeletedResponse = ApiSuccess<{ deleted: true }>;

type ApiChurnScoreRunQueuedResponse = ApiSuccess<{
    runUuid: string;
    status: 'queued';
}>;

type ApiChurnScoreRunResponse = ApiSuccess<Protopie.ChurnScoreRun>;

type ApiChurnScoreRunsResponse = ApiSuccess<Protopie.ChurnScoreRun[]>;

type ApiChurnScoresResponse = ApiSuccess<Protopie.ChurnScore[]>;

type ApiChurnScoreFactorDetail = {
    factorUuid?: string;
    configUuid?: string;
    factorKey: string;
    label: string;
    maxPoints: number;
    goalValue: number;
    goalUnit: Protopie.ChurnScoreGoalUnit;
    aggregation: Protopie.ChurnScoreAggregation;
    eventGroup: Protopie.ChurnScoreEventGroup;
    stepThresholds?: Record<string, unknown> | null;
    sortOrder: number;
    score: Protopie.ChurnScoreFactorScore & {
        achievementPercent: number;
    };
};

type ApiChurnScoreAccountEventSummary = {
    eventName: string;
    eventCount: number;
    activeUsers: number;
    activeDays: number;
    shareOfEvents: number;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
};

type ApiChurnScoreAccountEventDailyCount = {
    eventDate: string;
    eventName: string;
    eventCount: number;
    activeUsers: number;
};

type ApiChurnScoreAccountEventUsage = {
    lookbackDays: number;
    dateFrom: string;
    dateTo: string;
    minSelectableDate: string;
    maxSelectableDate: string;
    totalEvents: number;
    selectedEventNames: string[];
    events: ApiChurnScoreAccountEventSummary[];
    daily: ApiChurnScoreAccountEventDailyCount[];
};

type ApiChurnScoreAccountDetailsResponse = ApiSuccess<{
    score: Protopie.ChurnScore;
    config: Protopie.ChurnScoreConfig;
    factors: ApiChurnScoreFactorDetail[];
    eventUsage: ApiChurnScoreAccountEventUsage;
}>;

type ApiChurnScoreEventsResponse = ApiSuccess<string[]>;

type ApiChurnScoreFilterOptionsResponse =
    ApiSuccess<Protopie.ChurnScoreFilterOptions>;

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
        @Query() name?: string,
    ): Promise<ApiChurnScoreConfigResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.getActiveConfig({
                projectUuid,
                name,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * List active churn score rubrics visible to the current user.
     * @summary List Protopie churn score rubrics
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('configs')
    @OperationId('ListProtopieChurnScoreConfigs')
    async listConfigs(
        @Path() projectUuid: string,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreConfigsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listActiveConfigs({
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
        @Query() name?: string,
    ): Promise<ApiChurnScoreConfigVersionsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listVersions({
                projectUuid,
                name,
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
     * Soft-delete a churn score rubric (all versions). Historical scores are
     * preserved; the rubric leaves the editor and active lookups.
     * @summary Delete Protopie churn score rubric
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Delete('config')
    @OperationId('DeleteProtopieChurnScoreConfig')
    async deleteConfig(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() name: string,
    ): Promise<ApiChurnScoreConfigDeletedResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.deleteConfig({
                projectUuid,
                name,
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Rename a churn score rubric (all versions). Scores key off configUuid, so
     * this is a label-only change.
     * @summary Rename Protopie churn score rubric
     */
    @Middlewares([
        allowApiKeyAuthentication,
        isAuthenticated,
        unauthorisedInDemo,
    ])
    @SuccessResponse('200', 'Success')
    @Put('config/rename')
    @OperationId('RenameProtopieChurnScoreConfig')
    async renameConfig(
        @Path() projectUuid: string,
        @Body() body: Protopie.RenameChurnScoreConfigInput,
        @Request() req: express.Request,
    ): Promise<ApiChurnScoreConfigResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.renameConfig({
                projectUuid,
                currentName: body.currentName,
                newName: body.newName,
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
        @Query() name?: string,
        @Query() configUuid?: string,
    ): Promise<ApiChurnScoreRunQueuedResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(202);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.enqueueRecompute({
                projectUuid,
                name,
                configUuid,
                user: toSessionUser(req.account),
                triggeredBy: 'manual',
            }),
        };
    }

    /**
     * List available product event names for churn score rubric factors.
     * @summary List Protopie churn score event names
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('events')
    @OperationId('ListProtopieChurnScoreEvents')
    async listEvents(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() search?: string,
        @Query() limit?: number,
    ): Promise<ApiChurnScoreEventsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listEventNames({
                projectUuid,
                search,
                limit,
                user: toSessionUser(req.account),
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
        @Query() configUuid?: string,
        @Query() minScore?: number,
        @Query() maxScore?: number,
        @Query() namespace?: string,
        @Query() sortBy?: Protopie.ChurnScoreSortBy,
        @Query() sortDirection?: Protopie.ChurnScoreSortDirection,
        @Query() limit?: number,
        @Query() offset?: number,
        // Appended after the pre-existing params so a stale generated route
        // adapter (local dev, before `pnpm generate-api`) can't shift the
        // established positional args (sortBy/limit/offset) into these.
        @Query() accountOwner?: string[],
        @Query() sfPlanCategory?: string[],
        @Query() sfAccountRegion?: string[],
        @Query() sfAccountCountry?: string[],
        @Query() search?: string,
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
                    configUuid,
                    riskBand,
                    minScore,
                    maxScore,
                    namespace,
                    search,
                    accountOwner,
                    sfPlanCategory,
                    sfAccountRegion,
                    sfAccountCountry,
                    sortBy,
                    sortDirection,
                    limit,
                    offset,
                },
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * List distinct SF attribute values for the churn scores filter dropdowns.
     * @summary List Protopie churn score filter options
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('scores/filter-options')
    @OperationId('ListProtopieChurnScoreFilterOptions')
    async listFilterOptions(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() configUuid?: string,
        @Query() riskBand?: Protopie.ChurnScoreRiskBand,
        @Query() search?: string,
        @Query() minScore?: number,
        @Query() maxScore?: number,
        @Query() accountOwner?: string[],
        @Query() sfPlanCategory?: string[],
        @Query() sfAccountRegion?: string[],
        @Query() sfAccountCountry?: string[],
    ): Promise<ApiChurnScoreFilterOptionsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.listFilterOptions({
                projectUuid,
                configUuid,
                filters: {
                    configUuid,
                    riskBand,
                    search,
                    minScore,
                    maxScore,
                    accountOwner,
                    sfPlanCategory,
                    sfAccountRegion,
                    sfAccountCountry,
                },
                user: toSessionUser(req.account),
            }),
        };
    }

    /**
     * Get latest churn score details and event usage for one account.
     * @summary Get Protopie churn score account details
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('200', 'Success')
    @Get('scores/account/details')
    @OperationId('GetProtopieChurnScoreAccountDetails')
    async getAccountDetails(
        @Path() projectUuid: string,
        @Request() req: express.Request,
        @Query() accountKey: string,
        @Query() configUuid?: string,
        @Query() dateFrom?: string,
        @Query() dateTo?: string,
    ): Promise<ApiChurnScoreAccountDetailsResponse> {
        assertRegisteredAccount(req.account);
        this.setStatus(200);

        return {
            status: 'ok',
            results: await getProtopieServices(
                this.services,
            ).churnScoreService.getAccountDetails({
                projectUuid,
                accountKey,
                configUuid,
                dateFrom,
                dateTo,
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
