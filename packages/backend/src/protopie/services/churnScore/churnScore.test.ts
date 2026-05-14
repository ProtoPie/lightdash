import { Protopie } from '@lightdash/common';
import { buildAggregationQuery } from './buildAggregationQuery';
import { deriveRiskBand } from './deriveRiskBand';
import { scoreAccount } from './scoreAccount';

const factors: Protopie.ChurnScoreFactor[] =
    Protopie.DEFAULT_CHURN_SCORE_FACTORS.map((factor, index) => ({
        ...factor,
        factorUuid: `factor-${index}`,
        configUuid: 'config-uuid',
    }));

describe('scoreAccount', () => {
    test('returns zero when there are no users or events', () => {
        const result = scoreAccount({
            factors,
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'team-1',
                namespace: 'enterprise',
                cloud_url: 'https://enterprise.protopie.cloud',
                total_users: 0,
                active_days: 0,
            },
        });

        expect(result.totalPoints).toEqual(0);
        expect(result.maxPoints).toEqual(90);
        expect(result.normalizedScore).toEqual(0);
        expect(result.riskBand).toEqual('high');
    });

    test('normalizes to 100 when every active factor meets its goal', () => {
        const result = scoreAccount({
            factors,
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'team-1',
                namespace: 'enterprise',
                cloud_url: 'https://enterprise.protopie.cloud',
                total_users: 10,
                active_days: 10,
                pct_users_with_starting_action_users: 5,
                starting_actions_per_user_event_count: 200,
                pct_activated_logged_in_users_users: 5,
                pie_creation_save_actions_per_user_event_count: 200,
                pct_users_with_pie_creation_save_action_users: 5,
                pct_users_with_ai_feature_usage_users: 5,
                pct_users_with_trigger_or_response_action_users: 5,
                trigger_response_actions_per_user_event_count: 200,
            },
        });

        expect(result.totalPoints).toEqual(90);
        expect(result.maxPoints).toEqual(90);
        expect(result.scorePercent).toEqual(1);
        expect(result.normalizedScore).toEqual(100);
        expect(result.riskBand).toEqual('low');
    });

    test('applies linear partial credit and clamps over-goal factors', () => {
        const result = scoreAccount({
            factors: [factors[1], factors[8]],
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

        expect(result.factorScores.starting_actions_per_user.points).toEqual(3);
        expect(result.factorScores.active_days.points).toEqual(10);
        expect(result.totalPoints).toEqual(13);
        expect(result.maxPoints).toEqual(15);
        expect(result.normalizedScore).toEqual(86.67);
    });

    test('does not divide by zero when a factor has a zero goal', () => {
        const result = scoreAccount({
            factors: [
                {
                    ...factors[8],
                    goalValue: 0,
                },
            ],
            thresholds: Protopie.DEFAULT_CHURN_SCORE_RISK_BAND_THRESHOLDS,
            row: {
                account_key: 'team-1',
                namespace: null,
                cloud_url: null,
                total_users: 10,
                active_days: 0,
            },
        });

        expect(result.totalPoints).toEqual(0);
        expect(result.normalizedScore).toEqual(0);
    });
});

describe('deriveRiskBand', () => {
    test('honors custom thresholds', () => {
        expect(
            deriveRiskBand({
                scorePercent: 0.7,
                thresholds: { low: 0.8, medium: 0.6 },
            }),
        ).toEqual('medium');
    });
});

describe('buildAggregationQuery', () => {
    test('uses validated schema interpolation and one placeholder per event', () => {
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
        expect(sql).toContain(
            'FROM warehouse_staging.dim_product_all_events e',
        );
        expect(sql).toContain(
            'ea.event_name IN ($1, $2, $3, $4) THEN ea.user_id',
        );
        expect(sql).toContain('ea.event_name IN ($25, $26) THEN 1 ELSE 0 END');
        expect(sql).toContain(
            "COUNT(DISTINCT DATE_TRUNC('day', ea.event_time)) AS active_days",
        );
        expect(sql).toContain('SELECT DISTINCT');
        expect(sql).toContain(
            'EXISTS (\n                  SELECT 1\n                  FROM warehouse_staging.dim_enterprise_summary es',
        );
        expect(sql).toContain('GROUP BY t.team_id');
        expect(sql).toContain('e.event_time >= CURRENT_DATE - 90');
        expect(sql).not.toContain('IN (:');
        expect(sql).not.toContain('DATEADD');
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
                            events: ['safe', 'bad/event'],
                        },
                    },
                ],
            }),
        ).toThrow('Invalid churn score event name');
    });
});
