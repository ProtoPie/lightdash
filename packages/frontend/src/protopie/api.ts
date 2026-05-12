import { type AnyType, type ApiError, type Protopie } from '@lightdash/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lightdashApi } from '../api';

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

const protopieFormsQueryKey = (projectUuid?: string) => [
    'protopie',
    'forms',
    projectUuid,
];

const protopieSubmissionsQueryKey = (
    projectUuid?: string,
    formKey?: string,
) => ['protopie', 'form-submissions', projectUuid, formKey];

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
