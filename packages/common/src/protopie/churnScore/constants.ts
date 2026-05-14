import { type ChurnScoreFactorInput } from './types';

export const DEFAULT_CHURN_SCORE_CONFIG_NAME = 'Default Churn Score';

export const DEFAULT_CHURN_SCORE_LOOKBACK_DAYS = 90;

export const DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS = {
    low: 0.75,
    medium: 0.5,
} as const;

export const DEFAULT_CHURN_SCORE_FACTORS: ChurnScoreFactorInput[] = [
    {
        factorKey: 'pct_users_with_starting_action',
        label: '% users with starting action',
        maxPoints: 5,
        goalValue: 0.5,
        goalUnit: 'fraction',
        aggregation: 'pct_users_with_event',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - App - Launched',
                'Cloud - Studio - Launched',
                'session_start',
                'Cloud - Page - Entered',
            ],
        },
        stepThresholds: null,
        sortOrder: 10,
    },
    {
        factorKey: 'starting_actions_per_user',
        label: '# starting actions per user',
        maxPoints: 5,
        goalValue: 20,
        goalUnit: 'count_per_user',
        aggregation: 'event_count_per_user',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - App - Launched',
                'Cloud - Studio - Launched',
                'session_start',
                'Cloud - Page - Entered',
            ],
        },
        stepThresholds: null,
        sortOrder: 20,
    },
    {
        factorKey: 'pct_activated_logged_in_users',
        label: '% activated / logged-in users',
        maxPoints: 10,
        goalValue: 0.5,
        goalUnit: 'fraction',
        aggregation: 'pct_users_with_event',
        eventGroup: {
            operator: 'or',
            events: ['Studio - Login - Completed', 'editor_activated'],
        },
        stepThresholds: null,
        sortOrder: 30,
    },
    {
        factorKey: 'pie_creation_save_actions_per_user',
        label: '# pie creation / save actions per user',
        maxPoints: 10,
        goalValue: 20,
        goalUnit: 'count_per_user',
        aggregation: 'event_count_per_user',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - Pie - Created',
                'Studio - Pie - Opened',
                'Studio - Pie - Saved',
                'Studio - Plugin - Imported',
                'Studio - Preview - Opened',
            ],
        },
        stepThresholds: null,
        sortOrder: 40,
    },
    {
        factorKey: 'pct_users_with_pie_creation_save_action',
        label: '% users with pie creation / save action',
        maxPoints: 10,
        goalValue: 0.5,
        goalUnit: 'fraction',
        aggregation: 'pct_users_with_event',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - Pie - Created',
                'Studio - Pie - Opened',
                'Studio - Pie - Saved',
                'Studio - Plugin - Imported',
                'Studio - Preview - Opened',
            ],
        },
        stepThresholds: null,
        sortOrder: 50,
    },
    {
        factorKey: 'pct_users_with_ai_feature_usage',
        label: '% users with AI feature usage',
        maxPoints: 10,
        goalValue: 0.5,
        goalUnit: 'fraction',
        aggregation: 'pct_users_with_event',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - AI - Prompt Sent',
                'Studio - AI Panel - Panel Toggled',
            ],
        },
        stepThresholds: null,
        sortOrder: 60,
    },
    {
        factorKey: 'pct_users_with_trigger_or_response_action',
        label: '% users with Trigger or Response action',
        maxPoints: 15,
        goalValue: 0.5,
        goalUnit: 'fraction',
        aggregation: 'pct_users_with_event',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - Response Interaction - Added',
                'Studio - Trigger Interaction - Added',
            ],
        },
        stepThresholds: null,
        sortOrder: 70,
    },
    {
        factorKey: 'trigger_response_actions_per_user',
        label: '# trigger/response actions per user',
        maxPoints: 15,
        goalValue: 20,
        goalUnit: 'count_per_user',
        aggregation: 'event_count_per_user',
        eventGroup: {
            operator: 'or',
            events: [
                'Studio - Response Interaction - Added',
                'Studio - Trigger Interaction - Added',
            ],
        },
        stepThresholds: null,
        sortOrder: 80,
    },
    {
        factorKey: 'active_days',
        label: 'Active days',
        maxPoints: 10,
        goalValue: 10,
        goalUnit: 'days',
        aggregation: 'active_days',
        eventGroup: {
            operator: 'or',
            events: [],
        },
        stepThresholds: null,
        sortOrder: 90,
    },
];
