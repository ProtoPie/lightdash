import { Protopie } from '@lightdash/common';
import {
    canViewChurnScoreConfig,
    resolveChurnScoreConfigVisibility,
} from './configVisibility';

const OWNER = 'owner-user-uuid';
const OTHER = 'other-user-uuid';

const config = ({
    name = 'EMEA renewal rubric',
    visibility = 'private' as Protopie.ChurnScoreConfigVisibility,
    createdByUserUuid = OWNER as string | null,
}): Pick<
    Protopie.ChurnScoreConfig,
    'name' | 'visibility' | 'createdByUserUuid'
> => ({ name, visibility, createdByUserUuid });

describe('canViewChurnScoreConfig', () => {
    test('lets the owner view their own private rubric', () => {
        expect(
            canViewChurnScoreConfig({
                config: config({ visibility: 'private' }),
                userUuid: OWNER,
                canManageProject: false,
            }),
        ).toBe(true);
    });

    test('hides a private rubric from a non-owner without manage access', () => {
        expect(
            canViewChurnScoreConfig({
                config: config({ visibility: 'private' }),
                userUuid: OTHER,
                canManageProject: false,
            }),
        ).toBe(false);
    });

    test('lets a project manager view someone else private rubric', () => {
        expect(
            canViewChurnScoreConfig({
                config: config({ visibility: 'private' }),
                userUuid: OTHER,
                canManageProject: true,
            }),
        ).toBe(true);
    });

    test('lets any project member view a public rubric', () => {
        expect(
            canViewChurnScoreConfig({
                config: config({ visibility: 'public' }),
                userUuid: OTHER,
                canManageProject: false,
            }),
        ).toBe(true);
    });

    test('lets any project member view the default rubric whatever its visibility', () => {
        expect(
            canViewChurnScoreConfig({
                config: config({
                    name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
                    visibility: 'private',
                    createdByUserUuid: null,
                }),
                userUuid: OTHER,
                canManageProject: false,
            }),
        ).toBe(true);
    });

    test('hides an unowned private rubric from a plain member', () => {
        expect(
            canViewChurnScoreConfig({
                config: config({
                    visibility: 'private',
                    createdByUserUuid: null,
                }),
                userUuid: OTHER,
                canManageProject: false,
            }),
        ).toBe(false);
    });
});

describe('resolveChurnScoreConfigVisibility', () => {
    test('uses the requested visibility when the caller supplies one', () => {
        expect(
            resolveChurnScoreConfigVisibility({
                requested: 'private',
                activeConfig: config({ visibility: 'public' }),
            }),
        ).toBe('private');
    });

    test('inherits the active version visibility when none is requested', () => {
        expect(
            resolveChurnScoreConfigVisibility({
                requested: undefined,
                activeConfig: config({ visibility: 'private' }),
            }),
        ).toBe('private');
    });

    test('defaults to public for a brand new rubric', () => {
        expect(
            resolveChurnScoreConfigVisibility({
                requested: undefined,
                activeConfig: undefined,
            }),
        ).toBe(Protopie.DEFAULT_CHURN_SCORE_VISIBILITY);
    });

    test('forces the default rubric to stay public', () => {
        expect(
            resolveChurnScoreConfigVisibility({
                requested: 'private',
                activeConfig: config({
                    name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
                    visibility: 'public',
                    createdByUserUuid: null,
                }),
                name: Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME,
            }),
        ).toBe('public');
    });
});
