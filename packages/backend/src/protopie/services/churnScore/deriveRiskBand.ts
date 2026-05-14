import { type Protopie } from '@lightdash/common';

export const deriveRiskBand = ({
    scorePercent,
    thresholds,
}: {
    scorePercent: number;
    thresholds: Protopie.ChurnScoreRiskBandThresholds;
}): Protopie.ChurnScoreRiskBand => {
    if (scorePercent >= thresholds.low) {
        return 'low';
    }

    if (scorePercent >= thresholds.medium) {
        return 'medium';
    }

    return 'high';
};
