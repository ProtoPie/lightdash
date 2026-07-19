import { Protopie } from '@lightdash/common';

// Sentinel for the "(none)" bucket — selecting it filters to accounts whose SF
// attribute is null. Backend translates it to `IS NULL`.
export const NONE_VALUE = Protopie.CHURN_SCORE_FILTER_NONE_VALUE;

export const facetValueLabel = (value: string): string =>
    value === NONE_VALUE ? '(none)' : value;

/**
 * Builds Mantine MultiSelect `data` from a facet response: `value (count)`
 * labels, a prepended `(none)` option when null rows exist, and any currently
 * selected value that the latest options no longer include — so a selection can
 * always be removed even when other filters drop its count to zero.
 */
export const buildFacetData = (
    facet: Protopie.ChurnScoreFacet | undefined,
    selected: string[],
): { value: string; label: string }[] => {
    const data: { value: string; label: string }[] = [];
    const seen = new Set<string>();
    const noneCount = facet?.noneCount ?? 0;
    if (noneCount > 0 || selected.includes(NONE_VALUE)) {
        data.push({
            value: NONE_VALUE,
            label: noneCount > 0 ? `(none) (${noneCount})` : '(none)',
        });
        seen.add(NONE_VALUE);
    }
    (facet?.options ?? []).forEach(({ value, count }) => {
        data.push({ value, label: `${value} (${count})` });
        seen.add(value);
    });
    selected.forEach((value) => {
        if (!seen.has(value)) {
            data.push({ value, label: facetValueLabel(value) });
            seen.add(value);
        }
    });
    return data;
};
