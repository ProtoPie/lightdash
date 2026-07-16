import { Protopie } from '@lightdash/common';
import {
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    Group,
    Loader,
    MultiSelect,
    Pill,
    Select,
    Stack,
    Table,
    Text,
    TextInput,
    Title,
} from '@mantine-8/core';
import { useDebouncedValue } from '@mantine-8/hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useProjectUuid } from '../hooks/useProjectUuid';
import {
    useProtopieChurnConfigs,
    useProtopieChurnScoreFilterOptions,
    useProtopieChurnScores,
} from './api';
import ProtopieChurnScoreMethodCards from './ProtopieChurnScoreMethodCards';
import classes from './ProtopieFormsPage.module.css';
import ProtopieSectionTabs from './ProtopieSectionTabs';

const riskBandColor: Record<Protopie.ChurnScoreRiskBand, string> = {
    low: 'green',
    medium: 'yellow',
    high: 'red',
};

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = ['25', '50', '100', '200'];
const DEFAULT_SORT_VALUE = 'health_asc';
const SORT_OPTIONS = [
    // Default (health_asc = most at-risk first) is listed first so the dropdown
    // order matches DEFAULT_SORT_VALUE.
    { value: 'health_asc', label: 'Health points: low to high' },
    { value: 'health_desc', label: 'Health points: high to low' },
    { value: 'risk_desc', label: 'Risk: high to low' },
    { value: 'risk_asc', label: 'Risk: low to high' },
    { value: 'namespace_asc', label: 'Namespace: A to Z' },
    { value: 'namespace_desc', label: 'Namespace: Z to A' },
    { value: 'computed_at_desc', label: 'Computed: newest first' },
    { value: 'computed_at_asc', label: 'Computed: oldest first' },
];
// Health = 100 − churn and maxPoints is constant per config, so ordering by the
// backend's churn_score key (sortBy: 'score') is exactly the health ordering, inverted.
// We reuse that key with a flipped direction rather than adding a backend sort key.
const SORT_FILTERS: Record<
    string,
    Pick<Protopie.ChurnScoreLatestFilters, 'sortBy' | 'sortDirection'>
> = {
    health_desc: { sortBy: 'score', sortDirection: 'asc' },
    health_asc: { sortBy: 'score', sortDirection: 'desc' },
    risk_desc: { sortBy: 'risk', sortDirection: 'desc' },
    risk_asc: { sortBy: 'risk', sortDirection: 'asc' },
    namespace_asc: { sortBy: 'namespace', sortDirection: 'asc' },
    namespace_desc: { sortBy: 'namespace', sortDirection: 'desc' },
    computed_at_desc: { sortBy: 'computed_at', sortDirection: 'desc' },
    computed_at_asc: { sortBy: 'computed_at', sortDirection: 'asc' },
};

// Sentinel for the "(none)" bucket — selecting it filters to accounts whose SF
// attribute is null. Backend translates it to `IS NULL`.
const NONE_VALUE = Protopie.CHURN_SCORE_FILTER_NONE_VALUE;

const parseRiskBand = (
    value: string | null,
): Protopie.ChurnScoreRiskBand | null =>
    value === 'high' || value === 'medium' || value === 'low' ? value : null;

const facetValueLabel = (value: string): string =>
    value === NONE_VALUE ? '(none)' : value;

/**
 * Builds Mantine MultiSelect `data` from a facet response: `value (count)`
 * labels, a prepended `(none)` option when null rows exist, and any currently
 * selected value that the latest options no longer include — so a selection can
 * always be removed even when other filters drop its count to zero.
 */
const buildFacetData = (
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

const ProtopieChurnScoresPage = () => {
    const projectUuid = useProjectUuid();
    const [searchParams, setSearchParams] = useSearchParams();

    // Filter state, initialized once from the URL so links are shareable and
    // survive a refresh. The URL is kept in sync by the effect below.
    const [selectedConfigUuid, setSelectedConfigUuid] = useState<
        string | undefined
    >(() => searchParams.get('configUuid') ?? undefined);
    const [riskBand, setRiskBand] =
        useState<Protopie.ChurnScoreRiskBand | null>(() =>
            parseRiskBand(searchParams.get('riskBand')),
        );
    const [search, setSearch] = useState(
        () => searchParams.get('search') ?? '',
    );
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [accountOwner, setAccountOwner] = useState<string[]>(() =>
        searchParams.getAll('accountOwner'),
    );
    const [sfPlanCategory, setSfPlanCategory] = useState<string[]>(() =>
        searchParams.getAll('sfPlanCategory'),
    );
    const [sfAccountRegion, setSfAccountRegion] = useState<string[]>(() =>
        searchParams.getAll('sfAccountRegion'),
    );
    const [sfAccountCountry, setSfAccountCountry] = useState<string[]>(() =>
        searchParams.getAll('sfAccountCountry'),
    );
    const [sortValue, setSortValue] = useState(() => {
        const raw = searchParams.get('sort');
        return raw && SORT_FILTERS[raw] ? raw : DEFAULT_SORT_VALUE;
    });
    const [pageSize, setPageSize] = useState(() => {
        const raw = searchParams.get('rows');
        return raw && PAGE_SIZE_OPTIONS.includes(raw)
            ? raw
            : String(DEFAULT_PAGE_SIZE);
    });
    const [page, setPage] = useState(() => {
        const raw = Number(searchParams.get('page'));
        return Number.isInteger(raw) && raw >= 1 ? raw : 1;
    });

    const numericPageSize = Number(pageSize);
    const sortFilter = SORT_FILTERS[sortValue] ?? SORT_FILTERS.health_asc;

    const configs = useProtopieChurnConfigs(projectUuid);

    // The filter set that both narrows the scores list and drives the faceted
    // option counts (each facet ignores its own selection server-side).
    const activeFilters = useMemo<Protopie.ChurnScoreLatestFilters>(
        () => ({
            configUuid: selectedConfigUuid,
            riskBand: riskBand ?? undefined,
            search: debouncedSearch.trim() || undefined,
            accountOwner: accountOwner.length ? accountOwner : undefined,
            sfPlanCategory: sfPlanCategory.length ? sfPlanCategory : undefined,
            sfAccountRegion: sfAccountRegion.length
                ? sfAccountRegion
                : undefined,
            sfAccountCountry: sfAccountCountry.length
                ? sfAccountCountry
                : undefined,
        }),
        [
            selectedConfigUuid,
            riskBand,
            debouncedSearch,
            accountOwner,
            sfPlanCategory,
            sfAccountRegion,
            sfAccountCountry,
        ],
    );

    const filterOptions = useProtopieChurnScoreFilterOptions(
        projectUuid,
        activeFilters,
    );

    const filters = useMemo<Protopie.ChurnScoreLatestFilters>(
        () => ({
            ...activeFilters,
            sortBy: sortFilter.sortBy,
            sortDirection: sortFilter.sortDirection,
            limit: numericPageSize,
            offset: (page - 1) * numericPageSize,
        }),
        [
            activeFilters,
            sortFilter.sortBy,
            sortFilter.sortDirection,
            numericPageSize,
            page,
        ],
    );
    const scores = useProtopieChurnScores({ projectUuid, filters });

    // Default to the first rubric only when none was restored from the URL.
    useEffect(() => {
        if (selectedConfigUuid || !configs.data?.length) return;
        setSelectedConfigUuid(configs.data[0].configUuid);
    }, [configs.data, selectedConfigUuid]);

    // Reset to the first page whenever a filter changes — but not on the
    // initial mount, so a shared URL's page survives the first load.
    const isFirstRender = useRef(true);
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        setPage(1);
    }, [
        debouncedSearch,
        numericPageSize,
        riskBand,
        selectedConfigUuid,
        sortValue,
        accountOwner,
        sfPlanCategory,
        sfAccountRegion,
        sfAccountCountry,
    ]);

    // Keep the URL in sync with the current filter state (external system).
    useEffect(() => {
        const next = new URLSearchParams();
        if (selectedConfigUuid) next.set('configUuid', selectedConfigUuid);
        if (riskBand) next.set('riskBand', riskBand);
        if (debouncedSearch.trim()) next.set('search', debouncedSearch.trim());
        accountOwner.forEach((value) => next.append('accountOwner', value));
        sfPlanCategory.forEach((value) => next.append('sfPlanCategory', value));
        sfAccountRegion.forEach((value) =>
            next.append('sfAccountRegion', value),
        );
        sfAccountCountry.forEach((value) =>
            next.append('sfAccountCountry', value),
        );
        if (sortValue !== DEFAULT_SORT_VALUE) next.set('sort', sortValue);
        if (pageSize !== String(DEFAULT_PAGE_SIZE)) next.set('rows', pageSize);
        if (page > 1) next.set('page', String(page));
        setSearchParams(next, { replace: true });
    }, [
        selectedConfigUuid,
        riskBand,
        debouncedSearch,
        accountOwner,
        sfPlanCategory,
        sfAccountRegion,
        sfAccountCountry,
        sortValue,
        pageSize,
        page,
        setSearchParams,
    ]);

    const configOptions = useMemo(
        () =>
            (configs.data ?? []).map((config) => ({
                value: config.configUuid,
                label: `${config.name} (v${config.version})`,
            })),
        [configs.data],
    );

    const accountOwnerData = useMemo(
        () => buildFacetData(filterOptions.data?.accountOwner, accountOwner),
        [filterOptions.data, accountOwner],
    );
    const sfPlanCategoryData = useMemo(
        () =>
            buildFacetData(filterOptions.data?.sfPlanCategory, sfPlanCategory),
        [filterOptions.data, sfPlanCategory],
    );
    const sfAccountRegionData = useMemo(
        () =>
            buildFacetData(
                filterOptions.data?.sfAccountRegion,
                sfAccountRegion,
            ),
        [filterOptions.data, sfAccountRegion],
    );
    const sfAccountCountryData = useMemo(
        () =>
            buildFacetData(
                filterOptions.data?.sfAccountCountry,
                sfAccountCountry,
            ),
        [filterOptions.data, sfAccountCountry],
    );

    const clearFacets = () => {
        setAccountOwner([]);
        setSfPlanCategory([]);
        setSfAccountRegion([]);
        setSfAccountCountry([]);
    };

    const clearAllFilters = () => {
        setRiskBand(null);
        setSearch('');
        clearFacets();
    };

    // Removable chips summarizing every active filter.
    const activeChips: { key: string; label: string; onRemove: () => void }[] =
        [];
    if (riskBand) {
        activeChips.push({
            key: 'risk',
            label: `Risk: ${riskBand}`,
            onRemove: () => setRiskBand(null),
        });
    }
    if (search.trim()) {
        activeChips.push({
            key: 'search',
            label: `Search: "${search.trim()}"`,
            onRemove: () => setSearch(''),
        });
    }
    (
        [
            { name: 'Owner', values: accountOwner, setter: setAccountOwner },
            { name: 'Plan', values: sfPlanCategory, setter: setSfPlanCategory },
            {
                name: 'Region',
                values: sfAccountRegion,
                setter: setSfAccountRegion,
            },
            {
                name: 'Country',
                values: sfAccountCountry,
                setter: setSfAccountCountry,
            },
        ] as const
    ).forEach(({ name, values, setter }) => {
        values.forEach((value) => {
            activeChips.push({
                key: `${name}:${value}`,
                label: `${name}: ${facetValueLabel(value)}`,
                onRemove: () => setter(values.filter((item) => item !== value)),
            });
        });
    });

    const rows = scores.data ?? [];
    const hasPreviousPage = page > 1;
    const hasNextPage = rows.length === numericPageSize;

    if (scores.isLoading && !scores.data) {
        return (
            <Group className={classes.page}>
                <Loader size="sm" />
                <Text c="dimmed">Loading churn scores</Text>
            </Group>
        );
    }

    if (scores.error) {
        return (
            <Alert color="red" title="Churn scores could not load">
                {scores.error.error.message}
            </Alert>
        );
    }

    return (
        <Stack className={classes.page} gap="lg">
            <Stack className={classes.section} gap="xs">
                <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                        <Title order={3}>Churn score</Title>
                        <Text c="dimmed" size="sm">
                            Latest enterprise-team scores for the active Notion
                            rubric.
                        </Text>
                    </Stack>
                    <Badge variant="light">{rows.length}</Badge>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            <ProtopieChurnScoreMethodCards />

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group grow>
                        <Select
                            label="Rubric"
                            allowDeselect={false}
                            data={configOptions}
                            value={selectedConfigUuid}
                            onChange={(value) => {
                                setSelectedConfigUuid(value ?? undefined);
                                // Filter options are per-config; a value picked
                                // under one rubric may not exist in the next, so
                                // clear the SF filters on rubric change to avoid
                                // an empty result set + stale MultiSelect values.
                                clearFacets();
                            }}
                        />
                        <Select
                            label="Risk band"
                            allowDeselect={false}
                            data={[
                                { value: 'all', label: 'All' },
                                { value: 'high', label: 'High' },
                                { value: 'medium', label: 'Medium' },
                                { value: 'low', label: 'Low' },
                            ]}
                            value={riskBand ?? 'all'}
                            onChange={(value) =>
                                setRiskBand(
                                    value === 'all'
                                        ? null
                                        : parseRiskBand(value),
                                )
                            }
                        />
                        <TextInput
                            label="Search"
                            placeholder="Account, namespace, URL, owner…"
                            value={search}
                            onChange={(event) =>
                                setSearch(event.currentTarget.value)
                            }
                        />
                        <Select
                            label="Sort"
                            allowDeselect={false}
                            data={SORT_OPTIONS}
                            value={sortValue}
                            onChange={(value) =>
                                setSortValue(value ?? DEFAULT_SORT_VALUE)
                            }
                        />
                        <Select
                            label="Rows"
                            allowDeselect={false}
                            data={PAGE_SIZE_OPTIONS}
                            value={pageSize}
                            onChange={(value) =>
                                setPageSize(value ?? String(DEFAULT_PAGE_SIZE))
                            }
                        />
                    </Group>

                    <Group grow>
                        <MultiSelect
                            label="Account owner"
                            placeholder={
                                accountOwner.length ? undefined : 'All'
                            }
                            searchable
                            clearable
                            data={accountOwnerData}
                            value={accountOwner}
                            onChange={setAccountOwner}
                        />
                        <MultiSelect
                            label="Plan category"
                            placeholder={
                                sfPlanCategory.length ? undefined : 'All'
                            }
                            searchable
                            clearable
                            data={sfPlanCategoryData}
                            value={sfPlanCategory}
                            onChange={setSfPlanCategory}
                        />
                        <MultiSelect
                            label="Region"
                            placeholder={
                                sfAccountRegion.length ? undefined : 'All'
                            }
                            searchable
                            clearable
                            data={sfAccountRegionData}
                            value={sfAccountRegion}
                            onChange={setSfAccountRegion}
                        />
                        <MultiSelect
                            label="Country"
                            placeholder={
                                sfAccountCountry.length ? undefined : 'All'
                            }
                            searchable
                            clearable
                            data={sfAccountCountryData}
                            value={sfAccountCountry}
                            onChange={setSfAccountCountry}
                        />
                    </Group>

                    {activeChips.length > 0 && (
                        <Group gap="xs" align="center">
                            <Text size="xs" c="dimmed">
                                Active filters
                            </Text>
                            {activeChips.map((chip) => (
                                <Pill
                                    key={chip.key}
                                    withRemoveButton
                                    onRemove={chip.onRemove}
                                >
                                    {chip.label}
                                </Pill>
                            ))}
                            <Button
                                variant="subtle"
                                size="compact-xs"
                                onClick={clearAllFilters}
                            >
                                Clear all
                            </Button>
                        </Group>
                    )}

                    <Table.ScrollContainer minWidth={820}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Account</Table.Th>
                                    <Table.Th>Risk</Table.Th>
                                    <Table.Th>Health points</Table.Th>
                                    <Table.Th>Computed</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {rows.map((score) => {
                                    const detailTo = `/projects/${projectUuid}/protopie/churn/scores/${encodeURIComponent(
                                        score.accountKey,
                                    )}?configUuid=${score.configUuid}`;
                                    return (
                                        <Table.Tr key={score.scoreUuid}>
                                            <Table.Td>
                                                <Anchor
                                                    component={Link}
                                                    to={detailTo}
                                                    size="sm"
                                                    fw={600}
                                                >
                                                    {score.sfAccountName ??
                                                        score.namespace ??
                                                        score.accountKey}
                                                </Anchor>
                                                {score.cloudUrl && (
                                                    <Text size="xs" c="dimmed">
                                                        {score.cloudUrl}
                                                    </Text>
                                                )}
                                            </Table.Td>
                                            <Table.Td>
                                                <Badge
                                                    color={
                                                        riskBandColor[
                                                            score.riskBand
                                                        ]
                                                    }
                                                    variant="light"
                                                >
                                                    {score.riskBand}
                                                </Badge>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="sm">
                                                    {score.totalPoints.toFixed(
                                                        2,
                                                    )}{' '}
                                                    /{' '}
                                                    {score.maxPoints.toFixed(2)}
                                                </Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="sm">
                                                    {new Date(
                                                        score.computedAt,
                                                    ).toLocaleString()}
                                                </Text>
                                            </Table.Td>
                                        </Table.Tr>
                                    );
                                })}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>

                    <Group justify="space-between">
                        <Text size="sm" c="dimmed">
                            Page {page} · Showing {rows.length} scores
                            {scores.isFetching ? ' · Refreshing' : ''}
                        </Text>
                        <Group gap="xs">
                            <Button
                                variant="default"
                                size="xs"
                                disabled={!hasPreviousPage || scores.isFetching}
                                onClick={() =>
                                    setPage((currentPage) =>
                                        Math.max(currentPage - 1, 1),
                                    )
                                }
                            >
                                Previous
                            </Button>
                            <Button
                                variant="default"
                                size="xs"
                                disabled={!hasNextPage || scores.isFetching}
                                onClick={() =>
                                    setPage((currentPage) => currentPage + 1)
                                }
                            >
                                Next
                            </Button>
                        </Group>
                    </Group>
                </Stack>
            </Card>
        </Stack>
    );
};

export default ProtopieChurnScoresPage;
