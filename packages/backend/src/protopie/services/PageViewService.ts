import { subject } from '@casl/ability';
import {
    ForbiddenError,
    type Protopie,
    type SessionUser,
} from '@lightdash/common';
import { BaseService } from '../../services/BaseService';
import { type ProtopiePageViewModel } from '../models/PageViewModel';

type PageViewServiceArguments = {
    pageViewModel: ProtopiePageViewModel;
};

/**
 * Records page entries for usage reporting. Deliberately thin: the only
 * rule is "you may record a view of a project you can view".
 */
export class PageViewService extends BaseService {
    private readonly pageViewModel: ProtopiePageViewModel;

    constructor({ pageViewModel }: PageViewServiceArguments) {
        super();
        this.pageViewModel = pageViewModel;
    }

    async recordChurnPageView({
        projectUuid,
        user,
        input,
    }: {
        projectUuid: string;
        user: SessionUser;
        input: Protopie.ChurnPageViewInput;
    }): Promise<void> {
        if (!user.organizationUuid) {
            throw new ForbiddenError();
        }
        const ability = this.createAuditedAbility(user);
        if (
            ability.cannot(
                'view',
                subject('Project', {
                    organizationUuid: user.organizationUuid,
                    projectUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }

        await this.pageViewModel.insert({
            projectUuid,
            userUuid: user.userUuid,
            page: input.page,
            accountKey: input.accountKey,
        });
    }
}
