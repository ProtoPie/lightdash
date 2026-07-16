import { type Protopie } from '@lightdash/common';
import { describe, expect, it } from 'vitest';
import { buildFacetData, NONE_VALUE } from './churnFacetData';

const facet = (
    options: Protopie.ChurnScoreFacetOption[],
    noneCount = 0,
): Protopie.ChurnScoreFacet => ({ options, noneCount });

describe('buildFacetData', () => {
    it('renders value (count) labels in facet order', () => {
        expect(
            buildFacetData(
                facet([
                    { value: 'APAC', count: 12 },
                    { value: 'EMEA', count: 8 },
                ]),
                [],
            ),
        ).toEqual([
            { value: 'APAC', label: 'APAC (12)' },
            { value: 'EMEA', label: 'EMEA (8)' },
        ]);
    });

    it('prepends a (none) option with its count when null rows exist', () => {
        const data = buildFacetData(
            facet([{ value: 'APAC', count: 3 }], 5),
            [],
        );
        expect(data[0]).toEqual({ value: NONE_VALUE, label: '(none) (5)' });
    });

    it('shows (none) without a count when selected but noneCount is 0', () => {
        const data = buildFacetData(facet([], 0), [NONE_VALUE]);
        expect(data).toEqual([{ value: NONE_VALUE, label: '(none)' }]);
    });

    it('keeps a selected value that dropped out of the latest options', () => {
        // "Japan" is selected but no longer returned (other filters zeroed it);
        // it must stay so the user can still deselect it.
        const data = buildFacetData(facet([{ value: 'Korea', count: 2 }]), [
            'Japan',
        ]);
        expect(data).toEqual([
            { value: 'Korea', label: 'Korea (2)' },
            { value: 'Japan', label: 'Japan' },
        ]);
    });

    it('does not duplicate a selected value already present in options', () => {
        const data = buildFacetData(facet([{ value: 'Korea', count: 2 }]), [
            'Korea',
        ]);
        expect(data).toEqual([{ value: 'Korea', label: 'Korea (2)' }]);
    });

    it('handles an undefined facet (loading/error) as empty', () => {
        expect(buildFacetData(undefined, [])).toEqual([]);
    });
});
