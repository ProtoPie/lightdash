import { type AnyType, type ApiError, type Protopie } from '@lightdash/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lightdashApi } from '../api';
import useToaster from '../hooks/toaster/useToaster';

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
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
};

type ProtopieMcpSettings = {
    mcpWriteEnabled: boolean;
    settings?: {
        organizationUuid: string;
        mcpWriteEnabled: boolean;
        createdByUserUuid: string | null;
        updatedByUserUuid: string | null;
        createdAt: string;
        updatedAt: string;
    };
};

const protopieFormsQueryKey = (projectUuid?: string) => [
    'protopie',
    'forms',
    projectUuid,
];

const protopieMcpSettingsQueryKey = ['protopie', 'mcp-settings'];

const protopieSubmissionsQueryKey = (
    projectUuid?: string,
    formKey?: string,
) => ['protopie', 'form-submissions', projectUuid, formKey];

const protopieChurnConfigQueryKey = (projectUuid?: string) => [
    'protopie',
    'churn-config',
    projectUuid,
];

const protopieChurnRunsQueryKey = (projectUuid?: string) => [
    'protopie',
    'churn-runs',
    projectUuid,
];

const protopieChurnRunQueryKey = (projectUuid?: string, runUuid?: string) => [
    'protopie',
    'churn-run',
    projectUuid,
    runUuid,
];

const protopieChurnScoresQueryKeyBase = (projectUuid?: string) => [
    'protopie',
    'churn-scores',
    projectUuid,
];

const protopieChurnScoresQueryKey = (
    projectUuid?: string,
    filters?: Protopie.ChurnScoreLatestFilters,
) => [...protopieChurnScoresQueryKeyBase(projectUuid), filters];

export const useProtopieMcpSettings = () =>
    useQuery<ProtopieMcpSettings, ApiError>({
        queryKey: protopieMcpSettingsQueryKey,
        queryFn: () =>
            lightdashApi<AnyType>({
                method: 'GET',
                url: '/protopie/mcp-settings',
            }) as Promise<ProtopieMcpSettings>,
    });

export const useUpdateProtopieMcpSettings = () => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<
        ProtopieMcpSettings,
        ApiError,
        { mcpWriteEnabled: boolean }
    >(
        (body) =>
            lightdashApi<AnyType>({
                method: 'PATCH',
                url: '/protopie/mcp-settings',
                body: JSON.stringify(body),
            }) as Promise<ProtopieMcpSettings>,
        {
            mutationKey: protopieMcpSettingsQueryKey,
            onSuccess: async () => {
                await queryClient.invalidateQueries(
                    protopieMcpSettingsQueryKey,
                );
                showToastSuccess({
                    title: 'MCP settings updated',
                });
            },
            onError: ({ error }) => {
                showToastApiError({
                    title: 'Failed to update MCP settings',
                    apiError: error,
                });
            },
        },
    );
};

export const useProtopieFormSchemas = (projectUuid?: string) =>
    useQuery<Protopie.ProtopieClientFormDefinition[], ApiError>({
        queryKey: protopieFormsQueryKey(projectUuid),
        enabled: Boolean(projectUuid),
        queryFn: () =>
            lightdashApi<Protopie.ProtopieClientFormDefinition[]>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/forms/schemas`,
            }),
    });

export const useProtopieFormSubmissions = ({
    projectUuid,
    formKey,
}: {
    projectUuid?: string;
    formKey?: string;
}) =>
    useQuery<ProtopieFormSubmissionRecord[], ApiError>({
        queryKey: protopieSubmissionsQueryKey(projectUuid, formKey),
        enabled: Boolean(projectUuid && formKey),
        queryFn: () =>
            lightdashApi<ProtopieFormSubmissionRecord[]>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/forms/${formKey}/submissions`,
            }),
    });

export const useSubmitProtopieForm = ({
    projectUuid,
    formKey,
}: {
    projectUuid?: string;
    formKey?: string;
}) => {
    const queryClient = useQueryClient();

    return useMutation<
        ProtopieFormSubmissionRecord,
        ApiError,
        Record<string, unknown>
    >({
        mutationFn: (payload) =>
            lightdashApi<AnyType>({
                method: 'POST',
                url: `/projects/${projectUuid}/protopie/forms/${formKey}/submissions`,
                body: JSON.stringify(payload),
            }) as Promise<ProtopieFormSubmissionRecord>,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: protopieSubmissionsQueryKey(projectUuid, formKey),
            });
        },
    });
};

export const useProtopieChurnConfig = (projectUuid?: string) =>
    useQuery<Protopie.ChurnScoreConfigWithFactors, ApiError>({
        queryKey: protopieChurnConfigQueryKey(projectUuid),
        enabled: Boolean(projectUuid),
        queryFn: () =>
            lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/config`,
            }) as Promise<Protopie.ChurnScoreConfigWithFactors>,
    });

export const useUpdateProtopieChurnConfig = (projectUuid?: string) => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<
        Protopie.ChurnScoreConfigWithFactors,
        ApiError,
        Protopie.ChurnScoreConfigInput
    >({
        mutationFn: (payload) =>
            lightdashApi<AnyType>({
                method: 'PUT',
                url: `/projects/${projectUuid}/protopie/churn/config`,
                body: JSON.stringify(payload),
            }) as Promise<Protopie.ChurnScoreConfigWithFactors>,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnScoresQueryKeyBase(projectUuid),
            });
            showToastSuccess({
                title: 'Churn rubric saved',
            });
        },
        onError: ({ error }) => {
            showToastApiError({
                title: 'Failed to save churn rubric',
                apiError: error,
            });
        },
    });
};

export const useRecomputeProtopieChurnScore = (projectUuid?: string) => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<{ runUuid: string; status: 'queued' }, ApiError>({
        mutationFn: () =>
            lightdashApi<AnyType>({
                method: 'POST',
                url: `/projects/${projectUuid}/protopie/churn/recompute`,
                body: undefined,
            }) as Promise<{ runUuid: string; status: 'queued' }>,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: protopieChurnRunsQueryKey(projectUuid),
            });
            showToastSuccess({
                title: 'Churn recompute queued',
            });
        },
        onError: ({ error }) => {
            showToastApiError({
                title: 'Failed to queue churn recompute',
                apiError: error,
            });
        },
    });
};

export const useProtopieChurnRun = ({
    projectUuid,
    runUuid,
}: {
    projectUuid?: string;
    runUuid?: string;
}) =>
    useQuery<Protopie.ChurnScoreRun, ApiError>({
        queryKey: protopieChurnRunQueryKey(projectUuid, runUuid),
        enabled: Boolean(projectUuid && runUuid),
        refetchInterval: (run) =>
            run?.status === 'queued' || run?.status === 'running'
                ? 2000
                : false,
        queryFn: () =>
            lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/runs/${runUuid}`,
            }) as Promise<Protopie.ChurnScoreRun>,
    });

export const useProtopieChurnScores = ({
    projectUuid,
    filters,
}: {
    projectUuid?: string;
    filters?: Protopie.ChurnScoreLatestFilters;
}) =>
    useQuery<Protopie.ChurnScore[], ApiError>({
        queryKey: protopieChurnScoresQueryKey(projectUuid, filters),
        enabled: Boolean(projectUuid),
        queryFn: () => {
            const params = new URLSearchParams();
            if (filters?.riskBand) params.set('riskBand', filters.riskBand);
            if (filters?.minScore !== undefined) {
                params.set('minScore', String(filters.minScore));
            }
            if (filters?.maxScore !== undefined) {
                params.set('maxScore', String(filters.maxScore));
            }
            if (filters?.namespace) params.set('namespace', filters.namespace);
            if (filters?.limit !== undefined) {
                params.set('limit', String(filters.limit));
            }
            if (filters?.offset !== undefined) {
                params.set('offset', String(filters.offset));
            }

            return lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/scores/latest?${params.toString()}`,
            }) as Promise<Protopie.ChurnScore[]>;
        },
    });
