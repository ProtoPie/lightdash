import { z } from 'zod';
import {
    PROTOPIE_ACCOUNT_ID_FIELDS,
    type ProtopieFormField,
} from '../defineForm';

const emptyStringToUndefined = (value: unknown) =>
    value === '' ? undefined : value;

export const optionalTrimmedString = z.preprocess(
    emptyStringToUndefined,
    z.string().trim().min(1).optional(),
);

export const optionalUrl = z.preprocess(
    emptyStringToUndefined,
    z.string().trim().url().optional(),
);

export const accountIdentityShape = {
    account_key: optionalTrimmedString,
    cloud_url: optionalUrl,
    salesforce_account_id: optionalTrimmedString,
};

export const accountIdentityFields: ProtopieFormField[] = [
    {
        key: 'account_key',
        label: 'Account key',
        type: 'text',
        placeholder: 'Internal account key',
    },
    {
        key: 'cloud_url',
        label: 'Cloud URL',
        type: 'url',
        placeholder: 'https://example.protopie.cloud',
    },
    {
        key: 'salesforce_account_id',
        label: 'Salesforce account ID',
        type: 'text',
    },
];

export const withAccountIdentity = <TShape extends z.ZodRawShape>(
    shape: TShape,
) =>
    z
        .object({
            ...accountIdentityShape,
            ...shape,
        })
        .superRefine((payload, ctx) => {
            const hasAccountIdentifier = PROTOPIE_ACCOUNT_ID_FIELDS.some(
                (field) => Boolean(payload[field]),
            );

            if (!hasAccountIdentifier) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message:
                        'Provide at least one account identifier: account_key, cloud_url, or salesforce_account_id.',
                    path: ['account_key'],
                });
            }
        });
