import { Badge, Card, Stack, Table, Text, Title } from '@mantine-8/core';
import classes from './ProtopieFormsPage.module.css';

const v1Factors = [
    ['% users with starting action', '5', '50%'],
    ['# starting actions per user', '5', '20'],
    ['% activated / logged-in users', '10', '50%'],
    ['# pie creation / save actions per user', '10', '20'],
    ['% users with pie creation / save action', '10', '50%'],
    ['% users with AI feature usage', '10', '50%'],
    ['% users with Trigger or Response action', '15', '50%'],
    ['# Trigger or Response actions per user', '15', '20'],
    ['Number of Messages Received', '10', '5'],
    ['Active days', '10', '10'],
];

const v2Signals = [
    [
        'Action retention per user',
        'Users who did an action before and still do it now',
    ],
    [
        'Action frequency trend',
        'Percent change between early and recent activity',
    ],
    ['Days since last action', 'Freshness signal for each core action group'],
    ['Active-user retention', 'Returning, churning, and new active users'],
    ['Concentration risk', 'Share of activity from the top 3 users'],
    ['Velocity to first value', 'Onboarding speed for new enterprise teams'],
];

type ProtopieChurnScoreMethodCardsProps = {
    variant: 'v1' | 'v2';
};

const ProtopieChurnScoreMethodCards = ({
    variant,
}: ProtopieChurnScoreMethodCardsProps) => {
    if (variant === 'v1') {
        return (
            <Stack className={classes.section}>
                <Card withBorder className={classes.formPanel}>
                    <Stack gap="sm">
                        <Badge variant="light">Churn score v1</Badge>
                        <Title order={5}>Current Notion rubric</Title>
                        <Text size="sm" c="dimmed">
                            A point-in-time 90-day usage score based on the
                            active ChurnZero-style factors from the Notion page.
                            This is the current implemented score.
                        </Text>
                        <Text size="sm" ff="monospace">
                            factor_points = weight * LEAST(actual / goal, 1)
                        </Text>
                        <Text size="sm" ff="monospace">
                            score = SUM(factor_points) / SUM(weights) * 100
                        </Text>
                        <Table.ScrollContainer minWidth={520}>
                            <Table verticalSpacing="xs">
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>Factor</Table.Th>
                                        <Table.Th>Weight</Table.Th>
                                        <Table.Th>Goal</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    {v1Factors.map(([factor, weight, goal]) => (
                                        <Table.Tr key={factor}>
                                            <Table.Td>
                                                <Text size="xs">{factor}</Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="xs">{weight}</Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Text size="xs">{goal}</Text>
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </Table.ScrollContainer>
                        <Text size="xs" c="dimmed">
                            Risk bands: 75+ low risk, 50-74 medium risk, below
                            50 high risk.
                        </Text>
                    </Stack>
                </Card>
            </Stack>
        );
    }

    return (
        <Stack className={classes.section}>
            <Card withBorder className={classes.formPanel}>
                <Stack gap="sm">
                    <Badge variant="light">Churn score v2</Badge>
                    <Title order={5}>Trajectory-aware proposal</Title>
                    <Text size="sm" c="dimmed">
                        v2 is a <b>separate score</b> displayed alongside v1,
                        not a blend. It measures whether an account is{' '}
                        <i>falling off</i> the bar it used to meet,
                        distinguishing actively-decaying accounts from accounts
                        that never activated.
                    </Text>
                    <Text size="sm" ff="monospace">
                        trajectory_health = 25% action_retention + 20%
                        frequency_trend + 20% freshness + 15%
                        active_user_retention + 10% concentration + 10%
                        onboarding
                    </Text>
                    <Table.ScrollContainer minWidth={520}>
                        <Table verticalSpacing="xs">
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>Signal</Table.Th>
                                    <Table.Th>Meaning</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {v2Signals.map(([signal, meaning]) => (
                                    <Table.Tr key={signal}>
                                        <Table.Td>
                                            <Text size="xs">{signal}</Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="xs">{meaning}</Text>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                    <Text size="xs" c="dimmed">
                        Sub-weights (25 / 20 / 20 / 15 / 10 / 10) are a starting
                        point. They will be recalibrated against historical
                        churns once <code>protopie_churn_labels</code> is
                        populated. v2 never replaces v1; sales owns v1, and v2
                        is evidence plus a categorical risk-pattern label.
                    </Text>
                </Stack>
            </Card>
        </Stack>
    );
};

export default ProtopieChurnScoreMethodCards;
