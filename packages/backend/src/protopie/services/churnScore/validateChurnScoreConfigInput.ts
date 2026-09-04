import { ParameterError, Protopie } from '@lightdash/common';
import { validateChurnScoreFactorInput } from './buildAggregationQuery';

const isFiniteNumber = (value: number): boolean =>
    typeof value === 'number' && Number.isFinite(value);

const POINT_TOTAL = 100;
const POINT_TOTAL_TOLERANCE = 0.000001;

export const validateChurnScoreConfigInput = (
    payload: Protopie.ChurnScoreConfigInput,
): Protopie.ChurnScoreConfigInput => {
    if (!Number.isInteger(payload.lookbackDays) || payload.lookbackDays <= 0) {
        throw new ParameterError('lookbackDays must be a positive integer.');
    }

    if (
        payload.scoreFunction !== 'linear' &&
        payload.scoreFunction !== 'stepwise'
    ) {
        throw new ParameterError(
            'Churn score function must be "linear" or "stepwise".',
        );
    }

    if (
        payload.visibility !== undefined &&
        payload.visibility !== 'public' &&
        payload.visibility !== 'private'
    ) {
        throw new ParameterError(
            'Churn score visibility must be "public" or "private".',
        );
    }

    if (
        !isFiniteNumber(payload.riskBandThresholds.low) ||
        !isFiniteNumber(payload.riskBandThresholds.medium) ||
        payload.riskBandThresholds.low <= payload.riskBandThresholds.medium
    ) {
        throw new ParameterError(
            'Risk thresholds must be finite numbers with low > medium.',
        );
    }

    if (!payload.factors.length) {
        throw new ParameterError(
            'At least one churn score factor is required.',
        );
    }

    const seen = new Set<string>();
    const normalizedFactors = payload.factors
        .map((factor) => ({
            ...factor,
            label: factor.label.trim(),
            eventGroup: {
                operator: 'or' as const,
                events: factor.eventGroup.events.map((eventName) =>
                    eventName.trim(),
                ),
            },
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);

    normalizedFactors.forEach((factor) => {
        if (seen.has(factor.factorKey)) {
            throw new ParameterError(
                `Duplicate churn score factor key: ${factor.factorKey}`,
            );
        }
        seen.add(factor.factorKey);

        if (!factor.label.trim()) {
            throw new ParameterError(
                `Churn score factor label is required: ${factor.factorKey}`,
            );
        }
        if (!isFiniteNumber(factor.maxPoints) || factor.maxPoints < 0) {
            throw new ParameterError(
                `maxPoints must be a non-negative number: ${factor.factorKey}`,
            );
        }
        if (!isFiniteNumber(factor.goalValue) || factor.goalValue < 0) {
            throw new ParameterError(
                `goalValue must be a non-negative number: ${factor.factorKey}`,
            );
        }

        if (
            factor.windowDays !== null &&
            (!Number.isInteger(factor.windowDays) || factor.windowDays <= 0)
        ) {
            throw new ParameterError(
                `windowDays must be a positive integer or null: ${factor.factorKey}`,
            );
        }

        if (payload.scoreFunction === 'stepwise') {
            const thresholds = factor.stepThresholds;
            if (!thresholds || thresholds.ranges.length === 0) {
                throw new ParameterError(
                    `A stepwise factor requires stepThresholds.ranges: ${factor.factorKey}`,
                );
            }
            thresholds.ranges.forEach((range) => {
                if (!isFiniteNumber(range.bottom) || range.bottom < 0) {
                    throw new ParameterError(
                        `stepThresholds bottom must be a non-negative number: ${factor.factorKey}`,
                    );
                }
                if (
                    range.top !== null &&
                    (!isFiniteNumber(range.top) || range.top < range.bottom)
                ) {
                    throw new ParameterError(
                        `stepThresholds top must be null or >= bottom: ${factor.factorKey}`,
                    );
                }
                if (
                    !isFiniteNumber(range.points) ||
                    range.points < 0 ||
                    range.points > factor.maxPoints
                ) {
                    throw new ParameterError(
                        `stepThresholds points must be between 0 and maxPoints: ${factor.factorKey}`,
                    );
                }
            });
        }

        validateChurnScoreFactorInput(factor);
    });

    const maxPointsTotal = normalizedFactors.reduce(
        (total, factor) => total + factor.maxPoints,
        0,
    );
    if (Math.abs(maxPointsTotal - POINT_TOTAL) > POINT_TOTAL_TOLERANCE) {
        throw new ParameterError(
            `Churn score factor weights must total ${POINT_TOTAL}. Current total is ${maxPointsTotal}.`,
        );
    }

    return {
        ...payload,
        name: payload.name?.trim() || Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        factors: normalizedFactors,
    };
};
