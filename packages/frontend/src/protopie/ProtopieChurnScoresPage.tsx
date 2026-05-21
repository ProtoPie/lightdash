import { type Protopie } from '@lightdash/common';
import {
    Alert,
    Badge,
    Button,
    Card,
    Group,
    Loader,
    Select,
    Stack,
    Table,
    Text,
    TextInput,
    Title,
} from '@mantine-8/core';
import { useDebouncedValue } from '@mantine-8/hooks';
import { useEffect, useMemo, useState } from 'react';
import { useProjectUuid } from '../hooks/useProjectUuid';
import { useProtopieChurnConfigs, useProtopieChurnScores } from './api';
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
const DEFAULT_SORT_VALUE = 'score_asc';
const SORT_OPTIONS = [
    { value: 'score_asc', label: 'Score: low to high' },
    { value: 'score_desc', label: 'Score: high to low' },
    { value: 'risk_desc', label: 'Risk: high to low' },
    { value: 'risk_asc', label: 'Risk: low to high' },
    { value: 'namespace_asc', label: 'Namespace: A to Z' },
    { value: 'namespace_desc', label: 'Namespace: Z to A' },
    { value: 'computed_at_desc', label: 'Computed: newest first' },
    { value: 'computed_at_asc', label: 'Computed: oldest first' },
];
const SORT_FILTERS: Record<
    string,
    Pick<Protopie.ChurnScoreLatestFilters, 'sortBy' | 'sortDirection'>
> = {
    score_asc: { sortBy: 'score', sortDirection: 'asc' },
    score_desc: { sortBy: 'score', sortDirection: 'desc' },
    risk_desc: { sortBy: 'risk', sortDirection: 'desc' },
    risk_asc: { sortBy: 'risk', sortDirection: 'asc' },
    namespace_asc: { sortBy: 'namespace', sortDirection: 'asc' },
    namespace_desc: { sortBy: 'namespace', sortDirection: 'desc' },
    computed_at_desc: { sortBy: 'computed_at', sortDirection: 'desc' },
    computed_at_asc: { sortBy: 'computed_at', sortDirection: 'asc' },
};

const ProtopieChurnScoresPage = () => {
    const projectUuid = useProjectUuid();
    const [riskBand, setRiskBand] =
        useState<Protopie.ChurnScoreRiskBand | null>(null);
    const [namespace, setNamespace] = useState('');
    const [debouncedNamespace] = useDebouncedValue(namespace, 300);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(String(DEFAULT_PAGE_SIZE));
    const [sortValue, setSortValue] = useState(DEFAULT_SORT_VALUE);
    const [selectedConfigUuid, setSelectedConfigUuid] = useState<
        string | undefined
    >();
    const numericPageSize = Number(pageSize);
    const sortFilter = SORT_FILTERS[sortValue] ?? SORT_FILTERS.score_asc;
    const configs = useProtopieChurnConfigs(projectUuid);

    useEffect(() => {
        if (selectedConfigUuid || !configs.data?.length) return;

        setSelectedConfigUuid(configs.data[0].configUuid);
    }, [configs.data, selectedConfigUuid]);

    useEffect(() => {
        setPage(1);
    }, [
        debouncedNamespace,
        numericPageSize,
        riskBand,
        selectedConfigUuid,
        sortValue,
    ]);

    const filters = useMemo<Protopie.ChurnScoreLatestFilters>(
        () => ({
            configUuid: selectedConfigUuid,
            riskBand: riskBand ?? undefined,
            namespace: debouncedNamespace.trim() || undefined,
            sortBy: sortFilter.sortBy,
            sortDirection: sortFilter.sortDirection,
            limit: numericPageSize,
            offset: (page - 1) * numericPageSize,
        }),
        [
            debouncedNamespace,
            numericPageSize,
            page,
            riskBand,
            selectedConfigUuid,
            sortFilter.sortBy,
            sortFilter.sortDirection,
        ],
    );
    const scores = useProtopieChurnScores({ projectUuid, filters });
    const configOptions = useMemo(
        () =>
            (configs.data ?? []).map((config) => ({
                value: config.configUuid,
                label: `${config.name} (v${config.version})`,
            })),
        [configs.data],
    );
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
                        <Title order={3}>Churn score v1</Title>
                        <Text c="dimmed" size="sm">
                            Latest enterprise-team scores for the active Notion
                            rubric.
                        </Text>
                    </Stack>
                    <Badge variant="light">{rows.length}</Badge>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            <ProtopieChurnScoreMethodCards variant="v1" />

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group grow>
                        <Select
                            label="Rubric"
                            allowDeselect={false}
                            data={configOptions}
                            value={selectedConfigUuid}
                            onChange={(value) =>
                                setSelectedConfigUuid(value ?? undefined)
                            }
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
                                        : (value as Protopie.ChurnScoreRiskBand),
                                )
                            }
                        />
                        <TextInput
                            label="Namespace"
                            value={namespace}
                            onChange={(event) =>
                                setNamespace(event.currentTarget.value)
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

                    <Table.ScrollContainer minWidth={900}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Account key</Table.Th>
                                    <Table.Th>Namespace</Table.Th>
                                    <Table.Th>Score</Table.Th>
                                    <Table.Th>Risk</Table.Th>
                                    <Table.Th>Raw points</Table.Th>
                                    <Table.Th>Computed</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {rows.map((score) => (
                                    <Table.Tr key={score.scoreUuid}>
                                        <Table.Td>
                                            <Text size="sm">
                                                {score.accountKey}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm">
                                                {score.namespace ?? '-'}
                                            </Text>
                                            {score.cloudUrl && (
                                                <Text size="xs" c="dimmed">
                                                    {score.cloudUrl}
                                                </Text>
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            <Text fw={600}>
                                                {score.normalizedScore.toFixed(
                                                    2,
                                                )}
                                            </Text>
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
                                                {score.totalPoints.toFixed(2)} /{' '}
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
                                ))}
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
