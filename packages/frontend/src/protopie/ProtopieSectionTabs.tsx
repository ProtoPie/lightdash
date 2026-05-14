import { Tabs } from '@mantine-8/core';
import { type FC } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useProjectUuid } from '../hooks/useProjectUuid';

const ProtopieSectionTabs: FC = () => {
    const projectUuid = useProjectUuid();
    const navigate = useNavigate();
    const location = useLocation();

    const value = location.pathname.includes('/protopie/churn/scores')
        ? 'scores'
        : location.pathname.includes('/protopie/churn/rubric')
          ? 'rubric'
          : 'forms';

    return (
        <Tabs
            value={value}
            onChange={(nextValue) => {
                if (!nextValue) return;
                if (nextValue === 'forms') {
                    void navigate(`/projects/${projectUuid}/protopie/forms`);
                }
                if (nextValue === 'rubric') {
                    void navigate(
                        `/projects/${projectUuid}/protopie/churn/rubric`,
                    );
                }
                if (nextValue === 'scores') {
                    void navigate(
                        `/projects/${projectUuid}/protopie/churn/scores`,
                    );
                }
            }}
        >
            <Tabs.List>
                <Tabs.Tab value="forms">Forms</Tabs.Tab>
                <Tabs.Tab value="rubric">Churn rubric</Tabs.Tab>
                <Tabs.Tab value="scores">Churn scores</Tabs.Tab>
            </Tabs.List>
        </Tabs>
    );
};

export default ProtopieSectionTabs;
