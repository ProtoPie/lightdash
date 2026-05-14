import { type RouteObject } from 'react-router';
import ProtopieChurnScoreRubricPage from './ProtopieChurnScoreRubricPage';
import ProtopieChurnScoresPage from './ProtopieChurnScoresPage';
import ProtopieFormsPage from './ProtopieFormsPage';

export const protopieProjectRoutes: RouteObject[] = [
    {
        path: 'protopie/forms',
        element: <ProtopieFormsPage />,
    },
    {
        path: 'protopie/churn/rubric',
        element: <ProtopieChurnScoreRubricPage />,
    },
    {
        path: 'protopie/churn/scores',
        element: <ProtopieChurnScoresPage />,
    },
];
