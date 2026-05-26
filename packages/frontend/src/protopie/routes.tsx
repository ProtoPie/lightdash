import { type RouteObject } from 'react-router';
import ProtopieChurnScoreAccountDetailsPage from './ProtopieChurnScoreAccountDetailsPage';
import ProtopieChurnScoreRubricPage from './ProtopieChurnScoreRubricPage';
import ProtopieChurnScoresPage from './ProtopieChurnScoresPage';
import ProtopieChurnScoreV2Page from './ProtopieChurnScoreV2Page';

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
    {
        path: 'protopie/churn/scores-v2',
        element: <ProtopieChurnScoreV2Page />,
    },
];
