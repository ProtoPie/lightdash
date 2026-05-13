import { Alert, Group, Stack, Switch, Text } from '@mantine-8/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { type FC } from 'react';
import MantineIcon from '../components/common/MantineIcon';
import { useProtopieMcpSettings, useUpdateProtopieMcpSettings } from './api';

const ProtopieMcpSettingsPanel: FC = () => {
    const settingsQuery = useProtopieMcpSettings();
    const updateSettings = useUpdateProtopieMcpSettings();

    const enabled = settingsQuery.data?.mcpWriteEnabled ?? false;
    const isDisabled = settingsQuery.isLoading || updateSettings.isLoading;

    if (settingsQuery.error) {
        return (
            <Alert color="red" title="MCP settings could not load">
                {settingsQuery.error.error.message}
            </Alert>
        );
    }

    return (
        <Stack gap="sm">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap="xxs">
                    <Text fw={500} fz="sm">
                        Enable MCP write tools
                    </Text>
                    <Text fz="xs" c="ldGray.6">
                        Allow authenticated MCP clients with write scope to
                        create and update Lightdash content using the signed-in
                        user&apos;s permissions.
                    </Text>
                </Stack>
                <Switch
                    checked={enabled}
                    disabled={isDisabled}
                    onChange={(event) => {
                        updateSettings.mutate({
                            mcpWriteEnabled: event.currentTarget.checked,
                        });
                    }}
                />
            </Group>

            {enabled && (
                <Alert
                    color="yellow"
                    icon={<MantineIcon icon={IconAlertTriangle} />}
                >
                    MCP write tools can create, update, and delete content for
                    users who authorize an MCP client with write scope.
                </Alert>
            )}
        </Stack>
    );
};

export default ProtopieMcpSettingsPanel;
