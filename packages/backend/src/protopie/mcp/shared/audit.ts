import { type ProtopieMcpContext, type ProtopieMcpToolDeps } from './types';

const getErrorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const withMcpWriteAudit = async <T>({
    deps,
    context,
    toolName,
    projectUuid,
    inputSummary,
    run,
}: {
    deps: ProtopieMcpToolDeps;
    context: ProtopieMcpContext;
    toolName: string;
    projectUuid?: string | null;
    inputSummary?: Record<string, unknown>;
    run: () => Promise<T>;
}): Promise<T> => {
    const { user, organizationUuid, account } = deps.getAccount(context);

    try {
        const result = await run();
        await deps.audit?.({
            organizationUuid,
            projectUuid,
            userUuid: user.userUuid,
            authenticationType: account.authentication.type,
            toolName,
            inputSummary,
            outcome: 'success',
        });
        return result;
    } catch (error) {
        await deps.audit?.({
            organizationUuid,
            projectUuid,
            userUuid: user.userUuid,
            authenticationType: account.authentication.type,
            toolName,
            inputSummary,
            outcome: 'error',
            errorMessage: getErrorMessage(error),
        });
        throw error;
    }
};
