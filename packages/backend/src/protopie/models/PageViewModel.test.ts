import knex, { type Knex } from 'knex';
import { getTracker, MockClient, type Tracker } from 'knex-mock-client';
import { ProtopiePageViewModel } from './PageViewModel';

describe('ProtopiePageViewModel', () => {
    const database = knex({ client: MockClient, dialect: 'pg' });
    const model = new ProtopiePageViewModel({
        database: database as unknown as Knex,
    });
    let tracker: Tracker;

    beforeAll(() => {
        tracker = getTracker();
    });

    afterEach(() => {
        tracker.reset();
    });

    it('inserts a list view with a null account key', async () => {
        tracker.on
            .insert(({ sql }) => sql.includes('protopie_page_views'))
            .responseOnce([]);

        await model.insert({
            projectUuid: '00000000-0000-0000-0000-000000000001',
            userUuid: '00000000-0000-0000-0000-000000000002',
            page: 'churn_list',
            accountKey: null,
        });

        expect(tracker.history.insert).toHaveLength(1);
        expect(tracker.history.insert[0].bindings).toEqual([
            null,
            'churn_list',
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
        ]);
    });

    it('inserts an account view with the account key', async () => {
        tracker.on
            .insert(({ sql }) => sql.includes('protopie_page_views'))
            .responseOnce([]);

        await model.insert({
            projectUuid: '00000000-0000-0000-0000-000000000001',
            userUuid: '00000000-0000-0000-0000-000000000002',
            page: 'churn_account',
            accountKey: 'https://acme.protopie.cloud',
        });

        expect(tracker.history.insert[0].bindings).toEqual([
            'https://acme.protopie.cloud',
            'churn_account',
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
        ]);
    });
});
