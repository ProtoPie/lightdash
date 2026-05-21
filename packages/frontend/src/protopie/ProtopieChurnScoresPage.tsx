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
import { useProtopieChurnScores } from './api';
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

const ProtopieChurnScoresPage = () => {
    const projectUuid = useProjectUuid();
    const [riskBand, setRiskBand] =
        useState<Protopie.ChurnScoreRiskBand | null>(null);
    const [namespace, setNamespace] = useState('');
    const [debouncedNamespace] = useDebouncedValue(namespace, 300);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(String(DEFAULT_PAGE_SIZE));
    const numericPageSize = Number(pageSize);

    useEffect(() => {
        setPage(1);
    }, [debouncedNamespace, numericPageSize, riskBand]);

    const filters = useMemo<Protopie.ChurnScoreLatestFilters>(
        () => ({
            riskBand: riskBand ?? undefined,
            namespace: debouncedNamespace.trim() || undefined,
            limit: numericPageSize,
            offset: (page - 1) * numericPageSize,
        }),
        [debouncedNamespace, numericPageSize, page, riskBand],
    );
    const scores = useProtopieChurnScores({ projectUuid, filters });
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
