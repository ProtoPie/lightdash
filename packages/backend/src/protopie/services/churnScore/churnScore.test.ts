import { Protopie } from '@lightdash/common';
import { buildAggregationQuery } from './buildAggregationQuery';
import { deriveRiskBand } from './deriveRiskBand';
import { scoreAccount } from './scoreAccount';
import { validateChurnScoreConfigInput } from './validateChurnScoreConfigInput';

const factors: Protopie.ChurnScoreFactor[] =
    Protopie.DEFAULT_CHURN_SCORE_FACTORS.map((factor, index) => ({
        ...factor,
        factorUuid: `factor-${index}`,
        configUuid: 'config-uuid',
    }));

const factorByKey = (factorKey: string): Protopie.ChurnScoreFactor => {
    const factor = factors.find(
        (candidate) => candidate.factorKey === factorKey,
    );

    if (!factor) {
        throw new Error(`Missing test factor ${factorKey}`);
    }

    return factor;
};

describe('scoreAccount (stepwise)', () => {
    test('returns zero churn-health (churnScore 100) with no users or events', () => {
        const result = scoreAccount({
            factors,
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'https://acme.protopie.cloud',
                namespace: 'acme',
                cloud_url: 'https://acme.protopie.cloud',
                total_users: 0,
                active_days: 0,
            },
        });

        expect(result.totalPoints).toEqual(0);
        expect(result.maxPoints).toEqual(100);
        expect(result.normalizedScore).toEqual(0);
        expect(result.churnScore).toEqual(100);
        expect(result.riskBand).toEqual('high');
    });

    test('full engagement caps health at 90 (Messages factor uncomputable)', () => {
        const result = scoreAccount({
            factors,
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'https://acme.protopie.cloud',
                namespace: 'acme',
                cloud_url: 'https://acme.protopie.cloud',
                total_users: 10,
                active_days: 11,
                pct_users_with_starting_action_users: 6,
                starting_actions_per_user_event_count: 210,
                pct_activated_logged_in_users_users: 6,
                pie_creation_save_actions_per_user_event_count: 210,
                pct_users_with_pie_creation_save_action_users: 6,
                pct_users_with_ai_feature_usage_users: 6,
                pct_users_with_trigger_or_response_action_users: 6,
                trigger_response_actions_per_user_event_count: 210,
                number_of_messages_received_event_count: 0,
            },
        });

        expect(result.totalPoints).toEqual(90);
        expect(result.maxPoints).toEqual(100);
        expect(result.normalizedScore).toEqual(90);
        expect(result.churnScore).toEqual(10);
        expect(result.riskBand).toEqual('low');
    });

    test('truncate semantics: raw below the lowest bucket bottom scores 0', () => {
        const result = scoreAccount({
            factors: [
                factorByKey('trigger_response_actions_per_user'),
                factorByKey('pct_users_with_ai_feature_usage'),
            ],
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'https://kakaopay.protopie.cloud',
                namespace: 'kakaopay',
                cloud_url: 'https://kakaopay.protopie.cloud',
                total_users: 259,
                active_days: 0,
                // 227 / 259 = 0.876 per user → below bottom 1 → 0 points
                trigger_response_actions_per_user_event_count: 227,
                // 2 / 259 = 0.77% → below bottom 1% → 0 points
                pct_users_with_ai_feature_usage_users: 2,
            },
        });

        expect(
            result.factorScores.trigger_response_actions_per_user.points,
        ).toEqual(0);
        expect(
            result.factorScores.pct_users_with_ai_feature_usage.points,
        ).toEqual(0);
        expect(result.totalPoints).toEqual(0);
    });

    test('per-user and percentage buckets award integer allocated points (rivian-like)', () => {
        const result = scoreAccount({
            factors: [
                factorByKey('pie_creation_save_actions_per_user'),
                factorByKey('pct_users_with_pie_creation_save_action'),
                factorByKey('pct_activated_logged_in_users'),
                factorByKey('active_days'),
            ],
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'https://rivian.protopie.cloud',
                namespace: 'rivian',
                cloud_url: 'https://rivian.protopie.cloud',
                total_users: 117,
                active_days: 71,
                // 2106 / 117 = 18.0 → 11-20 bucket → 7 of 10
                pie_creation_save_actions_per_user_event_count: 2106,
                // 5 / 117 = 4.27% → 1-25 bucket → 4 of 10
                pct_users_with_pie_creation_save_action_users: 5,
                // 12 / 117 = 10.26% → 1-50 bucket → 5 of 10
                pct_activated_logged_in_users_users: 12,
            },
        });

        expect(
            result.factorScores.pie_creation_save_actions_per_user.points,
        ).toEqual(7);
        expect(
            result.factorScores.pct_users_with_pie_creation_save_action.points,
        ).toEqual(4);
        expect(
            result.factorScores.pct_activated_logged_in_users.points,
        ).toEqual(5);
        // active_days 71 → 11+ bucket → 10
        expect(result.factorScores.active_days.points).toEqual(10);
        expect(result.totalPoints).toEqual(26);
        expect(result.maxPoints).toEqual(40);
    });

    test('active_days bucket edges: 10 → 7 (66%), 11 → 10 (100%)', () => {
        const base = {
            account_key: 'https://acme.protopie.cloud',
            namespace: 'acme',
            cloud_url: 'https://acme.protopie.cloud',
            total_users: 10,
        };
        const at10 = scoreAccount({
            factors: [factorByKey('active_days')],
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: { ...base, active_days: 10 },
        });
        const at11 = scoreAccount({
            factors: [factorByKey('active_days')],
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: { ...base, active_days: 11 },
        });

        expect(at10.factorScores.active_days.points).toEqual(7);
        expect(at11.factorScores.active_days.points).toEqual(10);
    });

    test('churnScore always inverts normalizedScore', () => {
        const result = scoreAccount({
            factors,
            scoreFunction: 'stepwise',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'https://acme.protopie.cloud',
                namespace: 'acme',
                cloud_url: 'https://acme.protopie.cloud',
                total_users: 117,
                active_days: 71,
                pct_users_with_pie_creation_save_action_users: 5,
            },
        });

        expect(result.churnScore).toEqual(
            Math.round((100 - result.normalizedScore) * 100) / 100,
        );
    });
});

describe('scoreAccount (linear back-compat)', () => {
    test('applies linear partial credit and clamps over-goal factors', () => {
        const result = scoreAccount({
            factors: [
                factorByKey('starting_actions_per_user'),
                factorByKey('active_days'),
            ],
            scoreFunction: 'linear',
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'team-1',
                namespace: null,
                cloud_url: null,
                total_users: 10,
                active_days: 20,
                starting_actions_per_user_event_count: 120,
            },
        });

        // 120 / 10 = 12 per user, goal 20 → 0.6 * 5 = 3
        expect(result.factorScores.starting_actions_per_user.points).toEqual(3);
        // active_days 20, goal 10 → clamp to 10
        expect(result.factorScores.active_days.points).toEqual(10);
        expect(result.totalPoints).toEqual(13);
        expect(result.maxPoints).toEqual(15);
    });
});

describe('deriveRiskBand', () => {
    test('honors custom thresholds (health fraction → risk band)', () => {
        expect(
            deriveRiskBand({
                scorePercent: 0.7,
                thresholds: { low: 0.8, medium: 0.6 },
            }),
        ).toEqual('medium');
    });
});

describe('validateChurnScoreConfigInput', () => {
    test('accepts a stepwise config whose weights total 100', () => {
        const result = validateChurnScoreConfigInput({
            name: 'Custom',
            lookbackDays: 90,
            scoreFunction: 'stepwise',
            riskBandThresholds:
                Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            factors: Protopie.DEFAULT_CHURN_SCORE_FACTORS,
        });

        expect(result.factors).toHaveLength(
            Protopie.DEFAULT_CHURN_SCORE_FACTORS.length,
        );
    });

    test('rejects a stepwise factor missing step thresholds', () => {
        expect(() =>
            validateChurnScoreConfigInput({
                name: 'Custom',
                lookbackDays: 90,
                scoreFunction: 'stepwise',
                riskBandThresholds:
                    Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
                factors: [
                    {
                        ...factorByKey('active_days'),
                        maxPoints: 100,
                        stepThresholds: null,
                    },
                ],
            }),
        ).toThrow('stepThresholds');
    });

    test('requires weights to total 100', () => {
        expect(() =>
            validateChurnScoreConfigInput({
                name: 'Custom',
                lookbackDays: 90,
                scoreFunction: 'stepwise',
                riskBandThresholds:
                    Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
                factors: Protopie.DEFAULT_CHURN_SCORE_FACTORS.slice(0, 2),
            }),
        ).toThrow('Churn score factor weights must total 100');
    });
});

describe('buildAggregationQuery', () => {
    test('reads the CZ-faithful marts with per-factor windows', () => {
        const { sql, values } = buildAggregationQuery({
            schema: 'warehouse_staging',
            lookbackDays: 90,
            factors,
        });
        const expectedValues = factors
            .filter((factor) => factor.aggregation !== 'active_days')
            .flatMap((factor) => factor.eventGroup.events);

        expect(values).toEqual(expectedValues);
        expect(values).toHaveLength(26);

        // canonical account_key roster + distinct_user_count denominator
        expect(sql).toContain('c.account_key AS account_key');
        expect(sql).toContain('c.distinct_user_count AS total_users');
        expect(sql).toContain('c.account_owner AS account_owner');
        expect(sql).toContain(
            'FROM warehouse_staging.protopie_account_user_counts c',
        );
        expect(sql).toContain(
            'FROM warehouse_staging.protopie_account_event_usage_enterprise_all eu',
        );
        // single canonical-key join (enterprise slug / Pro-Plus account name)
        expect(sql).toContain('ON e.account_key = c.account_key');
        expect(sql).toContain('GROUP BY eu.account_key');
        expect(sql).toContain('LEFT JOIN event_agg e');

        // standard 90-day factors
        expect(sql).toContain(
            'COUNT(DISTINCT CASE WHEN eu.event_name IN ($1, $2, $3, $4) AND eu.event_date >= CURRENT_DATE - 90 THEN eu.user_id END) AS pct_users_with_starting_action_users',
        );
        // % activated uses a 120-day window
        expect(sql).toContain(
            'eu.event_date >= CURRENT_DATE - 120 THEN eu.user_id END) AS pct_activated_logged_in_users_users',
        );
        // per-user instance totals
        expect(sql).toContain('AS starting_actions_per_user_event_count');
        expect(sql).toContain('SUM(CASE WHEN');
        // active days, no event filter
        expect(sql).toContain(
            'COUNT(DISTINCT CASE WHEN eu.event_date >= CURRENT_DATE - 90 THEN eu.event_date END) AS active_days',
        );
        // Messages factor has no events → FALSE predicate → always 0
        expect(sql).toContain(
            'SUM(CASE WHEN FALSE AND eu.event_date >= CURRENT_DATE - 90 THEN eu.event_count ELSE 0 END) AS number_of_messages_received_event_count',
        );
        // outer event_agg scans the widest window (120)
        expect(sql).toContain('eu.event_date >= CURRENT_DATE - 120');
        expect(sql).not.toContain('team_id');
        expect(sql).not.toContain('dim_product_all_events');
    });

    test('rejects unsafe schema identifiers and event names', () => {
        expect(() =>
            buildAggregationQuery({
                schema: 'warehouse;drop',
                lookbackDays: 90,
                factors,
            }),
        ).toThrow('Invalid warehouse schema');

        expect(() =>
            buildAggregationQuery({
                schema: 'warehouse',
                lookbackDays: 90,
                factors: [
                    {
                        ...factors[0],
                        eventGroup: {
                            operator: 'or',
                            events: ['safe', 'bad\u0000event'],
                        },
                    },
                ],
            }),
        ).toThrow('Invalid churn score event name');
    });
});
