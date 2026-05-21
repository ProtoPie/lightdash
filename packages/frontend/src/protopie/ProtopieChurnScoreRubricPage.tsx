import { type Protopie } from '@lightdash/common';
import {
    Alert,
    Badge,
    Button,
    Card,
    Group,
    Loader,
    NumberInput,
    Select,
    Stack,
    Table,
    Text,
    Textarea,
    TextInput,
    Title,
} from '@mantine-8/core';
import {
    IconCalculator,
    IconDeviceFloppy,
    IconHistory,
    IconRefresh,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import MantineIcon from '../components/common/MantineIcon';
import { useProjectUuid } from '../hooks/useProjectUuid';
import {
    useProtopieChurnConfig,
    useProtopieChurnConfigVersions,
    useProtopieChurnRun,
    useRecomputeProtopieChurnScore,
    useRestoreProtopieChurnConfigVersion,
    useUpdateProtopieChurnConfig,
} from './api';
import classes from './ProtopieFormsPage.module.css';
import ProtopieSectionTabs from './ProtopieSectionTabs';

const aggregationOptions = [
    { value: 'pct_users_with_event', label: '% users with event' },
    { value: 'event_count', label: 'Event count' },
    { value: 'event_count_per_user', label: 'Events per user' },
    { value: 'active_days', label: 'Active days' },
];

const goalUnitOptions = [
    { value: 'fraction', label: 'Fraction' },
    { value: 'count', label: 'Count' },
    { value: 'count_per_user', label: 'Count per user' },
    { value: 'days', label: 'Days' },
];

const toFactorInput = (
    factor: Protopie.ChurnScoreFactor,
): Protopie.ChurnScoreFactorInput => ({
    factorKey: factor.factorKey,
    label: factor.label,
    maxPoints: factor.maxPoints,
    goalValue: factor.goalValue,
    goalUnit: factor.goalUnit,
    aggregation: factor.aggregation,
    eventGroup: factor.eventGroup,
    stepThresholds: factor.stepThresholds ?? null,
    sortOrder: factor.sortOrder,
});

const parseEvents = (value: string): string[] =>
    value
        .split(/\n|,/)
        .map((eventName) => eventName.trim())
        .filter(Boolean);

const ProtopieChurnScoreRubricPage = () => {
    const projectUuid = useProjectUuid();
    const configQuery = useProtopieChurnConfig(projectUuid);
    const versionsQuery = useProtopieChurnConfigVersions(projectUuid);
    const updateConfig = useUpdateProtopieChurnConfig(projectUuid);
    const restoreVersion = useRestoreProtopieChurnConfigVersion(projectUuid);
    const recompute = useRecomputeProtopieChurnScore(projectUuid);
    const [runUuid, setRunUuid] = useState<string | undefined>();
    const runQuery = useProtopieChurnRun({ projectUuid, runUuid });

    const [name, setName] = useState('');
    const [lookbackDays, setLookbackDays] = useState(90);
    const [lowThreshold, setLowThreshold] = useState(0.75);
    const [mediumThreshold, setMediumThreshold] = useState(0.5);
    const [factors, setFactors] = useState<Protopie.ChurnScoreFactorInput[]>(
        [],
    );
    const [restoreConfigUuid, setRestoreConfigUuid] = useState<string | null>(
        null,
    );

    useEffect(() => {
        if (!configQuery.data) return;

        setName(configQuery.data.config.name);
        setLookbackDays(configQuery.data.config.lookbackDays);
        setLowThreshold(configQuery.data.config.riskBandThresholds.low);
        setMediumThreshold(configQuery.data.config.riskBandThresholds.medium);
        setFactors(configQuery.data.factors.map(toFactorInput));
    }, [configQuery.data]);

    useEffect(() => {
        if (recompute.data?.runUuid) {
            setRunUuid(recompute.data.runUuid);
        }
    }, [recompute.data?.runUuid]);

    useEffect(() => {
        if (
            runQuery.data?.status !== 'completed' &&
            runQuery.data?.status !== 'failed'
        ) {
            return undefined;
        }

        const timeout = window.setTimeout(() => {
            setRunUuid(undefined);
        }, 5000);

        return () => window.clearTimeout(timeout);
    }, [runQuery.data?.status]);

    const totalPoints = useMemo(
        () =>
            factors.reduce(
                (total, factor) => total + Number(factor.maxPoints || 0),
                0,
            ),
        [factors],
    );

    const versionOptions = useMemo(
        () =>
            (versionsQuery.data ?? [])
                .filter(
                    (version) =>
                        version.configUuid !==
                        configQuery.data?.config.configUuid,
                )
                .map((version) => ({
                    value: version.configUuid,
                    label: `v${version.version} (${version.status}) - ${new Date(
                        version.updatedAt,
                    ).toLocaleString()}`,
                })),
        [configQuery.data?.config.configUuid, versionsQuery.data],
    );

    useEffect(() => {
        if (
            restoreConfigUuid &&
            !versionOptions.some((option) => option.value === restoreConfigUuid)
        ) {
            setRestoreConfigUuid(null);
        }
    }, [restoreConfigUuid, versionOptions]);

    const updateFactor = (
        index: number,
        nextFactor: Protopie.ChurnScoreFactorInput,
    ) => {
        setFactors((currentFactors) =>
            currentFactors.map((factor, factorIndex) =>
                factorIndex === index ? nextFactor : factor,
            ),
        );
    };

    const thresholdsInvalid = lowThreshold <= mediumThreshold;

    const handleSave = () => {
        if (thresholdsInvalid) {
            return;
        }

        updateConfig.mutate({
            name,
            lookbackDays,
            scoreFunction: 'linear',
            riskBandThresholds: {
                low: lowThreshold,
                medium: mediumThreshold,
            },
            factors,
        });
    };

    if (configQuery.isLoading) {
        return (
            <Group className={classes.page}>
                <Loader size="sm" />
                <Text c="dimmed">Loading churn rubric</Text>
            </Group>
        );
    }

    if (configQuery.error) {
        return (
            <Alert color="red" title="Churn rubric could not load">
                {configQuery.error.error.message}
            </Alert>
        );
    }

    return (
        <Stack className={classes.page} gap="lg">
            <Stack className={classes.section} gap="xs">
                <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                        <Title order={3}>Churn score rubric</Title>
                        <Text c="dimmed" size="sm">
                            Edit factor weights and goals used by the churn
                            score worker.
                        </Text>
                    </Stack>
                    <Group>
                        <Badge variant="light">
                            v{configQuery.data?.config.version}
                        </Badge>
                        <Badge variant="outline">
                            Max points {totalPoints.toFixed(2)}
                        </Badge>
                    </Group>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group grow align="flex-end">
                        <TextInput
                            label="Rubric name"
                            value={name}
                            onChange={(event) =>
                                setName(event.currentTarget.value)
                            }
                        />
                        <NumberInput
                            label="Lookback days"
                            min={1}
                            value={lookbackDays}
                            onChange={(value) =>
                                setLookbackDays(Number(value) || 90)
                            }
                        />
                        <NumberInput
                            label="Low risk threshold"
                            min={0}
                            max={1}
                            decimalScale={2}
                            error={
                                thresholdsInvalid
                                    ? 'Must be greater than medium'
                                    : undefined
                            }
                            value={lowThreshold}
                            onChange={(value) =>
                                setLowThreshold(Number(value) || 0)
                            }
                        />
                        <NumberInput
                            label="Medium risk threshold"
                            min={0}
                            max={1}
                            decimalScale={2}
                            error={
                                thresholdsInvalid
                                    ? 'Must be lower than low'
                                    : undefined
                            }
                            value={mediumThreshold}
                            onChange={(value) =>
                                setMediumThreshold(Number(value) || 0)
                            }
                        />
                    </Group>

                    <Table.ScrollContainer minWidth={1200}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Factor</Table.Th>
                                    <Table.Th>Weight</Table.Th>
                                    <Table.Th>Goal</Table.Th>
                                    <Table.Th>Unit</Table.Th>
                                    <Table.Th>Aggregation</Table.Th>
                                    <Table.Th>Events</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {factors.map((factor, index) => (
                                    <Table.Tr key={factor.factorKey}>
                                        <Table.Td>
                                            <TextInput
                                                value={factor.label}
                                                onChange={(event) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        label: event
                                                            .currentTarget
                                                            .value,
                                                    })
                                                }
                                            />
                                            <Text size="xs" c="dimmed">
                                                {factor.factorKey}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <NumberInput
                                                min={0}
                                                value={factor.maxPoints}
                                                onChange={(value) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        maxPoints:
                                                            Number(value) || 0,
                                                    })
                                                }
                                            />
                                        </Table.Td>
                                        <Table.Td>
                                            <NumberInput
                                                min={0}
                                                value={factor.goalValue}
                                                onChange={(value) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        goalValue:
                                                            Number(value) || 0,
                                                    })
                                                }
                                            />
                                        </Table.Td>
                                        <Table.Td>
                                            <Select
                                                data={goalUnitOptions}
                                                value={factor.goalUnit}
                                                onChange={(value) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        goalUnit: (value ??
                                                            'fraction') as Protopie.ChurnScoreGoalUnit,
                                                    })
                                                }
                                            />
                                        </Table.Td>
                                        <Table.Td>
                                            <Select
                                                data={aggregationOptions}
                                                value={factor.aggregation}
                                                onChange={(value) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        aggregation: (value ??
                                                            'pct_users_with_event') as Protopie.ChurnScoreAggregation,
                                                    })
                                                }
                                            />
                                        </Table.Td>
                                        <Table.Td>
                                            <Textarea
                                                minRows={2}
                                                autosize
                                                disabled={
                                                    factor.aggregation ===
                                                    'active_days'
                                                }
                                                value={factor.eventGroup.events.join(
                                                    '\n',
                                                )}
                                                onChange={(event) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        eventGroup: {
                                                            operator: 'or',
                                                            events: parseEvents(
                                                                event
                                                                    .currentTarget
                                                                    .value,
                                                            ),
                                                        },
                                                    })
                                                }
                                            />
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>

                    {updateConfig.error && (
                        <Alert color="red" title="Save failed">
                            {updateConfig.error.error.message}
                        </Alert>
                    )}

                    {runQuery.data && (
                        <Alert
                            color={
                                runQuery.data.status === 'failed'
                                    ? 'red'
                                    : 'blue'
                            }
                            title={`Run ${runQuery.data.status}`}
                        >
                            {runQuery.data.status === 'completed'
                                ? `${runQuery.data.accountsScored} accounts scored`
                                : (runQuery.data.errorMessage ??
                                  runQuery.data.runUuid)}
                        </Alert>
                    )}

                    <Stack gap="xs">
                        <Text fw={600} size="sm">
                            Version history
                        </Text>
                        <Group align="flex-end" wrap="nowrap">
                            <Select
                                style={{ flex: 1 }}
                                label="Previous version"
                                description="Restoring copies the selected rubric into a new active version."
                                placeholder={
                                    versionsQuery.isLoading
                                        ? 'Loading versions'
                                        : 'No previous versions yet'
                                }
                                disabled={
                                    versionsQuery.isLoading ||
                                    versionOptions.length === 0
                                }
                                data={versionOptions}
                                value={restoreConfigUuid}
                                onChange={setRestoreConfigUuid}
                            />
                            <Button
                                variant="default"
                                leftSection={<MantineIcon icon={IconHistory} />}
                                loading={restoreVersion.isLoading}
                                disabled={!restoreConfigUuid}
                                onClick={() => {
                                    if (!restoreConfigUuid) return;

                                    restoreVersion.mutate(restoreConfigUuid, {
                                        onSuccess: () =>
                                            setRestoreConfigUuid(null),
                                    });
                                }}
                            >
                                Restore as new version
                            </Button>
                        </Group>
                    </Stack>

                    {restoreVersion.error && (
                        <Alert color="red" title="Restore failed">
                            {restoreVersion.error.error.message}
                        </Alert>
                    )}

                    <Group justify="flex-end">
                        <Button
                            variant="default"
                            leftSection={<MantineIcon icon={IconRefresh} />}
                            onClick={() => void configQuery.refetch()}
                        >
                            Reset unsaved changes
                        </Button>
                        <Button
                            variant="default"
                            leftSection={<MantineIcon icon={IconCalculator} />}
                            loading={recompute.isLoading}
                            onClick={() => recompute.mutate()}
                        >
                            Recompute now
                        </Button>
                        <Button
                            leftSection={
                                <MantineIcon icon={IconDeviceFloppy} />
                            }
                            loading={updateConfig.isLoading}
                            disabled={thresholdsInvalid}
                            onClick={handleSave}
                        >
                            Save as new version
                        </Button>
                    </Group>
                </Stack>
            </Card>
        </Stack>
    );
};

export default ProtopieChurnScoreRubricPage;
