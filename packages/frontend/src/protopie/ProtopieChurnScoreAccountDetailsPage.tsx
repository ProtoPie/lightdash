import { type Protopie } from '@lightdash/common';
import {
    Alert,
    Anchor,
    Badge,
    Button,
    Card,
    Group,
    Loader,
    Progress,
    SimpleGrid,
    Stack,
    Table,
    Text,
    TextInput,
    Title,
} from '@mantine-8/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import Callout from '../components/common/Callout';
import MantineIcon from '../components/common/MantineIcon';
import EChartsReact, {
    type EChartsOption,
} from '../components/EChartsReactWrapper';
import { useProjectUuid } from '../hooks/useProjectUuid';
import { useProtopieChurnScoreAccountDetails } from './api';
import classes from './ProtopieFormsPage.module.css';
import ProtopieSectionTabs from './ProtopieSectionTabs';

const riskBandColor: Record<Protopie.ChurnScoreRiskBand, string> = {
    low: 'green',
    medium: 'yellow',
    high: 'red',
};

const DATE_VALUE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const chartColors = [
    '#4C6FFF',
    '#9B5DE5',
    '#00A896',
    '#F9A03F',
    '#EF476F',
    '#118AB2',
    '#6A994E',
    '#F15BB5',
    '#2A9D8F',
    '#E76F51',
];

const formatNumber = (value: number, digits = 2) =>
    new Intl.NumberFormat(undefined, {
        maximumFractionDigits: digits,
    }).format(value);

const formatDateTime = (value: string | null) => {
    if (!value) return '-';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString();
};

const formatFactorValue = (
    value: number,
    unit: Protopie.ChurnScoreGoalUnit,
): string => {
    if (unit === 'fraction') {
        return `${formatNumber(value * 100, 1)}%`;
    }
    if (unit === 'days') {
        return `${formatNumber(value, 1)} days`;
    }
    if (unit === 'count_per_user') {
        return `${formatNumber(value, 2)} / user`;
    }
    return formatNumber(value, 2);
};

const buildEventChartOption = (
    eventUsage: Protopie.ChurnScoreAccountEventUsage,
): EChartsOption => {
    const topEvents = eventUsage.events
        .filter((event) => event.eventCount > 0)
        .slice(0, 10);
    const dates = Array.from(
        new Set(eventUsage.daily.map((point) => point.eventDate)),
    ).sort();
    const countsByEventDate = new Map(
        eventUsage.daily.map((point) => [
            `${point.eventName}__${point.eventDate}`,
            point.eventCount,
        ]),
    );

    return {
        color: chartColors,
        tooltip: {
            trigger: 'axis',
        },
        legend: {
            type: 'scroll',
            top: 0,
            right: 0,
        },
        grid: {
            left: 48,
            right: 32,
            top: 64,
            bottom: 64,
        },
        xAxis: {
            type: 'category',
            data: dates,
            axisLabel: {
                rotate: 45,
            },
        },
        yAxis: {
            type: 'value',
            minInterval: 1,
        },
        series: topEvents.map((event) => ({
            name: event.eventName,
            type: 'line',
            smooth: true,
            showSymbol: false,
            emphasis: {
                focus: 'series',
            },
            data: dates.map(
                (date) =>
                    countsByEventDate.get(`${event.eventName}__${date}`) ?? 0,
            ),
        })),
    };
};

const ProtopieChurnScoreAccountDetailsPage = () => {
    const projectUuid = useProjectUuid();
    const { accountKey } = useParams<{ accountKey: string }>();
    const decodedAccountKey = useMemo(() => {
        if (!accountKey) return undefined;
        try {
            return decodeURIComponent(accountKey);
        } catch {
            return accountKey;
        }
    }, [accountKey]);
    const [searchParams, setSearchParams] = useSearchParams();
    const configUuid = searchParams.get('configUuid') ?? undefined;
    const dateFrom = searchParams.get('dateFrom') ?? undefined;
    const dateTo = searchParams.get('dateTo') ?? undefined;
    const updateDateFilter = useCallback(
        (key: 'dateFrom' | 'dateTo', value: string) => {
            setSearchParams((currentParams) => {
                const nextParams = new URLSearchParams(currentParams);
                if (DATE_VALUE_REGEX.test(value)) {
                    nextParams.set(key, value);
                } else {
                    nextParams.delete(key);
                }
                return nextParams;
            });
        },
        [setSearchParams],
    );
    const clearDateFilters = useCallback(() => {
        setSearchParams((currentParams) => {
            const nextParams = new URLSearchParams(currentParams);
            nextParams.delete('dateFrom');
            nextParams.delete('dateTo');
            return nextParams;
        });
    }, [setSearchParams]);
    const details = useProtopieChurnScoreAccountDetails({
        projectUuid,
        accountKey: decodedAccountKey,
        configUuid,
        dateFrom,
        dateTo,
    });
    const chartOption = useMemo(
        () =>
            details.data
                ? buildEventChartOption(details.data.eventUsage)
                : undefined,
        [details.data],
    );

    if (details.isLoading && !details.data) {
        return (
            <Group className={classes.page}>
                <Loader size="sm" />
                <Text c="dimmed">Loading churn score details</Text>
            </Group>
        );
    }

    if (details.error) {
        return (
            <Alert color="red" title="Churn score details could not load">
                {details.error.error.message}
            </Alert>
        );
    }

    if (!details.data) {
        return null;
    }

    const { score, config, factors, eventUsage } = details.data;
    const dateFromValue = dateFrom ?? eventUsage.dateFrom;
    const dateToValue = dateTo ?? eventUsage.dateTo;
    const { minSelectableDate, maxSelectableDate } = eventUsage;
    // Native <input type="date"> enforces min/max in its picker but still lets
    // users type out-of-range values, so we keep an explicit warning as a net.
    const dateRangeWarning = ((): string | null => {
        const toMs = (value: string) =>
            new Date(`${value}T00:00:00.000Z`).getTime();
        const dayMs = 24 * 60 * 60 * 1000;
        const windowDays =
            Math.round(
                (toMs(maxSelectableDate) - toMs(minSelectableDate)) / dayMs,
            ) + 1;
        if (dateFromValue > dateToValue) {
            return 'Start date must be on or before the end date.';
        }
        if (
            dateFromValue < minSelectableDate ||
            dateToValue > maxSelectableDate
        ) {
            return `Only the most recent ${windowDays} days are available. Pick dates between ${minSelectableDate} and ${maxSelectableDate}.`;
        }
        const spanDays =
            Math.round((toMs(dateToValue) - toMs(dateFromValue)) / dayMs) + 1;
        if (spanDays > windowDays) {
            return `You can view at most ${windowDays} days of event usage at a time.`;
        }
        return null;
    })();
    const topEventCount = Math.max(
        ...eventUsage.events.map((event) => event.eventCount),
        1,
    );

    return (
        <Stack className={classes.page} gap="lg">
            <Stack className={classes.section} gap="xs">
                <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                        <Button
                            component={Link}
                            to={`/projects/${projectUuid}/protopie/churn/scores`}
                            variant="subtle"
                            size="xs"
                            leftSection={<MantineIcon icon={IconArrowLeft} />}
                            w="fit-content"
                        >
                            Back to scores
                        </Button>
                        <Title order={3}>{score.namespace ?? 'Account'}</Title>
                        <Group gap="xs">
                            <Text c="dimmed" size="sm">
                                Combined namespace score across all teams for{' '}
                                {score.accountKey}
                            </Text>
                            {score.cloudUrl && (
                                <Anchor
                                    size="sm"
                                    href={score.cloudUrl}
                                    target="_blank"
                                >
                                    {score.cloudUrl}
                                </Anchor>
                            )}
                        </Group>
                    </Stack>
                    <Badge
                        color={riskBandColor[score.riskBand]}
                        variant="light"
                        size="lg"
                    >
                        {score.riskBand} risk
                    </Badge>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="md">
                <Card withBorder className={classes.formPanel}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Health score
                    </Text>
                    <Title order={2}>{score.normalizedScore.toFixed(2)}</Title>
                    <Text size="sm" c="dimmed">
                        {score.totalPoints.toFixed(2)} /{' '}
                        {score.maxPoints.toFixed(2)} points
                    </Text>
                </Card>
                <Card withBorder className={classes.formPanel}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Rubric
                    </Text>
                    <Title order={4}>{config.name}</Title>
                    <Text size="sm" c="dimmed">
                        v{config.version}, {config.lookbackDays} day lookback
                    </Text>
                </Card>
                <Card withBorder className={classes.formPanel}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Selected event volume
                    </Text>
                    <Title order={4}>
                        {eventUsage.totalEvents.toLocaleString()}
                    </Title>
                    <Text size="sm" c="dimmed">
                        {eventUsage.dateFrom} to {eventUsage.dateTo} across{' '}
                        {eventUsage.selectedEventNames.length} rubric events
                    </Text>
                </Card>
                <Card withBorder className={classes.formPanel}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                        Computed
                    </Text>
                    <Title order={4}>{score.scoredForDate}</Title>
                    <Text size="sm" c="dimmed">
                        {formatDateTime(String(score.computedAt))}
                    </Text>
                </Card>
            </SimpleGrid>

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group justify="space-between">
                        <Stack gap={2}>
                            <Title order={4}>Factor results</Title>
                            <Text size="sm" c="dimmed">
                                Actual values are measured from Redshift. Each
                                factor&apos;s value is scored against the rubric
                                to earn points; the health score is their sum.
                            </Text>
                        </Stack>
                        <Badge variant="light">{factors.length}</Badge>
                    </Group>

                    <Table.ScrollContainer minWidth={980}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Factor</Table.Th>
                                    <Table.Th>Actual</Table.Th>
                                    <Table.Th>Goal</Table.Th>
                                    <Table.Th>Achievement</Table.Th>
                                    <Table.Th>Weight</Table.Th>
                                    <Table.Th>Points</Table.Th>
                                    <Table.Th>Aggregation</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {factors.map((factor) => (
                                    <Table.Tr key={factor.factorKey}>
                                        <Table.Td>
                                            <Text size="sm" fw={600}>
                                                {factor.label}
                                            </Text>
                                            <Text size="xs" c="dimmed">
                                                {factor.eventGroup.events
                                                    .length > 0
                                                    ? factor.eventGroup.events.join(
                                                          ', ',
                                                      )
                                                    : 'No event filter'}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            {formatFactorValue(
                                                factor.score.raw,
                                                factor.goalUnit,
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            {formatFactorValue(
                                                factor.score.goal,
                                                factor.goalUnit,
                                            )}
                                        </Table.Td>
                                        <Table.Td>
                                            <Stack gap={4}>
                                                <Progress
                                                    value={
                                                        factor.score
                                                            .achievementPercent
                                                    }
                                                    size="sm"
                                                />
                                                <Text size="xs" c="dimmed">
                                                    {factor.score.achievementPercent.toFixed(
                                                        1,
                                                    )}
                                                    %
                                                </Text>
                                            </Stack>
                                        </Table.Td>
                                        <Table.Td>{factor.maxPoints}</Table.Td>
                                        <Table.Td>
                                            <Text fw={600}>
                                                {factor.score.points.toFixed(2)}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm">
                                                {factor.aggregation}
                                            </Text>
                                            <Text size="xs" c="dimmed">
                                                {factor.goalUnit}
                                            </Text>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                </Stack>
            </Card>

            <Card withBorder className={classes.formPanel}>
                <Stack gap="md">
                    <Group justify="space-between" align="flex-start">
                        <Stack gap={2}>
                            <Title order={4}>Event usage</Title>
                            <Text size="sm" c="dimmed">
                                Daily selected event volume across all teams in
                                this namespace for the selected date range.
                            </Text>
                        </Stack>
                        <Stack gap="xs" align="flex-end">
                            <Badge variant="light">
                                {eventUsage.dateFrom} to {eventUsage.dateTo}
                            </Badge>
                            <Group gap="xs" align="flex-end">
                                <TextInput
                                    label="From"
                                    type="date"
                                    value={dateFromValue}
                                    min={minSelectableDate}
                                    max={dateToValue}
                                    onChange={(event) =>
                                        updateDateFilter(
                                            'dateFrom',
                                            event.currentTarget.value,
                                        )
                                    }
                                />
                                <TextInput
                                    label="To"
                                    type="date"
                                    value={dateToValue}
                                    min={dateFromValue}
                                    max={maxSelectableDate}
                                    onChange={(event) =>
                                        updateDateFilter(
                                            'dateTo',
                                            event.currentTarget.value,
                                        )
                                    }
                                />
                                <Button
                                    variant="default"
                                    size="xs"
                                    onClick={clearDateFilters}
                                    disabled={!dateFrom && !dateTo}
                                >
                                    Reset
                                </Button>
                            </Group>
                        </Stack>
                    </Group>

                    {dateRangeWarning && (
                        <Callout variant="warning">{dateRangeWarning}</Callout>
                    )}

                    {eventUsage.totalEvents > 0 && chartOption ? (
                        <EChartsReact
                            option={chartOption}
                            style={{ height: 360, width: '100%' }}
                            notMerge
                        />
                    ) : (
                        <Alert color="gray" title="No matching event usage">
                            This account has no selected rubric events in the
                            selected date range.
                        </Alert>
                    )}

                    <Table.ScrollContainer minWidth={900}>
                        <Table verticalSpacing="sm">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Event name</Table.Th>
                                    <Table.Th>Event count</Table.Th>
                                    <Table.Th>% of events</Table.Th>
                                    <Table.Th>Unique users</Table.Th>
                                    <Table.Th>Days active</Table.Th>
                                    <Table.Th>Last seen</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {eventUsage.events.map((event) => (
                                    <Table.Tr key={event.eventName}>
                                        <Table.Td>
                                            <Text size="sm" fw={600}>
                                                {event.eventName}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text fw={600}>
                                                {event.eventCount.toLocaleString()}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Stack gap={4}>
                                                <Progress
                                                    value={
                                                        (event.eventCount /
                                                            topEventCount) *
                                                        100
                                                    }
                                                    size="sm"
                                                />
                                                <Text size="xs" c="dimmed">
                                                    {(
                                                        event.shareOfEvents *
                                                        100
                                                    ).toFixed(1)}
                                                    %
                                                </Text>
                                            </Stack>
                                        </Table.Td>
                                        <Table.Td>{event.activeUsers}</Table.Td>
                                        <Table.Td>{event.activeDays}</Table.Td>
                                        <Table.Td>
                                            {formatDateTime(event.lastSeenAt)}
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

export default ProtopieChurnScoreAccountDetailsPage;
