import { type AnyType, type ApiError, type Protopie } from '@lightdash/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lightdashApi } from '../api';
import useToaster from '../hooks/toaster/useToaster';

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

const protopieMcpSettingsQueryKey = ['protopie', 'mcp-settings'];

const protopieChurnConfigsQueryKey = (projectUuid?: string) => [
    'protopie',
    'churn-configs',
    projectUuid,
];

const protopieChurnConfigQueryKey = (projectUuid?: string, name?: string) =>
    name
        ? ['protopie', 'churn-config', projectUuid, name]
        : ['protopie', 'churn-config', projectUuid];

const protopieChurnConfigVersionsQueryKey = (
    projectUuid?: string,
    name?: string,
) =>
    name
        ? ['protopie', 'churn-config-versions', projectUuid, name]
        : ['protopie', 'churn-config-versions', projectUuid];

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

const protopieChurnScoreAccountDetailsQueryKey = ({
    projectUuid,
    accountKey,
    configUuid,
    dateFrom,
    dateTo,
}: {
    projectUuid?: string;
    accountKey?: string;
    configUuid?: string;
    dateFrom?: string;
    dateTo?: string;
}) => [
    'protopie',
    'churn-score-account-details',
    projectUuid,
    accountKey,
    configUuid,
    dateFrom,
    dateTo,
];

const protopieChurnEventsQueryKey = (projectUuid?: string, search?: string) => [
    'protopie',
    'churn-events',
    projectUuid,
    search,
];

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

export const useProtopieChurnConfigs = (projectUuid?: string) =>
    useQuery<Protopie.ChurnScoreConfig[], ApiError>({
        queryKey: protopieChurnConfigsQueryKey(projectUuid),
        enabled: Boolean(projectUuid),
        queryFn: () =>
            lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/configs`,
            }) as Promise<Protopie.ChurnScoreConfig[]>,
    });

export const useProtopieChurnConfig = (projectUuid?: string, name?: string) =>
    useQuery<Protopie.ChurnScoreConfigWithFactors, ApiError>({
        queryKey: protopieChurnConfigQueryKey(projectUuid, name),
        enabled: Boolean(projectUuid),
        queryFn: () => {
            const params = new URLSearchParams();
            if (name) params.set('name', name);
            return lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/config?${params.toString()}`,
            }) as Promise<Protopie.ChurnScoreConfigWithFactors>;
        },
    });

export const useProtopieChurnConfigVersions = (
    projectUuid?: string,
    name?: string,
) =>
    useQuery<Protopie.ChurnScoreConfig[], ApiError>({
        queryKey: protopieChurnConfigVersionsQueryKey(projectUuid, name),
        enabled: Boolean(projectUuid),
        queryFn: () => {
            const params = new URLSearchParams();
            if (name) params.set('name', name);
            return lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/config/versions?${params.toString()}`,
            }) as Promise<Protopie.ChurnScoreConfig[]>;
        },
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
                queryKey: protopieChurnConfigsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigVersionsQueryKey(projectUuid),
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

export const useRestoreProtopieChurnConfigVersion = (projectUuid?: string) => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<Protopie.ChurnScoreConfigWithFactors, ApiError, string>({
        mutationFn: (configUuid) =>
            lightdashApi<AnyType>({
                method: 'POST',
                url: `/projects/${projectUuid}/protopie/churn/config/versions/${configUuid}/restore`,
                body: undefined,
            }) as Promise<Protopie.ChurnScoreConfigWithFactors>,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigVersionsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnScoresQueryKeyBase(projectUuid),
            });
            showToastSuccess({
                title: 'Churn rubric restored',
            });
        },
        onError: ({ error }) => {
            showToastApiError({
                title: 'Failed to restore churn rubric',
                apiError: error,
            });
        },
    });
};

export const useDeleteProtopieChurnConfig = (projectUuid?: string) => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<{ deleted: true }, ApiError, { name: string }>({
        mutationFn: ({ name }) => {
            const params = new URLSearchParams();
            params.set('name', name);
            return lightdashApi<AnyType>({
                method: 'DELETE',
                url: `/projects/${projectUuid}/protopie/churn/config?${params.toString()}`,
                body: undefined,
            }) as Promise<{ deleted: true }>;
        },
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigVersionsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnScoresQueryKeyBase(projectUuid),
            });
            showToastSuccess({
                title: 'Churn rubric deleted',
            });
        },
        onError: ({ error }) => {
            showToastApiError({
                title: 'Failed to delete churn rubric',
                apiError: error,
            });
        },
    });
};

export const useRenameProtopieChurnConfig = (projectUuid?: string) => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<
        Protopie.ChurnScoreConfigWithFactors,
        ApiError,
        Protopie.RenameChurnScoreConfigInput
    >({
        mutationFn: (body) =>
            lightdashApi<AnyType>({
                method: 'PUT',
                url: `/projects/${projectUuid}/protopie/churn/config/rename`,
                body: JSON.stringify(body),
            }) as Promise<Protopie.ChurnScoreConfigWithFactors>,
        onSuccess: async () => {
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnConfigVersionsQueryKey(projectUuid),
            });
            await queryClient.invalidateQueries({
                queryKey: protopieChurnScoresQueryKeyBase(projectUuid),
            });
            showToastSuccess({
                title: 'Churn rubric renamed',
            });
        },
        onError: ({ error }) => {
            showToastApiError({
                title: 'Failed to rename churn rubric',
                apiError: error,
            });
        },
    });
};

export const useRecomputeProtopieChurnScore = (projectUuid?: string) => {
    const queryClient = useQueryClient();
    const { showToastApiError, showToastSuccess } = useToaster();

    return useMutation<
        { runUuid: string; status: 'queued' },
        ApiError,
        { name?: string; configUuid?: string } | undefined
    >({
        mutationFn: (payload) => {
            const params = new URLSearchParams();
            if (payload?.name) params.set('name', payload.name);
            if (payload?.configUuid) {
                params.set('configUuid', payload.configUuid);
            }
            return lightdashApi<AnyType>({
                method: 'POST',
                url: `/projects/${projectUuid}/protopie/churn/recompute?${params.toString()}`,
                body: undefined,
            }) as Promise<{ runUuid: string; status: 'queued' }>;
        },
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

export const useProtopieChurnEvents = ({
    projectUuid,
    search,
}: {
    projectUuid?: string;
    search?: string;
}) =>
    useQuery<string[], ApiError>({
        queryKey: protopieChurnEventsQueryKey(projectUuid, search),
        enabled: Boolean(projectUuid),
        keepPreviousData: true,
        queryFn: () => {
            const params = new URLSearchParams();
            if (search) params.set('search', search);
            params.set('limit', '200');
            return lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/events?${params.toString()}`,
            }) as Promise<string[]>;
        },
    });

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

export const useProtopieChurnScoreAccountDetails = ({
    projectUuid,
    accountKey,
    configUuid,
    dateFrom,
    dateTo,
}: {
    projectUuid?: string;
    accountKey?: string;
    configUuid?: string;
    dateFrom?: string;
    dateTo?: string;
}) =>
    useQuery<Protopie.ChurnScoreAccountDetails, ApiError>({
        queryKey: protopieChurnScoreAccountDetailsQueryKey({
            projectUuid,
            accountKey,
            configUuid,
            dateFrom,
            dateTo,
        }),
        enabled: Boolean(projectUuid && accountKey),
        keepPreviousData: true,
        queryFn: () => {
            const params = new URLSearchParams();
            if (accountKey) params.set('accountKey', accountKey);
            if (configUuid) params.set('configUuid', configUuid);
            if (dateFrom) params.set('dateFrom', dateFrom);
            if (dateTo) params.set('dateTo', dateTo);

            return lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/scores/account/details?${params.toString()}`,
            }) as Promise<Protopie.ChurnScoreAccountDetails>;
        },
    });

// Appends the multi-select SF facet filters as repeated query params. Empty or
// absent arrays append nothing → unfiltered (never "match none"). Shared by the
// scores list and the faceted filter-options request so a new facet only needs
// wiring in one place.
const appendChurnFacetParams = (
    params: URLSearchParams,
    filters?: Protopie.ChurnScoreLatestFilters,
): void => {
    filters?.accountOwner?.forEach((value) =>
        params.append('accountOwner', value),
    );
    filters?.sfPlanCategory?.forEach((value) =>
        params.append('sfPlanCategory', value),
    );
    filters?.sfAccountRegion?.forEach((value) =>
        params.append('sfAccountRegion', value),
    );
    filters?.sfAccountCountry?.forEach((value) =>
        params.append('sfAccountCountry', value),
    );
};

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
        keepPreviousData: true,
        queryFn: () => {
            const params = new URLSearchParams();
            if (filters?.riskBand) params.set('riskBand', filters.riskBand);
            if (filters?.configUuid) {
                params.set('configUuid', filters.configUuid);
            }
            if (filters?.minScore !== undefined) {
                params.set('minScore', String(filters.minScore));
            }
            if (filters?.maxScore !== undefined) {
                params.set('maxScore', String(filters.maxScore));
            }
            if (filters?.namespace) params.set('namespace', filters.namespace);
            if (filters?.search) params.set('search', filters.search);
            appendChurnFacetParams(params, filters);
            if (filters?.sortBy) params.set('sortBy', filters.sortBy);
            if (filters?.sortDirection) {
                params.set('sortDirection', filters.sortDirection);
            }
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

export const useProtopieChurnScoreFilterOptions = (
    projectUuid?: string,
    filters?: Protopie.ChurnScoreLatestFilters,
) =>
    useQuery<Protopie.ChurnScoreFilterOptions, ApiError>({
        queryKey: ['protopie', 'churn-filter-options', projectUuid, filters],
        enabled: Boolean(projectUuid),
        keepPreviousData: true,
        queryFn: () => {
            const params = new URLSearchParams();
            if (filters?.configUuid)
                params.set('configUuid', filters.configUuid);
            if (filters?.riskBand) params.set('riskBand', filters.riskBand);
            if (filters?.search) params.set('search', filters.search);
            if (filters?.minScore !== undefined) {
                params.set('minScore', String(filters.minScore));
            }
            if (filters?.maxScore !== undefined) {
                params.set('maxScore', String(filters.maxScore));
            }
            // Each facet's own selection is ignored server-side when computing
            // that facet's options (faceted-search semantics).
            appendChurnFacetParams(params, filters);
            return lightdashApi<AnyType>({
                method: 'GET',
                url: `/projects/${projectUuid}/protopie/churn/scores/filter-options?${params.toString()}`,
            }) as Promise<Protopie.ChurnScoreFilterOptions>;
        },
    });
