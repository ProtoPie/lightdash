import assertUnreachable from '../../utils/assertUnreachable';
import {
    type ChurnScoreAggregation,
    type ChurnScoreFactorInput,
    type ChurnScoreFunction,
    type ChurnScoreStepThresholds,
} from './types';

export const DEFAULT_CHURN_SCORE_CONFIG_NAME = 'Default Churn Score';

export const DEFAULT_CHURN_SCORE_LOOKBACK_DAYS = 90;

/**
 * Width of the Event usage explorer's selectable date window, anchored to the
 * mart-wide latest `event_date` (NOT per-account, NOT the rubric lookback).
 * Sales can only browse the most recent 90 days of `protopie_account_event_usage`.
 */
export const CHURN_SCORE_EVENT_USAGE_WINDOW_DAYS = 90;

/**
 * Scoring function for the default rubric. ChurnZero parity uses integer
 * step buckets ("Allocated points"), not linear partial credit.
 */
export const DEFAULT_CHURN_SCORE_FUNCTION: ChurnScoreFunction = 'stepwise';

/**
 * Per-factor lookback for `% activated/logged-in`. ChurnZero scores this
 * factor over 120 days (all other factors use 90).
 */
export const ACTIVATED_FACTOR_WINDOW_DAYS = 120;

/**
 * Factor key of the `% activated/logged-in` factor. ChurnZero scores this one
 * with a special 2-step bucket (51+%→100%, 1-50%→50%), unlike the standard
 * 4-step percentage bucket, so `deriveStepThresholds` special-cases it.
 */
export const ACTIVATED_FACTOR_KEY = 'pct_activated_logged_in_users';

/**
 * Risk-band cutoffs on the engagement-health fraction (scorePercent, 0-1).
 * Higher health → lower churn risk, so `scorePercent >= low` is 'low' risk.
 */
export const DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS = {
    low: 0.75,
    medium: 0.5,
} as const;

/**
 * Standard ChurnZero "% of users" bucket (used by most percentage factors):
 * 51+%→100%, 26-50%→66%, 1-25%→33%, 0→0. `points` are the integer "Allocated
 * points" CZ displays/awards. ChurnZero rounds UP (ceil): e.g. 33% of 10 = 3.3
 * is awarded as 4, 66% of 5 = 3.3 as 4 — matching the rubric screenshots.
 */
const pctRanges = (max: number) => ({
    ranges: [
        { bottom: 51, top: null, points: max },
        { bottom: 26, top: 50, points: Math.ceil(max * 0.66) },
        { bottom: 1, top: 25, points: Math.ceil(max * 0.33) },
        { bottom: 0, top: 0, points: 0 },
    ],
});

/**
 * ChurnZero "% activated/logged-in" special 2-step bucket:
 * 51+%→100%, 1-50%→50%, 0→0 (no 26-50 / 1-25 split).
 */
const activatedRanges = (max: number): ChurnScoreStepThresholds => ({
    ranges: [
        { bottom: 51, top: null, points: max },
        { bottom: 1, top: 50, points: Math.ceil(max * 0.5) },
        { bottom: 0, top: 0, points: 0 },
    ],
});

/**
 * Standard ChurnZero "per user" bucket (count per user):
 * 21+→100%, 11-20→66%, 1-10→33%, 0→0 (ceil rounding, as above).
 */
const perUserRanges = (max: number) => ({
    ranges: [
        { bottom: 21, top: null, points: max },
        { bottom: 11, top: 20, points: Math.ceil(max * 0.66) },
        { bottom: 1, top: 10, points: Math.ceil(max * 0.33) },
        { bottom: 0, top: 0, points: 0 },
    ],
});

/**
 * ChurnZero "Active Days" bucket: 11+→100%, 6-10→66%, 1-5→33%, 0→0.
 */
const activeDaysRanges = (max: number): ChurnScoreStepThresholds => ({
    ranges: [
        { bottom: 11, top: null, points: max },
        { bottom: 6, top: 10, points: Math.ceil(max * 0.66) },
        { bottom: 1, top: 5, points: Math.ceil(max * 0.33) },
        { bottom: 0, top: 0, points: 0 },
    ],
});

/**
 * Raw event-count bucket scaled to the factor goal (ChurnZero "Messages"
 * style): goal+→100%, 1..goal-1→50%, 0→0.
 */
const countRanges = (
    max: number,
    goalValue: number,
): ChurnScoreStepThresholds => {
    const goal = Math.max(1, Math.round(goalValue));
    return {
        ranges: [
            { bottom: goal, top: null, points: max },
            { bottom: 1, top: goal - 1, points: Math.ceil(max * 0.5) },
            { bottom: 0, top: 0, points: 0 },
        ],
    };
};

/**
 * Derives ChurnZero-style step buckets for a factor from its aggregation,
 * weight (`maxPoints`) and goal. The rubric editor calls this when a config is
 * saved as `stepwise` so the buckets always match the current weights — the
 * percent/per-user/days breakpoints mirror the ChurnZero rubric exactly.
 */
export const deriveStepThresholds = (
    aggregation: ChurnScoreAggregation,
    maxPoints: number,
    goalValue: number,
    factorKey?: string,
): ChurnScoreStepThresholds => {
    if (factorKey === ACTIVATED_FACTOR_KEY) {
        return activatedRanges(maxPoints);
    }
    switch (aggregation) {
        case 'pct_users_with_event':
            return pctRanges(maxPoints);
        case 'event_count_per_user':
            return perUserRanges(maxPoints);
        case 'active_days':
            return activeDaysRanges(maxPoints);
        case 'event_count':
            return countRanges(maxPoints, goalValue);
        default:
            return assertUnreachable(
                aggregation,
                `Unknown churn score aggregation: ${aggregation}`,
            );
    }
};

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
        // ChurnZero "% users Launch/Entered/Started" uses 31% (not 33%) for the
        // 1-25 bucket on this 5-point factor.
        stepThresholds: {
            ranges: [
                { bottom: 51, top: null, points: 5 },
                { bottom: 26, top: 50, points: 4 },
                { bottom: 1, top: 25, points: 2 },
                { bottom: 0, top: 0, points: 0 },
            ],
        },
        windowDays: 90,
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
        stepThresholds: perUserRanges(5),
        windowDays: 90,
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
        // ChurnZero "% activated/logged-in" uses a 2-step bucket over 120 days:
        // 51+%→100%, 1-50%→50%.
        stepThresholds: {
            ranges: [
                { bottom: 51, top: null, points: 10 },
                { bottom: 1, top: 50, points: 5 },
                { bottom: 0, top: 0, points: 0 },
            ],
        },
        windowDays: ACTIVATED_FACTOR_WINDOW_DAYS,
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
        stepThresholds: perUserRanges(10),
        windowDays: 90,
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
        stepThresholds: pctRanges(10),
        windowDays: 90,
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
        stepThresholds: pctRanges(10),
        windowDays: 90,
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
        stepThresholds: pctRanges(15),
        windowDays: 90,
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
        stepThresholds: perUserRanges(15),
        windowDays: 90,
        sortOrder: 80,
    },
    {
        factorKey: 'number_of_messages_received',
        label: 'Number of Messages Received',
        maxPoints: 10,
        goalValue: 5,
        goalUnit: 'count',
        aggregation: 'event_count',
        // No Amplitude source for CZ in-app messages → empty group → always 0,
        // matching ChurnZero (which also shows 0/10 for these accounts). Kept in
        // the 100-point denominator for parity.
        eventGroup: {
            operator: 'or',
            events: [],
        },
        stepThresholds: {
            ranges: [
                { bottom: 5, top: null, points: 10 },
                { bottom: 1, top: 4, points: 5 },
                { bottom: 0, top: 0, points: 0 },
            ],
        },
        windowDays: 90,
        sortOrder: 90,
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
        // ChurnZero "Active Days": 11+→100%, 6-10→66%, 1-5→33%. Goal is 10 but
        // full points require 11+.
        stepThresholds: {
            ranges: [
                { bottom: 11, top: null, points: 10 },
                { bottom: 6, top: 10, points: 7 },
                { bottom: 1, top: 5, points: 4 },
                { bottom: 0, top: 0, points: 0 },
            ],
        },
        windowDays: 90,
        sortOrder: 100,
    },
];
