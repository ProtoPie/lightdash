import { subject } from '@casl/ability';
import { Protopie } from '@lightdash/common';
import {
    ActionIcon,
    Alert,
    Badge,
    Button,
    Card,
    Group,
    Loader,
    MultiSelect,
    NumberInput,
    Select,
    Stack,
    Table,
    Text,
    TextInput,
    Title,
    Tooltip,
} from '@mantine-8/core';
import { useDebouncedValue } from '@mantine-8/hooks';
import {
    IconCalculator,
    IconDeviceFloppy,
    IconHelpCircle,
    IconHistory,
    IconPlus,
    IconRefresh,
    IconTrash,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import MantineIcon from '../components/common/MantineIcon';
import { useProjectUuid } from '../hooks/useProjectUuid';
import useApp from '../providers/App/useApp';
import {
    useProtopieChurnConfig,
    useProtopieChurnConfigs,
    useProtopieChurnEvents,
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

const DEFAULT_CONFIG_NAME = Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;
const POINT_TOTAL = 100;
const POINT_TOTAL_TOLERANCE = 0.000001;

type RubricHelpLabelProps = {
    label: string;
    description: string;
};

const RubricHelpLabel = ({ label, description }: RubricHelpLabelProps) => (
    <Group gap={4} wrap="nowrap">
        <Text span inherit>
            {label}
        </Text>
        <Tooltip
            multiline
            withinPortal
            maw={420}
            position="top-start"
            label={description}
        >
            <span>
                <MantineIcon icon={IconHelpCircle} size="sm" color="gray" />
            </span>
        </Tooltip>
    </Group>
);

const rubricLabels = {
    rubric: 'A rubric is a named churn-score formula. Saving changes creates a new version so old scores can still be audited.',
    newCustomRubric:
        'Creates a private/custom copy of the current rubric using the unsaved edits on this page. Use this to test a different scoring model without changing the shared default.',
    lookbackDays:
        'The number of days of product events included in one recompute. A 90-day lookback means only matching events from the last 90 days are counted.',
    lowRiskThreshold:
        'Risk uses scorePercent = total earned points / total possible points. If scorePercent is at or above this value, the account is Low risk. Example: 0.75 means normalized score >= 75.',
    mediumRiskThreshold:
        'If scorePercent is below the Low threshold but at or above this value, the account is Medium risk. Scores below this value are High risk.',
    factor: 'One scoring rule. This label is what users see when reviewing or editing the rubric.',
    weight: 'Maximum points this factor can contribute. All factor weights must add up to 100. Earned points = min(actual / goal, 1) * weight.',
    goal: 'The target value for this factor. Reaching the goal earns the full weight; partial progress earns proportional points.',
    unit: 'How to read the goal value: Fraction is 0-1, Count is total events, Count per user is events divided by active users, Days is active days in the lookback window.',
    aggregation:
        'How the backend calculates actual before scoring: percent of users with selected events, total event count, events per user, or active days.',
    events: 'Product event names included in this factor. Selected events are combined with OR. Active days ignores this list and counts distinct event dates.',
    actions:
        'Remove this factor from the rubric. After removing factors, the remaining weights still must total 100.',
};

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
    windowDays: factor.windowDays ?? null,
    sortOrder: factor.sortOrder,
});

const ProtopieChurnScoreRubricPage = () => {
    const projectUuid = useProjectUuid();
    const { user } = useApp();
    const [selectedConfigName, setSelectedConfigName] =
        useState(DEFAULT_CONFIG_NAME);
    const [eventSearch, setEventSearch] = useState('');
    const [debouncedEventSearch] = useDebouncedValue(eventSearch, 300);
    const configsQuery = useProtopieChurnConfigs(projectUuid);
    const configQuery = useProtopieChurnConfig(projectUuid, selectedConfigName);
    const versionsQuery = useProtopieChurnConfigVersions(
        projectUuid,
        selectedConfigName,
    );
    const eventsQuery = useProtopieChurnEvents({
        projectUuid,
        search: debouncedEventSearch,
    });
    const updateConfig = useUpdateProtopieChurnConfig(projectUuid);
    const restoreVersion = useRestoreProtopieChurnConfigVersion(projectUuid);
    const recompute = useRecomputeProtopieChurnScore(projectUuid);
    const [runUuid, setRunUuid] = useState<string | undefined>();
    const runQuery = useProtopieChurnRun({ projectUuid, runUuid });

    const [lookbackDays, setLookbackDays] = useState(90);
    const [lowThreshold, setLowThreshold] = useState(0.75);
    const [mediumThreshold, setMediumThreshold] = useState(0.5);
    const [factors, setFactors] = useState<Protopie.ChurnScoreFactorInput[]>(
        [],
    );
    const [newRubricName, setNewRubricName] = useState('');
    const [restoreConfigUuid, setRestoreConfigUuid] = useState<string | null>(
        null,
    );

    useEffect(() => {
        if (!configQuery.data) return;

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
    const name = configQuery.data?.config.name ?? selectedConfigName;
    const totalPointsInvalid =
        Math.abs(totalPoints - POINT_TOTAL) > POINT_TOTAL_TOLERANCE;

    const configOptions = useMemo(() => {
        const configs = configsQuery.data ?? [];
        const fallback = configQuery.data?.config;
        const allConfigs = fallback
            ? [
                  ...configs,
                  // Dedupe by name, not configUuid: the Select option value is
                  // the rubric name, and right after "save as new version" the
                  // two queries can briefly hold different versions (different
                  // UUIDs) of the same rubric, which would produce duplicate
                  // option values and crash the Mantine Select.
                  ...(configs.some((config) => config.name === fallback.name)
                      ? []
                      : [fallback]),
              ]
            : configs;

        return allConfigs.map((config) => ({
            value: config.name,
            label: `${config.name} (v${config.version})`,
        }));
    }, [configQuery.data?.config, configsQuery.data]);

    const eventOptions = useMemo(() => {
        const existingEvents = factors.flatMap(
            (factor) => factor.eventGroup.events,
        );
        const eventNames = new Set<string>([
            ...(eventsQuery.data ?? []),
            ...existingEvents,
        ]);

        return [...eventNames]
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
            .map((eventName) => ({
                value: eventName,
                label: eventName,
            }));
    }, [eventsQuery.data, factors]);

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

    const addFactor = () => {
        setFactors((currentFactors) => {
            const keys = new Set(
                currentFactors.map((factor) => factor.factorKey),
            );
            let index = 1;
            while (keys.has(`custom_factor_${index}`)) {
                index += 1;
            }

            return [
                ...currentFactors,
                {
                    factorKey: `custom_factor_${index}`,
                    label: `Custom factor ${index}`,
                    maxPoints: 0,
                    goalValue: 1,
                    goalUnit: 'count',
                    aggregation: 'event_count',
                    eventGroup: {
                        operator: 'or',
                        events: [],
                    },
                    stepThresholds: null,
                    windowDays: null,
                    sortOrder:
                        Math.max(
                            0,
                            ...currentFactors.map((factor) => factor.sortOrder),
                        ) + 10,
                },
            ];
        });
    };

    const removeFactor = (index: number) => {
        setFactors((currentFactors) =>
            currentFactors
                .filter((_, factorIndex) => factorIndex !== index)
                .map((factor, factorIndex) => ({
                    ...factor,
                    sortOrder: (factorIndex + 1) * 10,
                })),
        );
    };

    const thresholdsInvalid = lowThreshold <= mediumThreshold;
    const rubricInvalid = thresholdsInvalid || totalPointsInvalid;
    const isDefaultRubric = name === DEFAULT_CONFIG_NAME;
    const canManageProject =
        (user.data?.ability?.can(
            'manage',
            subject('Project', {
                organizationUuid: user.data.organizationUuid,
                projectUuid,
            }),
        ) ||
            user.data?.ability?.can(
                'manage',
                subject('Organization', {
                    organizationUuid: user.data?.organizationUuid,
                }),
            )) ??
        false;
    const defaultRubricBlocked = isDefaultRubric && !canManageProject;
    const trimmedNewRubricName = newRubricName.trim();
    const visibleRubricNameExists = (configsQuery.data ?? []).some(
        (config) =>
            config.name.toLowerCase() === trimmedNewRubricName.toLowerCase(),
    );
    const canCreateRubric =
        trimmedNewRubricName.length > 0 &&
        trimmedNewRubricName !== DEFAULT_CONFIG_NAME &&
        !visibleRubricNameExists;

    const handleSave = () => {
        if (rubricInvalid) {
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

    const handleCreateRubric = () => {
        if (!canCreateRubric || rubricInvalid) {
            return;
        }

        updateConfig.mutate(
            {
                name: trimmedNewRubricName,
                lookbackDays,
                scoreFunction: 'linear',
                riskBandThresholds: {
                    low: lowThreshold,
                    medium: mediumThreshold,
                },
                factors,
            },
            {
                onSuccess: (response) => {
                    setSelectedConfigName(response.config.name);
                    setNewRubricName('');
                },
            },
        );
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
                            Select the shared default rubric or create your own
                            rubric, then compute scores from that version.
                        </Text>
                    </Stack>
                    <Group>
                        {isDefaultRubric && (
                            <Badge variant="outline">
                                Admin-managed default
                            </Badge>
                        )}
                        <Badge variant="light">
                            v{configQuery.data?.config.version}
                        </Badge>
                        <Badge
                            variant="outline"
                            color={totalPointsInvalid ? 'red' : undefined}
                        >
                            Max points {totalPoints.toFixed(2)}
                        </Badge>
                    </Group>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group grow align="flex-end">
                        <Select
                            label={
                                <RubricHelpLabel
                                    label="Rubric"
                                    description={rubricLabels.rubric}
                                />
                            }
                            allowDeselect={false}
                            data={configOptions}
                            value={selectedConfigName}
                            onChange={(value) => {
                                setSelectedConfigName(
                                    value ?? DEFAULT_CONFIG_NAME,
                                );
                                setRestoreConfigUuid(null);
                            }}
                        />
                        <TextInput
                            label={
                                <RubricHelpLabel
                                    label="New custom rubric"
                                    description={rubricLabels.newCustomRubric}
                                />
                            }
                            placeholder="Example: EMEA renewal rubric"
                            value={newRubricName}
                            error={
                                visibleRubricNameExists
                                    ? 'Name already exists'
                                    : undefined
                            }
                            onChange={(event) =>
                                setNewRubricName(event.currentTarget.value)
                            }
                        />
                        <Button
                            variant="default"
                            disabled={!canCreateRubric || rubricInvalid}
                            loading={updateConfig.isLoading}
                            onClick={handleCreateRubric}
                        >
                            Save edits as custom rubric
                        </Button>
                    </Group>

                    <Group grow align="flex-end">
                        <NumberInput
                            label={
                                <RubricHelpLabel
                                    label="Lookback days"
                                    description={rubricLabels.lookbackDays}
                                />
                            }
                            min={1}
                            value={lookbackDays}
                            onChange={(value) =>
                                setLookbackDays(Number(value) || 90)
                            }
                        />
                        <NumberInput
                            label={
                                <RubricHelpLabel
                                    label="Low risk threshold"
                                    description={rubricLabels.lowRiskThreshold}
                                />
                            }
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
                            label={
                                <RubricHelpLabel
                                    label="Medium risk threshold"
                                    description={
                                        rubricLabels.mediumRiskThreshold
                                    }
                                />
                            }
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

                    <Group justify="flex-end">
                        <Button
                            variant="default"
                            leftSection={<MantineIcon icon={IconPlus} />}
                            onClick={addFactor}
                        >
                            Add factor
                        </Button>
                    </Group>

                    <Table.ScrollContainer minWidth={1300}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Factor"
                                            description={rubricLabels.factor}
                                        />
                                    </Table.Th>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Weight"
                                            description={rubricLabels.weight}
                                        />
                                    </Table.Th>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Goal"
                                            description={rubricLabels.goal}
                                        />
                                    </Table.Th>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Unit"
                                            description={rubricLabels.unit}
                                        />
                                    </Table.Th>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Aggregation"
                                            description={
                                                rubricLabels.aggregation
                                            }
                                        />
                                    </Table.Th>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Events"
                                            description={rubricLabels.events}
                                        />
                                    </Table.Th>
                                    <Table.Th>
                                        <RubricHelpLabel
                                            label="Actions"
                                            description={rubricLabels.actions}
                                        />
                                    </Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {factors.map((factor, index) => (
                                    <Table.Tr key={index}>
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
                                            <MultiSelect
                                                searchable
                                                clearable
                                                data={eventOptions}
                                                searchValue={eventSearch}
                                                onSearchChange={setEventSearch}
                                                placeholder={
                                                    factor.aggregation ===
                                                    'active_days'
                                                        ? 'Not used'
                                                        : eventsQuery.isLoading
                                                          ? 'Loading events'
                                                          : 'Select events'
                                                }
                                                disabled={
                                                    factor.aggregation ===
                                                    'active_days'
                                                }
                                                value={factor.eventGroup.events}
                                                onChange={(events) =>
                                                    updateFactor(index, {
                                                        ...factor,
                                                        eventGroup: {
                                                            operator: 'or',
                                                            events,
                                                        },
                                                    })
                                                }
                                            />
                                        </Table.Td>
                                        <Table.Td>
                                            <ActionIcon
                                                variant="subtle"
                                                color="red"
                                                aria-label="Remove factor"
                                                disabled={factors.length <= 1}
                                                onClick={() =>
                                                    removeFactor(index)
                                                }
                                            >
                                                <MantineIcon icon={IconTrash} />
                                            </ActionIcon>
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

                    {totalPointsInvalid && (
                        <Alert color="red" title="Weights must total 100">
                            Current total is {totalPoints.toFixed(2)}.
                        </Alert>
                    )}

                    {defaultRubricBlocked && (
                        <Alert color="blue" title="Default rubric is shared">
                            Only project or organization admins can save new
                            default rubric versions. Create a custom rubric to
                            test your own weights.
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
                                disabled={
                                    !restoreConfigUuid || defaultRubricBlocked
                                }
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
                            disabled={rubricInvalid || defaultRubricBlocked}
                            onClick={() =>
                                recompute.mutate({
                                    name,
                                    configUuid:
                                        configQuery.data?.config.configUuid,
                                })
                            }
                        >
                            Recompute now
                        </Button>
                        <Button
                            leftSection={
                                <MantineIcon icon={IconDeviceFloppy} />
                            }
                            loading={updateConfig.isLoading}
                            disabled={rubricInvalid || defaultRubricBlocked}
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
