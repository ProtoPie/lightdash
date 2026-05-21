import { type Protopie } from '@lightdash/common';
import { deriveRiskBand } from './deriveRiskBand';

export type ChurnScoreAccountAggregationRow = Record<string, unknown> & {
    account_key: string;
    namespace: string | null;
    cloud_url: string | null;
    total_users: number | string | null;
    active_days: number | string | null;
};

export type ScoreAccountResult = {
    accountKey: string;
    namespace: string | null;
    cloudUrl: string | null;
    totalPoints: number;
    maxPoints: number;
    scorePercent: number;
    normalizedScore: number;
    riskBand: Protopie.ChurnScoreRiskBand;
    factorScores: Protopie.ChurnScoreFactorScores;
};

const MIN_GOAL_VALUE = 1e-9;

const round = (value: number, decimals: number): number => {
    const multiplier = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const numberValue = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

const actualForFactor = ({
    factor,
    row,
    totalUsers,
}: {
    factor: Protopie.ChurnScoreFactor;
    row: ChurnScoreAccountAggregationRow;
    totalUsers: number;
}): number => {
    switch (factor.aggregation) {
        case 'pct_users_with_event':
            return totalUsers > 0
                ? numberValue(row[`${factor.factorKey}_users`]) / totalUsers
                : 0;
        case 'event_count':
            return numberValue(row[`${factor.factorKey}_event_count`]);
        case 'event_count_per_user':
            return totalUsers > 0
                ? numberValue(row[`${factor.factorKey}_event_count`]) /
                      totalUsers
                : 0;
        case 'active_days':
            return numberValue(row.active_days);
        default:
            return 0;
    }
};

export const scoreAccount = ({
    factors,
    row,
    thresholds,
}: {
    factors: Protopie.ChurnScoreFactor[];
    row: ChurnScoreAccountAggregationRow;
    thresholds: Protopie.ChurnScoreRiskBandThresholds;
}): ScoreAccountResult => {
    const totalUsers = numberValue(row.total_users);
    const factorScores: Protopie.ChurnScoreFactorScores = {};

    let totalPoints = 0;
    let maxPoints = 0;

    factors.forEach((factor) => {
        const actual = actualForFactor({ factor, row, totalUsers });
        const max = numberValue(factor.maxPoints);
        const goal = Math.max(numberValue(factor.goalValue), MIN_GOAL_VALUE);
        const points = Math.min(actual / goal, 1) * max;

        factorScores[factor.factorKey] = {
            raw: round(actual, 4),
            goal: numberValue(factor.goalValue),
            points: round(points, 2),
        };

        totalPoints += points;
        maxPoints += max;
    });

    const scorePercent = maxPoints > 0 ? totalPoints / maxPoints : 0;

    return {
        accountKey: row.account_key,
        namespace: row.namespace,
        cloudUrl: row.cloud_url,
        totalPoints: round(totalPoints, 2),
        maxPoints: round(maxPoints, 2),
        scorePercent: round(scorePercent, 4),
        normalizedScore: round(scorePercent * 100, 2),
        riskBand: deriveRiskBand({ scorePercent, thresholds }),
        factorScores,
    };
};
