import { Ability } from '@casl/ability';
import {
    ForbiddenError,
    type PossibleAbilities,
    type SessionUser,
} from '@lightdash/common';
import { user as baseUser } from '../../services/ProjectService/ProjectService.mock';
import { type ProtopiePageViewModel } from '../models/PageViewModel';
import { PageViewService } from './PageViewService';

const projectUuid = '00000000-0000-0000-0000-00000000aaaa';

const makeService = () => {
    const pageViewModel = { insert: jest.fn().mockResolvedValue(undefined) };
    const service = new PageViewService({
        pageViewModel: pageViewModel as unknown as ProtopiePageViewModel,
    });
    return { service, pageViewModel };
};

const viewer: SessionUser = {
    ...baseUser,
    organizationUuid: '00000000-0000-0000-0000-00000000bbbb',
    ability: new Ability<PossibleAbilities>([
        { subject: 'Project', action: ['view'] },
    ]),
};

describe('PageViewService.recordChurnPageView', () => {
    it('inserts a row stamped with the session user', async () => {
        const { service, pageViewModel } = makeService();

        await service.recordChurnPageView({
            projectUuid,
            user: viewer,
            input: {
                page: 'churn_account',
                accountKey: 'https://acme.protopie.cloud',
            },
        });

        expect(pageViewModel.insert).toHaveBeenCalledWith({
            projectUuid,
            userUuid: baseUser.userUuid,
            page: 'churn_account',
            accountKey: 'https://acme.protopie.cloud',
        });
    });

    it('throws ForbiddenError and inserts nothing when the user cannot view the project', async () => {
        const { service, pageViewModel } = makeService();
        const outsider: SessionUser = {
            ...viewer,
            ability: new Ability<PossibleAbilities>([]),
        };

        await expect(
            service.recordChurnPageView({
                projectUuid,
                user: outsider,
                input: { page: 'churn_list', accountKey: null },
            }),
        ).rejects.toThrow(ForbiddenError);
        expect(pageViewModel.insert).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError for a user without an organization', async () => {
        const { service, pageViewModel } = makeService();
        const noOrg: SessionUser = { ...viewer, organizationUuid: undefined };

        await expect(
            service.recordChurnPageView({
                projectUuid,
                user: noOrg,
                input: { page: 'churn_list', accountKey: null },
            }),
        ).rejects.toThrow(ForbiddenError);
        expect(pageViewModel.insert).not.toHaveBeenCalled();
    });
});
