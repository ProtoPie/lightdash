import { type z } from 'zod';

export const PROTOPIE_ACCOUNT_ID_FIELDS = [
    'account_key',
    'cloud_url',
    'salesforce_account_id',
] as const;

export type ProtopieAccountIdField =
    (typeof PROTOPIE_ACCOUNT_ID_FIELDS)[number];

export type ProtopieFormFieldType =
    | 'date'
    | 'number'
    | 'select'
    | 'switch'
    | 'tags'
    | 'text'
    | 'textarea'
    | 'url';

export type ProtopieFormFieldOption = {
    label: string;
    value: string;
};

export type ProtopieFormField = {
    key: string;
    label: string;
    type: ProtopieFormFieldType;
    required?: boolean;
    placeholder?: string;
    options?: ProtopieFormFieldOption[];
};

export type ProtopieFormDefinition<
    TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> = {
    key: string;
    version: number;
    title: string;
    description?: string;
    schema: TSchema;
    fields: ProtopieFormField[];
    accountIdFields: ProtopieAccountIdField[];
};

export type ProtopieClientFormDefinition = Omit<
    ProtopieFormDefinition,
    'schema'
>;

export type ProtopieFormPayload<
    TForm extends ProtopieFormDefinition = ProtopieFormDefinition,
> = z.infer<TForm['schema']>;

export const defineProtopieForm = <TSchema extends z.ZodTypeAny>(
    definition: ProtopieFormDefinition<TSchema>,
): ProtopieFormDefinition<TSchema> => definition;

export const toClientFormDefinition = (
    form: ProtopieFormDefinition,
): ProtopieClientFormDefinition => ({
    key: form.key,
    version: form.version,
    title: form.title,
    description: form.description,
    fields: form.fields,
    accountIdFields: form.accountIdFields,
});
