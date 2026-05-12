import { z } from 'zod';
import { defineProtopieForm } from '../defineForm';
import {
    accountIdentityFields,
    optionalTrimmedString,
    withAccountIdentity,
} from './accountIdentity';

export const churnScoreInputForm = defineProtopieForm({
    key: 'churn_score_input',
    version: 1,
    title: 'Churn score input',
    description:
        'Temporary dummy form for sales-owned churn score inputs. Final fields will be defined later.',
    accountIdFields: ['account_key', 'cloud_url', 'salesforce_account_id'],
    schema: withAccountIdentity({
        signal_date: z.string().trim().min(1),
        signal_name: z.string().trim().min(1),
        signal_value: z.number().min(0),
        notes: optionalTrimmedString,
    }),
    fields: [
        ...accountIdentityFields,
        {
            key: 'signal_date',
            label: 'Signal date',
            type: 'date',
            required: true,
        },
        {
            key: 'signal_name',
            label: 'Signal name',
            type: 'text',
            required: true,
            placeholder: 'Example: sales_risk_score',
        },
        {
            key: 'signal_value',
            label: 'Signal value',
            type: 'number',
            required: true,
            placeholder: 'Example: 10',
        },
        {
            key: 'notes',
            label: 'Notes',
            type: 'textarea',
        },
    ],
});
