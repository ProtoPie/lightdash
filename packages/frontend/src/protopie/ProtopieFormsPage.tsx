import { type Protopie } from '@lightdash/common';
import {
    Alert,
    Badge,
    Button,
    Card,
    Grid,
    Group,
    Loader,
    NumberInput,
    Select,
    Stack,
    Switch,
    Table,
    Text,
    TextInput,
    Textarea,
    Title,
} from '@mantine-8/core';
import { IconRefresh, IconSend } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import MantineIcon from '../components/common/MantineIcon';
import { useProjectUuid } from '../hooks/useProjectUuid';
import {
    useProtopieFormSchemas,
    useProtopieFormSubmissions,
    useSubmitProtopieForm,
} from './api';
import classes from './ProtopieFormsPage.module.css';
import ProtopieSectionTabs from './ProtopieSectionTabs';

const CHURN_SCORE_FORM_KEY = 'churn_score_input';

const normalizePayload = (
    form: Protopie.ProtopieClientFormDefinition,
    values: Record<string, unknown>,
): Record<string, unknown> =>
    form.fields.reduce<Record<string, unknown>>((payload, field) => {
        const value = values[field.key];

        if (value === '' || value === undefined || value === null) {
            return payload;
        }

        if (field.type === 'number') {
            payload[field.key] = Number(value);
            return payload;
        }

        if (field.type === 'tags') {
            payload[field.key] =
                typeof value === 'string'
                    ? value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean)
                    : value;
            return payload;
        }

        payload[field.key] = value;
        return payload;
    }, {});

const getInitialValues = (
    form?: Protopie.ProtopieClientFormDefinition | null,
): Record<string, unknown> =>
    form?.fields.reduce<Record<string, unknown>>((values, field) => {
        values[field.key] = field.type === 'switch' ? false : '';
        return values;
    }, {}) ?? {};

const renderPayload = (payload: Record<string, unknown>) =>
    JSON.stringify(payload, null, 2);

const DynamicField = ({
    field,
    value,
    onChange,
}: {
    field: Protopie.ProtopieFormField;
    value: unknown;
    onChange: (value: unknown) => void;
}) => {
    const label = field.required ? `${field.label} *` : field.label;

    if (field.type === 'select') {
        return (
            <Select
                label={label}
                placeholder={field.placeholder}
                data={field.options ?? []}
                value={typeof value === 'string' ? value : null}
                onChange={(nextValue) => onChange(nextValue ?? '')}
            />
        );
    }

    if (field.type === 'textarea') {
        return (
            <Textarea
                label={label}
                placeholder={field.placeholder}
                value={typeof value === 'string' ? value : ''}
                minRows={4}
                onChange={(event) => onChange(event.currentTarget.value)}
            />
        );
    }

    if (field.type === 'switch') {
        return (
            <Switch
                label={label}
                checked={Boolean(value)}
                onChange={(event) => onChange(event.currentTarget.checked)}
            />
        );
    }

    if (field.type === 'number') {
        return (
            <NumberInput
                label={label}
                placeholder={field.placeholder}
                value={typeof value === 'number' ? value : undefined}
                min={0}
                onChange={onChange}
            />
        );
    }

    return (
        <TextInput
            label={label}
            placeholder={field.placeholder}
            type={field.type === 'date' ? 'date' : 'text'}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.currentTarget.value)}
        />
    );
};

const ProtopieFormsPage = () => {
    const projectUuid = useProjectUuid();
    const schemas = useProtopieFormSchemas(projectUuid);

    const activeForm = useMemo(
        () =>
            schemas.data?.find((form) => form.key === CHURN_SCORE_FORM_KEY) ??
            null,
        [schemas.data],
    );
    const submissions = useProtopieFormSubmissions({
        projectUuid,
        formKey: activeForm?.key,
    });
    const submitForm = useSubmitProtopieForm({
        projectUuid,
        formKey: activeForm?.key,
    });
    const [values, setValues] = useState<Record<string, unknown>>({});

    useEffect(() => {
        setValues(getInitialValues(activeForm));
    }, [activeForm]);

    const handleSubmit = () => {
        if (!activeForm) return;
        submitForm.mutate(normalizePayload(activeForm, values));
    };

    if (schemas.isLoading) {
        return (
            <Group className={classes.page}>
                <Loader size="sm" />
                <Text c="dimmed">Loading churn input</Text>
            </Group>
        );
    }

    if (schemas.error) {
        return (
            <Alert color="red" title="Churn input could not load">
                {schemas.error.error.message}
            </Alert>
        );
    }

    return (
        <Stack className={classes.page} gap="lg">
            <Stack className={classes.section} gap="xs">
                <Group justify="space-between" align="flex-start">
                    <Stack gap={4}>
                        <Title order={3}>Churn input</Title>
                        <Text c="dimmed" size="sm">
                            Submit sales-owned account context into Lightdash.
                        </Text>
                    </Stack>
                    <Button
                        variant="default"
                        size="xs"
                        leftSection={<MantineIcon icon={IconRefresh} />}
                        onClick={() => void submissions.refetch()}
                    >
                        Refresh
                    </Button>
                </Group>

                <ProtopieSectionTabs />
            </Stack>

            {!activeForm ? (
                <Alert
                    color="yellow"
                    title="Churn input form is not configured"
                >
                    The churn score input schema was not returned by the
                    backend.
                </Alert>
            ) : (
                <Grid className={classes.section} gutter="lg">
                    <Grid.Col span={{ base: 12, md: 5 }}>
                        <Card withBorder className={classes.formPanel}>
                            <Stack gap="md">
                                <Group justify="space-between">
                                    <Title order={5}>{activeForm.title}</Title>
                                    <Badge variant="light">
                                        v{activeForm.version}
                                    </Badge>
                                </Group>

                                {activeForm.description && (
                                    <Text size="sm" c="dimmed">
                                        {activeForm.description}
                                    </Text>
                                )}

                                {activeForm.fields.map((field) => (
                                    <DynamicField
                                        key={field.key}
                                        field={field}
                                        value={values[field.key]}
                                        onChange={(value) =>
                                            setValues((currentValues) => ({
                                                ...currentValues,
                                                [field.key]: value,
                                            }))
                                        }
                                    />
                                ))}

                                {submitForm.error && (
                                    <Alert color="red" title="Submit failed">
                                        {submitForm.error.error.message}
                                    </Alert>
                                )}

                                <Button
                                    leftSection={
                                        <MantineIcon icon={IconSend} />
                                    }
                                    loading={submitForm.isLoading}
                                    onClick={handleSubmit}
                                >
                                    Submit
                                </Button>
                            </Stack>
                        </Card>
                    </Grid.Col>

                    <Grid.Col span={{ base: 12, md: 7 }}>
                        <Card withBorder className={classes.formPanel}>
                            <Stack gap="md">
                                <Group justify="space-between">
                                    <Title order={5}>Recent submissions</Title>
                                    <Badge variant="light">
                                        {submissions.data?.length ?? 0}
                                    </Badge>
                                </Group>

                                {submissions.isLoading ? (
                                    <Group>
                                        <Loader size="sm" />
                                        <Text c="dimmed" size="sm">
                                            Loading submissions
                                        </Text>
                                    </Group>
                                ) : (
                                    <Table.ScrollContainer minWidth={720}>
                                        <Table verticalSpacing="sm">
                                            <Table.Thead>
                                                <Table.Tr>
                                                    <Table.Th>Created</Table.Th>
                                                    <Table.Th>Account</Table.Th>
                                                    <Table.Th>Payload</Table.Th>
                                                </Table.Tr>
                                            </Table.Thead>
                                            <Table.Tbody>
                                                {submissions.data?.map(
                                                    (submission) => (
                                                        <Table.Tr
                                                            key={
                                                                submission.formSubmissionUuid
                                                            }
                                                        >
                                                            <Table.Td>
                                                                <Text size="sm">
                                                                    {new Date(
                                                                        submission.createdAt,
                                                                    ).toLocaleString()}
                                                                </Text>
                                                            </Table.Td>
                                                            <Table.Td>
                                                                <Text size="sm">
                                                                    {submission.accountKey ??
                                                                        '-'}
                                                                </Text>
                                                            </Table.Td>
                                                            <Table.Td>
                                                                <Text
                                                                    size="xs"
                                                                    ff="monospace"
                                                                    className={
                                                                        classes.payloadCell
                                                                    }
                                                                >
                                                                    {renderPayload(
                                                                        submission.payload,
                                                                    )}
                                                                </Text>
                                                            </Table.Td>
                                                        </Table.Tr>
                                                    ),
                                                )}
                                            </Table.Tbody>
                                        </Table>
                                    </Table.ScrollContainer>
                                )}
                            </Stack>
                        </Card>
                    </Grid.Col>
                </Grid>
            )}
        </Stack>
    );
};

export default ProtopieFormsPage;
