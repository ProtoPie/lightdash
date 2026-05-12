import { subject } from '@casl/ability';
import { ForbiddenError, type SessionUser } from '@lightdash/common';
import { BaseService } from '../../services/BaseService';
import {
    ProtopieOrganizationSettingsModel,
    type ProtopieOrganizationSettings,
} from '../models/OrganizationSettingsModel';

export class SettingsService extends BaseService {
    private readonly organizationSettingsModel: ProtopieOrganizationSettingsModel;

    constructor({
        organizationSettingsModel,
    }: {
        organizationSettingsModel: ProtopieOrganizationSettingsModel;
    }) {
        super();
        this.organizationSettingsModel = organizationSettingsModel;
    }

    async getMcpSettings({
        user,
    }: {
        user: SessionUser;
    }): Promise<ProtopieOrganizationSettings | undefined> {
        const organizationUuid = this.requireManageOrganization(user);
        return this.organizationSettingsModel.get(organizationUuid);
    }

    async updateMcpSettings({
        user,
        mcpWriteEnabled,
    }: {
        user: SessionUser;
        mcpWriteEnabled: boolean;
    }): Promise<ProtopieOrganizationSettings> {
        const organizationUuid = this.requireManageOrganization(user);
        return this.organizationSettingsModel.upsert({
            organizationUuid,
            mcpWriteEnabled,
            userUuid: user.userUuid,
        });
    }

    private requireManageOrganization(user: SessionUser): string {
        if (!user.organizationUuid) {
            throw new ForbiddenError(
                'Protopie settings require an organization-scoped user.',
            );
        }

        const ability = this.createAuditedAbility(user);
        if (
            ability.cannot(
                'manage',
                subject('Organization', {
                    organizationUuid: user.organizationUuid,
                }),
            )
        ) {
            throw new ForbiddenError();
        }

        return user.organizationUuid;
    }
}
