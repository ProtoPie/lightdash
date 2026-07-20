import { type Protopie } from '@lightdash/common';
import { deriveRiskBand } from './deriveRiskBand';

export type ChurnScoreAccountAggregationRow = Record<string, unknown> & {
    account_key: string;
    namespace: string | null;
    cloud_url: string | null;
    total_users: number | string | null;
    active_days: number | string | null;
    // SF passthrough (from protopie_account_user_counts); not used in scoring.
    sf_account_name?: string | null;
    account_owner?: string | null;
    sf_plan_category?: string | null;
    sf_account_region?: string | null;
    sf_account_country?: string | null;
};

export type ScoreAccountResult = {
    accountKey: string;
    namespace: string | null;
    cloudUrl: string | null;
    sfAccountName: string | null;
    accountOwner: string | null;
    sfPlanCategory: string | null;
    sfAccountRegion: string | null;
    sfAccountCountry: string | null;
    totalPoints: number;
    maxPoints: number;
    scorePercent: number;
    normalizedScore: number;
    churnScore: number;
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

/**
 * ChurnZero step-bucket evaluation. `raw` is compared to each range's inclusive
 * `bottom` with TRUNCATE semantics (no round-up): award the points of the range
 * with the greatest `bottom <= raw`. A raw value below every nonzero bottom
 * (e.g. 0.88 against bottoms 21/11/1) falls to the 0 bucket → 0 points.
 */
const evaluateStepBucket = (
    thresholds: Protopie.ChurnScoreStepThresholds,
    raw: number,
): number => {
    const match = thresholds.ranges
        .filter((range) => raw >= range.bottom)
        .reduce<Protopie.ChurnScoreStepRange | null>(
            (best, range) =>
                best === null || range.bottom > best.bottom ? range : best,
            null,
        );
    return match ? numberValue(match.points) : 0;
};

/**
 * The raw value the step bucket compares against. Percentage factors use
 * percent units (×100) so config buckets read as ChurnZero does (1/26/51);
 * count/per-user/days factors use their natural value.
 */
const rawForBucket = (
    factor: Protopie.ChurnScoreFactor,
    actual: number,
): number =>
    factor.aggregation === 'pct_users_with_event' ? actual * 100 : actual;

const pointsForFactor = ({
    factor,
    actual,
    scoreFunction,
}: {
    factor: Protopie.ChurnScoreFactor;
    actual: number;
    scoreFunction: Protopie.ChurnScoreFunction;
}): number => {
    const max = numberValue(factor.maxPoints);

    if (scoreFunction === 'stepwise' && factor.stepThresholds) {
        return evaluateStepBucket(
            factor.stepThresholds,
            rawForBucket(factor, actual),
        );
    }

    // Linear fallback (legacy configs, or stepwise factors with no buckets).
    const goal = Math.max(numberValue(factor.goalValue), MIN_GOAL_VALUE);
    return Math.min(actual / goal, 1) * max;
};

export const scoreAccount = ({
    factors,
    row,
    thresholds,
    scoreFunction,
}: {
    factors: Protopie.ChurnScoreFactor[];
    row: ChurnScoreAccountAggregationRow;
    thresholds: Protopie.ChurnScoreRiskBandThresholds;
    scoreFunction: Protopie.ChurnScoreFunction;
}): ScoreAccountResult => {
    const totalUsers = numberValue(row.total_users);
    const factorScores: Protopie.ChurnScoreFactorScores = {};

    let totalPoints = 0;
    let maxPoints = 0;

    factors.forEach((factor) => {
        const actual = actualForFactor({ factor, row, totalUsers });
        const max = numberValue(factor.maxPoints);
        const points = pointsForFactor({ factor, actual, scoreFunction });

        factorScores[factor.factorKey] = {
            raw: round(actual, 4),
            goal: numberValue(factor.goalValue),
            points: round(points, 2),
        };

        totalPoints += points;
        maxPoints += max;
    });

    const scorePercent = maxPoints > 0 ? totalPoints / maxPoints : 0;
    const normalizedScore = round(scorePercent * 100, 2);

    return {
        accountKey: row.account_key,
        namespace: row.namespace,
        cloudUrl: row.cloud_url,
        sfAccountName: row.sf_account_name ?? null,
        accountOwner: row.account_owner ?? null,
        sfPlanCategory: row.sf_plan_category ?? null,
        sfAccountRegion: row.sf_account_region ?? null,
        sfAccountCountry: row.sf_account_country ?? null,
        totalPoints: round(totalPoints, 2),
        maxPoints: round(maxPoints, 2),
        scorePercent: round(scorePercent, 4),
        normalizedScore,
        churnScore: round(100 - normalizedScore, 2),
        riskBand: deriveRiskBand({ scorePercent, thresholds }),
        factorScores,
    };
};
