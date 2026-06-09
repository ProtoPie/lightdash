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

const ProtopieChurnScoreMethodCards = () => (
    <Stack className={classes.section}>
        <Card withBorder className={classes.formPanel}>
            <Stack gap="sm">
                <Badge variant="light">Churn score</Badge>
                <Title order={5}>Current Notion rubric</Title>
                <Text size="sm" c="dimmed">
                    A point-in-time 90-day usage score based on the active
                    ChurnZero-style factors from the Notion page. This is the
                    current implemented score.
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
                    Risk bands: 75+ low risk, 50-74 medium risk, below 50 high
                    risk.
                </Text>
            </Stack>
        </Card>
    </Stack>
);

export default ProtopieChurnScoreMethodCards;
