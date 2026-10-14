# Churn Page Views (usage tracking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record one row per entry into a Protopie churn page (list or account detail) so daily visits and distinct users can be counted with one SQL query.

**Architecture:** The frontend fires a fire-and-forget `POST .../protopie/churn/views` once per page mount (React `useEffect`), so infinite scroll, filters and refetches never add rows. The backend checks the user can view the project and inserts into a new `protopie_page_views` table. "Visit" is defined at query time: consecutive rows from one user within 30 minutes count as one visit.

**Tech Stack:** Knex migration (Postgres), TSOA controller, `knex-mock-client` + Jest for backend tests, React 19 + TanStack Query (frontend), `pnpm generate-api`.

**Spec:** No separate spec file. The agreed requirements (conversation, 2026-10-14):

1. Infinite scroll, filter/sort changes and window-focus refetches on the list page must NOT count. Entering the page counts.
2. A user entering the tab twice in one day counts as two visits. Entering, bouncing list ↔ account detail, then leaving is one visit.
3. Reporting is per day: visits and distinct users. psql is enough; no UI, no dashboard.
4. All code lives under `packages/*/src/protopie/` (isolation rule). No Lightdash core files are touched.
5. Load is negligible (hundreds of inserts/day). No partitioning, no retention job.

## Global Constraints

- All new files under `packages/backend/src/protopie/`, `packages/common/src/protopie/`, `packages/frontend/src/protopie/`. Do not edit any file outside those folders except `docs/`.
- Table name is `protopie_page_views`, registered in `ProtopieTableName` as `PageViews`.
- Page identifiers are exactly `'churn_list'` and `'churn_account'` (string literal union in common, CHECK constraint in Postgres).
- Use `null` for an absent `accountKey`, never omit the property (repo style: explicit null over optional).
- The POST is best-effort on the frontend: errors are swallowed, no toast, no retry.
- Branch: `feat/churn-page-views` off `main`. Commit messages follow `feat(protopie/churn): ...` and end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run `pnpm generate-api` after the controller change and commit the generated files.

## Review Focus

1. **User without `view` on the project posts a view** → expect 403 and no row. Pinned by the `PageViewService` test (Task 3).
2. **Body with an unknown `page` value** (e.g. `"rubric"`) → expect 422 from TSOA validation and, if it ever bypasses TSOA, a Postgres CHECK violation. Pinned by the manual curl step in Task 4 and the CHECK constraint in Task 1.
3. **Account detail page with an empty `accountKey`** → no row is posted; a key that fails URL decoding falls back to the raw param and IS posted (pre-existing page behavior). The page must still render. Pinned by the hook's early return in Task 5.
4. **Navigating detail A → detail B without leaving the detail route** → two rows (one per `accountKey`). Pinned by the effect dependency list in Task 5 and the manual psql check.
5. **Backend down or POST failing** → the churn page must render exactly as before. Pinned by the `.catch(() => {})` in Task 5 and verified manually by posting with the API stopped is NOT required; code review of the catch is sufficient.

---

### Task 1: Migration + table name

**Files:**
- Modify: `packages/backend/src/protopie/models/tableNames.ts`
- Create: `packages/backend/src/protopie/database/migrations/20261014000000_create_protopie_page_views.ts`

**Interfaces:**
- Produces: `ProtopieTableName.PageViews === 'protopie_page_views'`; columns `view_id bigserial PK`, `project_uuid uuid NOT NULL FK projects ON DELETE CASCADE`, `user_uuid uuid NULL FK users ON DELETE SET NULL`, `page text NOT NULL CHECK IN ('churn_list','churn_account')`, `account_key text NULL`, `viewed_at timestamptz NOT NULL DEFAULT now()`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/sol/Desktop/XID/lightdash
git checkout -b feat/churn-page-views main
```

- [ ] **Step 2: Add the table name**

In `packages/backend/src/protopie/models/tableNames.ts` add one entry at the end of the object:

```ts
    ChurnScores: 'protopie_churn_score',
    PageViews: 'protopie_page_views',
} as const;
```

- [ ] **Step 3: Write the migration**

Create `packages/backend/src/protopie/database/migrations/20261014000000_create_protopie_page_views.ts`:

```ts
import { type Knex } from 'knex';
import { ProtopieTableName } from '../../models/tableNames';

/**
 * One row per entry into a Protopie churn page (list or account detail).
 * Written by the frontend on page mount, read only by ad-hoc SQL for usage
 * reporting. "Visit" is derived at query time (30-minute gap rule), so this
 * table stores raw events, not sessions.
 *
 * user_uuid is nullable with ON DELETE SET NULL so counts survive user
 * deletion; project_uuid cascades because views of a deleted project are
 * meaningless.
 */
export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable(ProtopieTableName.PageViews, (table) => {
        table.bigIncrements('view_id');
        table
            .uuid('project_uuid')
            .notNullable()
            .references('project_uuid')
            .inTable('projects')
            .onDelete('CASCADE');
        table
            .uuid('user_uuid')
            .nullable()
            .references('user_uuid')
            .inTable('users')
            .onDelete('SET NULL');
        table.text('page').notNullable();
        table.text('account_key').nullable();
        table
            .timestamp('viewed_at', { useTz: true })
            .notNullable()
            .defaultTo(knex.fn.now());
    });

    await knex.raw(`
        ALTER TABLE ${ProtopieTableName.PageViews}
            ADD CONSTRAINT protopie_page_views_page_check
            CHECK (page IN ('churn_list', 'churn_account'))
    `);
    await knex.raw(`
        CREATE INDEX protopie_page_views_project_viewed_idx
            ON ${ProtopieTableName.PageViews} (project_uuid, viewed_at DESC)
    `);
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTableIfExists(ProtopieTableName.PageViews);
}
```

- [ ] **Step 4: Run the migration and inspect the table**

```bash
pnpm -F backend migrate
psql -c "\d protopie_page_views"
```

Expected: the `\d` output lists the six columns, the `protopie_page_views_page_check` constraint, the index `protopie_page_views_project_viewed_idx`, and two FK constraints.

- [ ] **Step 5: Verify the CHECK constraint rejects a bad page**

```bash
psql -c "INSERT INTO protopie_page_views (project_uuid, page, account_key) SELECT project_uuid, 'rubric', NULL FROM projects LIMIT 1;"
```

Expected: `ERROR:  new row for relation "protopie_page_views" violates check constraint "protopie_page_views_page_check"`.

- [ ] **Step 6: Verify rollback and re-apply**

```bash
pnpm -F backend rollback-last
psql -c "\d protopie_page_views"   # Expected: Did not find any relation
pnpm -F backend migrate
```

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/protopie/models/tableNames.ts packages/backend/src/protopie/database/migrations/20261014000000_create_protopie_page_views.ts
git commit -m "feat(protopie/churn): add protopie_page_views table

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `ProtopiePageViewModel`

**Files:**
- Create: `packages/backend/src/protopie/models/PageViewModel.ts`
- Test: `packages/backend/src/protopie/models/PageViewModel.test.ts`

**Interfaces:**
- Consumes: `ProtopieTableName.PageViews` (Task 1).
- Produces:
  ```ts
  export type ProtopiePageViewInsert = {
      projectUuid: string;
      userUuid: string;
      page: 'churn_list' | 'churn_account';
      accountKey: string | null;
  };
  export class ProtopiePageViewModel {
      constructor({ database }: { database: Knex });
      insert(entry: ProtopiePageViewInsert): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/protopie/models/PageViewModel.test.ts`:

```ts
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
```

Note: knex sorts insert columns alphabetically (`account_key, page, project_uuid, user_uuid`), which is why the bindings are in that order.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F backend test -- src/protopie/models/PageViewModel.test.ts
```

Expected: FAIL with `Cannot find module './PageViewModel'`.

- [ ] **Step 3: Write the model**

Create `packages/backend/src/protopie/models/PageViewModel.ts`:

```ts
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
```

`Protopie.ChurnPageViewPage` does not exist yet; add it now so the model compiles. In `packages/common/src/protopie/churnScore/types.ts` append at the end of the file:

```ts
/**
 * Pages whose entries are recorded in `protopie_page_views` for usage
 * reporting. Keep in sync with the CHECK constraint in the
 * `create_protopie_page_views` migration.
 */
export type ChurnPageViewPage = 'churn_list' | 'churn_account';

export type ChurnPageViewInput = {
    page: ChurnPageViewPage;
    /** Account opened on the detail page; null on the list page. */
    accountKey: string | null;
};
```

Then rebuild common so the backend sees the type:

```bash
pnpm -F common build
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F backend test -- src/protopie/models/PageViewModel.test.ts
```

Expected: PASS (2 tests). If the binding order differs, print `tracker.history.insert[0].sql`, confirm the column order knex produced, and fix the expectation to match, since the order is knex's not ours.

- [ ] **Step 5: Typecheck common and backend**

```bash
pnpm -F common typecheck
pnpm -F backend typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/common/src/protopie/churnScore/types.ts packages/backend/src/protopie/models/PageViewModel.ts packages/backend/src/protopie/models/PageViewModel.test.ts
git commit -m "feat(protopie/churn): page view model + shared ChurnPageViewInput type

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `PageViewService` with project-view check, wired into `getProtopieServices`

**Files:**
- Create: `packages/backend/src/protopie/services/PageViewService.ts`
- Test: `packages/backend/src/protopie/services/PageViewService.test.ts`
- Modify: `packages/backend/src/protopie/services/index.ts`

**Interfaces:**
- Consumes: `ProtopiePageViewModel.insert` (Task 2), `Protopie.ChurnPageViewInput` (Task 2).
- Produces:
  ```ts
  export class PageViewService extends BaseService {
      constructor({ pageViewModel }: { pageViewModel: ProtopiePageViewModel });
      recordChurnPageView(args: {
          projectUuid: string;
          user: SessionUser;
          input: Protopie.ChurnPageViewInput;
      }): Promise<void>;
  }
  ```
  and `getProtopieServices(repo).pageViewService`, `getProtopieModels(repo).pageViewModel`.

- [ ] **Step 1: Write the failing test**

Create `packages/backend/src/protopie/services/PageViewService.test.ts`:

```ts
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
            input: { page: 'churn_account', accountKey: 'https://acme.protopie.cloud' },
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F backend test -- src/protopie/services/PageViewService.test.ts
```

Expected: FAIL with `Cannot find module './PageViewService'`.

- [ ] **Step 3: Write the service**

Create `packages/backend/src/protopie/services/PageViewService.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F backend test -- src/protopie/services/PageViewService.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Wire the model and service into the Protopie repository adapter**

Edit `packages/backend/src/protopie/services/index.ts`:

Add imports (keep alphabetical with the existing ones):

```ts
import { ProtopiePageViewModel } from '../models/PageViewModel';
import { PageViewService } from './PageViewService';
```

Add to `ProtopieModels`:

```ts
    churnScoreRunModel: ChurnScoreRunModel;
    pageViewModel: ProtopiePageViewModel;
};
```

Add to `ProtopieServices`:

```ts
    churnScoreService: ChurnScoreService;
    pageViewService: PageViewService;
};
```

Add to the object built inside `getProtopieModels`, after `churnScoreRunModel`:

```ts
            pageViewModel: new ProtopiePageViewModel({
                database: repository.database,
            }),
```

Add to the object built inside `getProtopieServices`, after `churnScoreService: new ChurnScoreService({...})`:

```ts
            pageViewService: new PageViewService({
                pageViewModel: models.pageViewModel,
            }),
```

- [ ] **Step 6: Typecheck and lint the backend**

```bash
pnpm -F backend typecheck
pnpm -F backend lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/backend/src/protopie/services/PageViewService.ts packages/backend/src/protopie/services/PageViewService.test.ts packages/backend/src/protopie/services/index.ts
git commit -m "feat(protopie/churn): PageViewService with project-view guard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `POST /api/v1/projects/{projectUuid}/protopie/churn/views`

**Files:**
- Modify: `packages/backend/src/protopie/controllers/ChurnScoreController.ts` (imports at lines 1-6; add a method after `recompute`, which ends around line 404)
- Generated: whatever `pnpm generate-api` touches (`packages/backend/src/generated/routes.ts`, `packages/backend/src/generated/swagger.json`)

**Interfaces:**
- Consumes: `getProtopieServices(this.services).pageViewService.recordChurnPageView` (Task 3), `Protopie.ChurnPageViewInput` (Task 2).
- Produces: `POST /api/v1/projects/{projectUuid}/protopie/churn/views`, body `{ page: 'churn_list' | 'churn_account', accountKey: string | null }`, response `201 { status: 'ok', results: undefined }`. OperationId `RecordProtopieChurnPageView`.

- [ ] **Step 1: Add `ApiSuccessEmpty` to the common import**

In `packages/backend/src/protopie/controllers/ChurnScoreController.ts` the first import block from `@lightdash/common` currently includes `assertRegisteredAccount` and the `ApiSuccess` / `ApiErrorPayload` types. Add `ApiSuccessEmpty` to that list (plain import, matching the existing style), keeping alphabetical order.

- [ ] **Step 2: Add the endpoint**

Insert immediately after the `recompute` method (after its closing `}` and before the `/** List available product event names ... */` doc comment):

```ts
    /**
     * Record that the current user opened a churn page. Fired once per page
     * mount by the frontend; used only for usage reporting.
     * @summary Record Protopie churn page view
     */
    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse('201', 'Created')
    @Post('views')
    @OperationId('RecordProtopieChurnPageView')
    async recordPageView(
        @Path() projectUuid: string,
        @Body() body: Protopie.ChurnPageViewInput,
        @Request() req: express.Request,
    ): Promise<ApiSuccessEmpty> {
        assertRegisteredAccount(req.account);
        this.setStatus(201);

        await getProtopieServices(this.services).pageViewService.recordChurnPageView({
            projectUuid,
            user: toSessionUser(req.account),
            input: body,
        });

        return { status: 'ok', results: undefined };
    }
```

- [ ] **Step 3: Regenerate the API and typecheck**

```bash
pnpm generate-api
pnpm -F backend typecheck
pnpm -F backend lint
```

Expected: `generate-api` completes; `git status` shows the generated routes/swagger changed; no type or lint errors.

- [ ] **Step 4: Manually verify against the running dev server**

`$LDPAT` and `$SITE_URL` are the local PAT and base URL (see CLAUDE.md). Pick the project UUID that owns the churn pages:

```bash
PROJECT=$(psql -tA -c "SELECT project_uuid FROM projects ORDER BY created_at LIMIT 1")
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: ApiKey $LDPAT" -H "Content-Type: application/json" \
  -d '{"page":"churn_list","accountKey":null}' \
  "$SITE_URL/api/v1/projects/$PROJECT/protopie/churn/views"
```

Expected: `201`.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H "Authorization: ApiKey $LDPAT" -H "Content-Type: application/json" \
  -d '{"page":"rubric","accountKey":null}' \
  "$SITE_URL/api/v1/projects/$PROJECT/protopie/churn/views"
```

Expected: `422` (TSOA ValidateError; this backend maps it to 422).

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -d '{"page":"churn_list","accountKey":null}' \
  "$SITE_URL/api/v1/projects/$PROJECT/protopie/churn/views"
```

Expected: `401` (no auth).

```bash
psql -c "SELECT page, account_key, user_uuid IS NOT NULL AS has_user, viewed_at FROM protopie_page_views ORDER BY view_id DESC LIMIT 3;"
```

Expected: exactly one row, `churn_list`, `account_key` NULL, `has_user` true.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/protopie/controllers/ChurnScoreController.ts packages/backend/src/generated
git commit -m "feat(protopie/churn): expose POST /churn/views for page-view recording

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Frontend hook, wired into both churn pages

**Files:**
- Modify: `packages/frontend/src/protopie/api.ts` (imports at top; new hook at end of file)
- Modify: `packages/frontend/src/protopie/ProtopieChurnScoresPage.tsx:90` (right after `const projectUuid = useProjectUuid();`)
- Modify: `packages/frontend/src/protopie/ProtopieChurnScoreAccountDetailsPage.tsx:148` (right after the `decodedAccountKey` memo)

**Interfaces:**
- Consumes: `POST /projects/{projectUuid}/protopie/churn/views` (Task 4), `Protopie.ChurnPageViewPage` (Task 2), `lightdashApi` from `packages/frontend/src/api.ts`.
- Produces:
  ```ts
  export const useProtopieChurnPageView: (args: {
      projectUuid: string | undefined;
      page: Protopie.ChurnPageViewPage;
      accountKey: string | null;
  }) => void;
  ```

- [ ] **Step 1: Add the hook**

In `packages/frontend/src/protopie/api.ts`, add `useEffect` to the imports:

```ts
import { useEffect } from 'react';
```

Append at the end of the file:

```ts
/**
 * Records one page view per mount for usage reporting. Depends only on the
 * page identity, so list-page scrolling, filtering and refetching never
 * re-fire it; opening a different account on the detail page does.
 */
export const useProtopieChurnPageView = ({
    projectUuid,
    page,
    accountKey,
}: {
    projectUuid: string | undefined;
    page: Protopie.ChurnPageViewPage;
    accountKey: string | null;
}) => {
    useEffect(() => {
        if (!projectUuid) return;
        if (page === 'churn_account' && !accountKey) return;

        lightdashApi<AnyType>({
            method: 'POST',
            url: `/projects/${projectUuid}/protopie/churn/views`,
            body: JSON.stringify({ page, accountKey }),
        }).catch(() => {
            // Best-effort telemetry: never surface a failure to the user.
        });
    }, [projectUuid, page, accountKey]);
};
```

- [ ] **Step 2: Call it from the list page**

In `packages/frontend/src/protopie/ProtopieChurnScoresPage.tsx`, extend the existing `./api` import to include `useProtopieChurnPageView`, then directly after `const projectUuid = useProjectUuid();` add:

```ts
    useProtopieChurnPageView({ projectUuid, page: 'churn_list', accountKey: null });
```

- [ ] **Step 3: Call it from the account detail page**

In `packages/frontend/src/protopie/ProtopieChurnScoreAccountDetailsPage.tsx`, extend the existing `./api` import to include `useProtopieChurnPageView`, then directly after the `decodedAccountKey` `useMemo` block add:

```ts
    useProtopieChurnPageView({
        projectUuid,
        page: 'churn_account',
        accountKey: decodedAccountKey ?? null,
    });
```

- [ ] **Step 4: Typecheck and lint the frontend**

```bash
pnpm -F frontend typecheck
pnpm -F frontend lint
```

Expected: no errors. If lint flags the floating promise, the `.catch` is already attached; if it still complains, prefix the call with `void`.

- [ ] **Step 5: Verify in the browser**

Use the Chrome DevTools MCP (login `demo@lightdash.com` / `demo_password!`), then:

1. Note the current row count: `psql -tA -c "SELECT count(*) FROM protopie_page_views"`.
2. Open `/projects/<PROJECT>/protopie/churn/scores`. Scroll to the bottom twice, change the risk-band filter, type in the search box.
3. Re-run the count. Expected: exactly +1.
4. Click into one account, then use the back link, then click into a different account.
5. Re-run the count. Expected: +3 more (account A, list, account B). Check with:
   ```bash
   psql -c "SELECT page, account_key, viewed_at FROM protopie_page_views ORDER BY view_id DESC LIMIT 4;"
   ```
6. Reload the detail page once. Expected: +1 row for the same account.

If the local Vite dev server runs React in StrictMode, each mount may post twice in dev only. Confirm by checking whether rows arrive in pairs; production builds do not double-invoke effects, so this is acceptable and should be noted in the PR, not fixed.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/protopie/api.ts packages/frontend/src/protopie/ProtopieChurnScoresPage.tsx packages/frontend/src/protopie/ProtopieChurnScoreAccountDetailsPage.tsx
git commit -m "feat(protopie/churn): record a page view on list/detail mount

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Reporting query in the backend logic guide

**Files:**
- Modify: `docs/protopie-docs/18-churn-backend-logic-guide.md` (append a section at the end)

- [ ] **Step 1: Append the section**

Append to `docs/protopie-docs/18-churn-backend-logic-guide.md`:

````markdown
## Page-view usage reporting

Every mount of the churn list page or an account detail page inserts one row
into `protopie_page_views` (`POST /api/v1/projects/{projectUuid}/protopie/churn/views`,
fired by `useProtopieChurnPageView` in `packages/frontend/src/protopie/api.ts`).
Scrolling, filtering and background refetches do not insert rows.

A **visit** is derived at query time: consecutive rows from the same user with
less than 30 minutes between them are one visit. Change the interval in the
query, not in code.

```sql
WITH gaps AS (
    SELECT user_uuid,
           page,
           viewed_at,
           viewed_at - lag(viewed_at) OVER (
               PARTITION BY user_uuid ORDER BY viewed_at
           ) AS gap
    FROM protopie_page_views
    WHERE viewed_at >= now() - interval '90 days'
)
SELECT viewed_at::date                                             AS day,
       count(*) FILTER (WHERE gap IS NULL OR gap > interval '30 min') AS visits,
       count(DISTINCT user_uuid)                                   AS users,
       count(*) FILTER (WHERE page = 'churn_account')              AS accounts_opened
FROM gaps
GROUP BY 1
ORDER BY 1;
```

Rows before the deploy that introduced this table do not exist; for earlier
periods use CloudWatch request counts (`/ecs/lightdash-log-groups`, filter on
`protopie/churn/scores/`), which count API calls rather than visits.
````

- [ ] **Step 2: Run the query locally against the rows created in Task 5**

```bash
psql -f <(sed -n '/^WITH gaps AS/,/^ORDER BY 1;/p' docs/protopie-docs/18-churn-backend-logic-guide.md)
```

Expected: one row for today with `visits = 1` (all Task 5 rows are within 30 minutes), `users = 1`, `accounts_opened = 3` (or 6 if StrictMode doubled them).

- [ ] **Step 3: Commit**

```bash
git add docs/protopie-docs/18-churn-backend-logic-guide.md
git commit -m "docs(protopie/churn): page-view usage reporting query

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the full protopie backend tests and all typechecks**

```bash
pnpm -F backend test -- src/protopie
pnpm -F common typecheck && pnpm -F backend typecheck && pnpm -F frontend typecheck
pnpm -F common lint && pnpm -F backend lint && pnpm -F frontend lint
```

Expected: all pass.

- [ ] **Step 2: Confirm the isolation rule held**

```bash
git diff --stat main...HEAD -- . ':!packages/*/src/protopie' ':!packages/backend/src/generated' ':!docs'
```

Expected: empty output (no file outside the Protopie folders, generated API, or docs was touched).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/churn-page-views
```

PR body: summarize the table, the endpoint, the mount-only hook, the 30-minute visit rule, and the StrictMode dev-only double-post note. End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
