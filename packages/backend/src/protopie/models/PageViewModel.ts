import { type Protopie } from '@lightdash/common';
import { type Knex } from 'knex';
import { ProtopieTableName } from './tableNames';

export type ProtopiePageViewInsert = {
    projectUuid: string;
    userUuid: string;
    page: Protopie.ChurnPageViewPage;
    accountKey: string | null;
};

export class ProtopiePageViewModel {
    private readonly database: Knex;

    constructor({ database }: { database: Knex }) {
        this.database = database;
    }

    async insert(entry: ProtopiePageViewInsert): Promise<void> {
        await this.database(ProtopieTableName.PageViews).insert({
            project_uuid: entry.projectUuid,
            user_uuid: entry.userUuid,
            page: entry.page,
            account_key: entry.accountKey,
        });
    }
}
