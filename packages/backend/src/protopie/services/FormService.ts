import {
    ForbiddenError,
    ParameterError,
    Protopie,
    type SessionUser,
} from '@lightdash/common';
import { BaseService } from '../../services/BaseService';
import {
    FormDefinitionModel,
    type ProtopieFormDefinitionRecord,
} from '../models/FormDefinitionModel';
import {
    FormSubmissionModel,
    type ProtopieFormSubmissionRecord,
} from '../models/FormSubmissionModel';

type FormServiceArguments = {
    formDefinitionModel: FormDefinitionModel;
    formSubmissionModel: FormSubmissionModel;
};

export class FormService extends BaseService {
    private readonly formDefinitionModel: FormDefinitionModel;

    private readonly formSubmissionModel: FormSubmissionModel;

    constructor({
        formDefinitionModel,
        formSubmissionModel,
    }: FormServiceArguments) {
        super();
        this.formDefinitionModel = formDefinitionModel;
        this.formSubmissionModel = formSubmissionModel;
    }

    async listSchemas({
        projectUuid,
        user,
    }: {
        projectUuid: string;
        user: SessionUser;
    }): Promise<Protopie.ProtopieClientFormDefinition[]> {
        await this.ensureCodeDefinedForms(projectUuid, user.userUuid);
        return Protopie.getProtopieClientFormDefinitions();
    }

    async submit({
        projectUuid,
        formKey,
        payload,
        user,
    }: {
        projectUuid: string;
        formKey: string;
        payload: unknown;
        user: SessionUser;
    }): Promise<ProtopieFormSubmissionRecord> {
        const organizationUuid = FormService.getOrganizationUuid(user);
        const form = Protopie.getProtopieFormDefinition(formKey);
        const validation = form.schema.safeParse(payload);

        if (!validation.success) {
            throw new ParameterError(
                validation.error.issues
                    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                    .join('; '),
            );
        }

        const parsedPayload = validation.data as unknown;
        const definition = await this.ensureCodeDefinedForm(
            projectUuid,
            user.userUuid,
            form,
        );
        const accountIdentity =
            FormService.extractAccountIdentity(parsedPayload);

        return this.formSubmissionModel.insertSubmission({
            organizationUuid,
            projectUuid,
            formDefinitionUuid: definition.formDefinitionUuid,
            formKey: form.key,
            schemaVersion: form.version,
            payload: FormService.toJsonRecord(parsedPayload),
            createdByUserUuid: user.userUuid,
            ...accountIdentity,
        });
    }

    async listSubmissions({
        projectUuid,
        formKey,
        accountKey,
        limit,
        offset,
        user,
    }: {
        projectUuid: string;
        formKey: string;
        accountKey?: string;
        limit?: number;
        offset?: number;
        user: SessionUser;
    }): Promise<ProtopieFormSubmissionRecord[]> {
        const organizationUuid = FormService.getOrganizationUuid(user);
        Protopie.getProtopieFormDefinition(formKey);

        return this.formSubmissionModel.listSubmissions({
            organizationUuid,
            projectUuid,
            formKey,
            accountKey,
            limit: Math.min(Math.max(limit ?? 50, 1), 500),
            offset: Math.max(offset ?? 0, 0),
        });
    }

    private async ensureCodeDefinedForms(
        projectUuid: string,
        userUuid: string,
    ): Promise<ProtopieFormDefinitionRecord[]> {
        return Promise.all(
            Protopie.PROTOPIE_FORM_REGISTRY.map((form) =>
                this.ensureCodeDefinedForm(projectUuid, userUuid, form),
            ),
        );
    }

    private async ensureCodeDefinedForm(
        projectUuid: string,
        userUuid: string,
        form: Protopie.ProtopieFormDefinition,
    ): Promise<ProtopieFormDefinitionRecord> {
        return this.formDefinitionModel.upsertCodeDefinedForm({
            projectUuid,
            form,
            userUuid,
        });
    }

    private static getOrganizationUuid(user: SessionUser): string {
        if (!user.organizationUuid) {
            throw new ForbiddenError(
                'Protopie forms require an organization-scoped user.',
            );
        }

        return user.organizationUuid;
    }

    private static extractAccountIdentity(payload: unknown): {
        accountKey: string | null;
        cloudUrl: string | null;
        salesforceAccountId: string | null;
    } {
        if (!payload || typeof payload !== 'object') {
            throw new ParameterError('Form payload must be an object.');
        }

        const record = payload as Record<string, unknown>;
        const cloudUrl = FormService.stringOrNull(record.cloud_url);
        const salesforceAccountId = FormService.stringOrNull(
            record.salesforce_account_id,
        );
        const accountKey =
            FormService.stringOrNull(record.account_key) ??
            cloudUrl ??
            salesforceAccountId;

        return {
            accountKey,
            cloudUrl,
            salesforceAccountId,
        };
    }

    private static stringOrNull(value: unknown): string | null {
        return typeof value === 'string' && value.length > 0 ? value : null;
    }

    private static toJsonRecord(payload: unknown): Record<string, unknown> {
        return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    }
}
