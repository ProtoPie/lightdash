import { Alert, Badge, Card, Stack, Table, Text, Title } from '@mantine-8/core';
import ProtopieChurnScoreMethodCards from './ProtopieChurnScoreMethodCards';
import classes from './ProtopieFormsPage.module.css';
import ProtopieSectionTabs from './ProtopieSectionTabs';

const riskPatterns = [
    [
        'slow_fade',
        'Pie creation, trigger/response, and active days decline together',
    ],
    ['cliff_drop', 'The account was active, then recent usage dropped sharply'],
    ['never_activated', 'A young account did not reach first-value milestones'],
    [
        'concentration_risk',
        'Most activity depends on a very small set of users',
    ],
    [
        'single_action_decay',
        'A core action dropped while login/start activity remains',
    ],
];

const ProtopieChurnScoreV2Page = () => (
    <Stack className={classes.page} gap="lg">
        <Stack className={classes.section} gap="xs">
            <Stack gap={4}>
                <Title order={3}>Churn score v2</Title>
                <Text c="dimmed" size="sm">
                    Trajectory-aware churn score proposal. Displayed alongside
                    v1, not replacing it.
                </Text>
            </Stack>

            <ProtopieSectionTabs />
        </Stack>

        <Alert color="yellow" title="No v2 data yet">
            This view is a POC spec. Real v2 scores will appear here once the
            three prerequisite marts ship:{' '}
            <code>mart_account_event_history_monthly</code>,{' '}
            <code>mart_account_signals_current</code>, and{' '}
            <code>protopie_churn_labels</code>. See{' '}
            <code>docs/protopie-docs/18-churn-score-v2-trajectory.md</code> for
            the full plan and §8 for the phased rollout.
        </Alert>

        <ProtopieChurnScoreMethodCards variant="v2" />

        <Card withBorder className={classes.formPanel}>
            <Stack gap="md">
                <Badge variant="light">POC status</Badge>
                <Title order={5}>How v2 should be evaluated</Title>
                <Text size="sm" c="dimmed">
                    v2 is a <b>separate score</b> that runs next to v1 — not a
                    blend. Both numbers display side-by-side on the dashboard so
                    sales can see the v1 rubric output (which they own) and the
                    v2 trajectory-health signal (data-driven) at the same time.
                    Calibration against historical churns will tune the
                    sub-weights inside <code>trajectory_health</code>, never the
                    v1 weights.
                </Text>
                <Text size="sm" ff="monospace">
                    trajectory_health = 25% action_retention + 20%
                    frequency_trend + 20% freshness + 15% active_user_retention
                    + 10% concentration + 10% onboarding
                </Text>
                <Text size="sm" ff="monospace">
                    retained_users_pct = users active in baseline and recent
                    window / users active in baseline
                </Text>
                <Text size="sm" ff="monospace">
                    slope = (recent_3mo_avg - first_3mo_avg) / first_3mo_avg
                </Text>
                <Text size="sm" ff="monospace">
                    days_since_last = CURRENT_DATE - MAX(event_time)
                </Text>
                <Title order={6} mt="sm">
                    Risk patterns (categorical, surfaced alongside the score)
                </Title>
                <Table.ScrollContainer minWidth={720}>
                    <Table verticalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Risk pattern</Table.Th>
                                <Table.Th>What it means</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {riskPatterns.map(([pattern, meaning]) => (
                                <Table.Tr key={pattern}>
                                    <Table.Td>
                                        <Text size="sm" ff="monospace">
                                            {pattern}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm">{meaning}</Text>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </Table.ScrollContainer>
                <Text size="xs" c="dimmed">
                    Required before v2 can produce real rows: monthly account
                    event history, current account signals, and reliable churn
                    labels for calibration.
                </Text>
            </Stack>
        </Card>
    </Stack>
);

export default ProtopieChurnScoreV2Page;
