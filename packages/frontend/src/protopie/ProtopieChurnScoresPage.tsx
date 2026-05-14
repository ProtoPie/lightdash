import { type Protopie } from '@lightdash/common';
import {
    Alert,
    Badge,
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
import { useMemo, useState } from 'react';
import { useProjectUuid } from '../hooks/useProjectUuid';
import { useProtopieChurnScores } from './api';
import classes from './ProtopieFormsPage.module.css';
import ProtopieSectionTabs from './ProtopieSectionTabs';

const riskBandColor: Record<Protopie.ChurnScoreRiskBand, string> = {
    low: 'green',
    medium: 'yellow',
    high: 'red',
};

const ProtopieChurnScoresPage = () => {
    const projectUuid = useProjectUuid();
    const [riskBand, setRiskBand] =
        useState<Protopie.ChurnScoreRiskBand | null>(null);
    const [namespace, setNamespace] = useState('');
    const filters = useMemo<Protopie.ChurnScoreLatestFilters>(
        () => ({
            riskBand: riskBand ?? undefined,
            namespace: namespace || undefined,
            limit: 200,
        }),
        [namespace, riskBand],
    );
    const scores = useProtopieChurnScores({ projectUuid, filters });

    if (scores.isLoading) {
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
                        <Title order={3}>Churn scores</Title>
                        <Text c="dimmed" size="sm">
                            Latest enterprise-team scores for the active rubric.
                        </Text>
                    </Stack>
                    <Badge variant="light">{scores.data?.length ?? 0}</Badge>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group grow>
                        <Select
                            label="Risk band"
                            clearable
                            data={[
                                { value: 'high', label: 'High' },
                                { value: 'medium', label: 'Medium' },
                                { value: 'low', label: 'Low' },
                            ]}
                            value={riskBand}
                            onChange={(value) =>
                                setRiskBand(
                                    value as Protopie.ChurnScoreRiskBand | null,
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
                                {scores.data?.map((score) => (
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
                </Stack>
            </Card>
        </Stack>
    );
};

export default ProtopieChurnScoresPage;
