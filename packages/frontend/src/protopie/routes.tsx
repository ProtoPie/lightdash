import { type RouteObject } from 'react-router';
import ProtopieChurnScoreAccountDetailsPage from './ProtopieChurnScoreAccountDetailsPage';
import ProtopieChurnScoreRubricPage from './ProtopieChurnScoreRubricPage';
import ProtopieChurnScoresPage from './ProtopieChurnScoresPage';

export const protopieProjectRoutes: RouteObject[] = [
    {
        path: 'protopie/churn/rubric',
        element: <ProtopieChurnScoreRubricPage />,
    },
    {
        path: 'protopie/churn/scores',
        element: <ProtopieChurnScoresPage />,
    },
    {
        path: 'protopie/churn/scores/:accountKey',
        element: <ProtopieChurnScoreAccountDetailsPage />,
    },
];
