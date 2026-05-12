import { type RouteObject } from 'react-router';
import ProtopieFormsPage from './ProtopieFormsPage';

export const protopieProjectRoutes: RouteObject[] = [
    {
        path: 'protopie/forms',
        element: <ProtopieFormsPage />,
    },
];
