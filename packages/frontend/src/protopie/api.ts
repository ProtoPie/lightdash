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
