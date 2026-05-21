import { Tabs } from '@mantine-8/core';
import { type FC } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useProjectUuid } from '../hooks/useProjectUuid';

const ProtopieSectionTabs: FC = () => {
    const projectUuid = useProjectUuid();
    const navigate = useNavigate();
    const location = useLocation();

    const value = location.pathname.includes('/protopie/churn/scores-v2')
        ? 'scores-v2'
        : location.pathname.includes('/protopie/churn/scores')
          ? 'scores-v1'
          : location.pathname.includes('/protopie/churn/rubric')
            ? 'rubric'
            : 'input';

    return (
        <Tabs
            value={value}
            onChange={(nextValue) => {
                if (!nextValue) return;
                if (nextValue === 'input') {
                    void navigate(`/projects/${projectUuid}/protopie/forms`);
                }
                if (nextValue === 'rubric') {
                    void navigate(
                        `/projects/${projectUuid}/protopie/churn/rubric`,
                    );
                }
                if (nextValue === 'scores-v1') {
                    void navigate(
                        `/projects/${projectUuid}/protopie/churn/scores`,
                    );
                }
                if (nextValue === 'scores-v2') {
                    void navigate(
                        `/projects/${projectUuid}/protopie/churn/scores-v2`,
                    );
                }
            }}
        >
            <Tabs.List>
                <Tabs.Tab value="input">Input</Tabs.Tab>
                <Tabs.Tab value="rubric">Rubric</Tabs.Tab>
                <Tabs.Tab value="scores-v1">Scores v1</Tabs.Tab>
                <Tabs.Tab value="scores-v2">Scores v2</Tabs.Tab>
            </Tabs.List>
        </Tabs>
    );
};

export default ProtopieSectionTabs;
