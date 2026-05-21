import { Button } from '@mantine-8/core';
import { IconClipboardList } from '@tabler/icons-react';
import { type FC } from 'react';
import { useNavigate } from 'react-router';
import MantineIcon from '../components/common/MantineIcon';

type Props = {
    projectUuid: string;
};

export const ProtopieNavButton: FC<Props> = ({ projectUuid }) => {
    const navigate = useNavigate();

    return (
        <Button
            variant="default"
            size="xs"
            fz="sm"
            leftSection={
                <MantineIcon icon={IconClipboardList} color="ldGray.6" />
            }
            onClick={() => navigate(`/projects/${projectUuid}/protopie/forms`)}
        >
            Churn
        </Button>
    );
};
