import { Protopie } from '@lightdash/common';

/** The subset of a rubric row every visibility decision needs. */
type ChurnScoreConfigIdentity = Pick<
    Protopie.ChurnScoreConfig,
    'name' | 'visibility' | 'createdByUserUuid'
>;

const isDefaultName = (name: string): boolean =>
    name === Protopie.DEFAULT_CHURN_SCORE_CONFIG_NAME;

/**
 * Read policy for a rubric and the scores computed with it.
 *
 * Deliberately pure: the caller resolves `canManageProject` from CASL and this
 * function holds the policy, so the whole matrix is unit-testable without a
 * database or an ability instance.
 *
 * Note this governs READS only. Editing stays owner-or-admin (see
 * `ChurnScoreService.requireConfigEdit`) — making a rubric public shares it,
 * it does not hand over the pen.
 */
export const canViewChurnScoreConfig = ({
    config,
    userUuid,
    canManageProject,
}: {
    config: ChurnScoreConfigIdentity;
    userUuid: string;
    canManageProject: boolean;
}): boolean =>
    isDefaultName(config.name) ||
    config.visibility === 'public' ||
    config.createdByUserUuid === userUuid ||
    canManageProject;

/**
 * Visibility a rubric version should be written with.
 *
 * Visibility is a property of the rubric (its name), not of one version, so a
 * new or restored version inherits the currently active version's value rather
 * than resurrecting a stale one. An explicit `requested` value wins, except on
 * the default rubric which is pinned public.
 */
export const resolveChurnScoreConfigVisibility = ({
    requested,
    activeConfig,
    name,
}: {
    requested: Protopie.ChurnScoreConfigVisibility | undefined;
    activeConfig: ChurnScoreConfigIdentity | undefined;
    name?: string;
}): Protopie.ChurnScoreConfigVisibility => {
    const rubricName = name ?? activeConfig?.name;
    if (rubricName !== undefined && isDefaultName(rubricName)) {
        return 'public';
    }

    return (
        requested ??
        activeConfig?.visibility ??
        Protopie.DEFAULT_CHURN_SCORE_VISIBILITY
    );
};
