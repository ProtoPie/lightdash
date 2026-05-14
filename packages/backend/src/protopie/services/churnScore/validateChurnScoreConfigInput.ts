import { ParameterError, Protopie } from '@lightdash/common';
import { validateChurnScoreFactorInput } from './buildAggregationQuery';

const isFiniteNumber = (value: number): boolean =>
    typeof value === 'number' && Number.isFinite(value);

export const validateChurnScoreConfigInput = (
    payload: Protopie.ChurnScoreConfigInput,
): Protopie.ChurnScoreConfigInput => {
    if (!Number.isInteger(payload.lookbackDays) || payload.lookbackDays <= 0) {
        throw new ParameterError('lookbackDays must be a positive integer.');
    }

    if (payload.scoreFunction !== 'linear') {
        throw new ParameterError(
            'Only linear churn score configs are supported.',
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

        validateChurnScoreFactorInput(factor);
    });

    return {
        ...payload,
        name: payload.name?.trim() || Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
        factors: normalizedFactors,
    };
};
