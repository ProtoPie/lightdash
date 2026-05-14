# 05 — Forms System

> **Goal.** A code-defined, schema-driven form framework so sales reps can submit account-level churn score inputs directly inside Lightdash. Submissions land in Postgres (`protopie_form_submissions`) and become first-class dbt sources.
>
> **Non-goal.** A drag-and-drop form builder for non-engineers. Forms are defined in TypeScript with Zod schemas; adding a new form is a code change reviewed via PR. This is intentional — keeps the surface area small, lets dbt model submissions confidently.
>
> **Current POC.** The active registry intentionally exposes one dummy form only: `churn_score_input`. Final fields will be defined later by Sales/CS and implemented by developers.

## Design at a glance

```
┌─────────────────────────────────────────────────────────────────────────┐
│ FORM DEFINITION (code)                                                  │
│   packages/common/src/protopie/forms/schemas/churnScoreInput.ts         │
│      ↓                                                                  │
│   export const churnScoreInputForm = defineForm({                       │
│      key: 'churn_score_input',                                          │
│      version: 1,                                                        │
│      title: 'Churn score input',                                        │
│      fields: { ...Zod-typed fields... },                                │
│      requiresAccount: true                                              │
│   });                                                                   │
└─────────────────────────────────────────────────────────────────────────┘
                          ↓ (imported by both backend and frontend)
┌──────────────────────────┐               ┌──────────────────────────────┐
│ BACKEND                  │               │ FRONTEND                     │
│  FormController          │               │  DynamicForm.tsx renders     │
│  POST /api/v1/protopie/  │ ←—submission—│  schema as Mantine fields    │
│       forms/:key         │               │  with Zod resolver           │
│                          │               └──────────────────────────────┘
│  FormService             │
│   validates → inserts    │
│   → protopie_form_       │
│     submissions          │
└──────────────────────────┘
```

## Defining a form (the developer experience)

```ts
// packages/common/src/protopie/forms/schemas/churnScoreInput.ts
import { z } from 'zod';
import { defineProtopieForm } from '../defineForm';
import {
    accountIdentityFields,
    optionalTrimmedString,
    withAccountIdentity,
} from './accountIdentity';

export const churnScoreInputForm = defineProtopieForm({
    key: 'churn_score_input',
    version: 1,
    title: 'Churn score input',
    description: 'Temporary dummy form for sales-owned churn score inputs.',
    accountIdFields: ['account_key', 'cloud_url', 'salesforce_account_id'],
    schema: withAccountIdentity({
        signal_date: z.string().trim().min(1),
        signal_name: z.string().trim().min(1),
        signal_value: z.number().min(0),
        notes: optionalTrimmedString,
    }),
    fields: [
        ...accountIdentityFields,
        { key: 'signal_date', label: 'Signal date', type: 'date', required: true },
        { key: 'signal_name', label: 'Signal name', type: 'text', required: true },
        { key: 'signal_value', label: 'Signal value', type: 'number', required: true },
        { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
});
```

**`accountIdFields`** names which account identity fields the form exposes. The current backend extracts `account_key`, `cloud_url`, and `salesforce_account_id` from the payload; `account_key` falls back to `cloud_url` or `salesforce_account_id` if the explicit field is empty.

The `defineForm` helper enforces structure and returns both:

- a `z.object(fields)` schema usable by `FormService.validate()`,
- a metadata object usable by the frontend `DynamicForm` renderer.

```ts
// packages/common/src/protopie/forms/defineForm.ts
import { z, ZodRawShape } from 'zod';

export type FormDefinition<F extends ZodRawShape> = {
    key: string;
    version: number;
    title: string;
    description?: string;
    fields: F;
    /** Name of the field whose value becomes the submission's account_key column. */
    accountKeyField: keyof F | null;
    /** Optional secondary identifier extraction. Maps DB column → field name. */
    secondaryKeyFields?: {
        cloud_url?: keyof F;
        salesforce_account_id?: keyof F;
    };
    requiredScope?: string;
    uiHints?: {
        fieldOrder?: Array<keyof F>;
        widgets?: Partial<Record<keyof F, 'text' | 'textarea' | 'radio' | 'select' | 'date'>>;
    };
    schema: z.ZodObject<F>;
};

export function defineForm<F extends ZodRawShape>(
    init: Omit<FormDefinition<F>, 'schema'>,
): FormDefinition<F> {
    return { ...init, schema: z.object(init.fields) };
}
```

The set of all known forms is a registry:

```ts
// packages/common/src/protopie/forms/registry.ts
export const FORM_REGISTRY = {
    [churnScoreInputForm.key]: churnScoreInputForm,
    // ... add new forms here
} as const;

export type FormKey = keyof typeof FORM_REGISTRY;

export function getForm(key: string): FormDefinition<ZodRawShape> | null {
    return (FORM_REGISTRY as Record<string, FormDefinition<ZodRawShape> | undefined>)[key] ?? null;
}
```

## Backend: service + controller

### Service

```ts
// packages/backend/src/protopie/services/FormService.ts
import { BaseService } from '../../services/BaseService';
import { ForbiddenError, ParameterError, SessionUser } from '@lightdash/common';
import { getForm } from '@lightdash/common/protopie/forms/registry';
import type { FormSubmissionModel } from '../models/FormSubmissionModel';

export class FormService extends BaseService {
    constructor(private readonly deps: {
        formSubmissionModel: FormSubmissionModel;
    }) { super(); }

    async submit(args: {
        user: SessionUser;
        projectUuid: string;
        formKey: string;
        payload: unknown;
    }) {
        const form = getForm(args.formKey);
        if (!form) throw new ParameterError(`Unknown form: ${args.formKey}`);
        if (form.requiredScope) {
            this.assertHasScope(args.user, form.requiredScope);
        }
        const validated = form.schema.parse(args.payload);   // throws on invalid input

        // Extract account identity from account_key, cloud_url, salesforce_account_id
        const accountIdentity = FormService.extractAccountIdentity(validated);

        const submission = await this.deps.formSubmissionModel.insert({
            projectUuid: args.projectUuid,
            formDefinitionUuid: definition.formDefinitionUuid, // resolved from the synced protopie_form_definitions row
            formKey: form.key,
            schemaVersion: form.version,
            createdByUserUuid: args.user.userUuid,
            organizationUuid: args.user.organizationUuid!,
            ...accountIdentity,
            payload: validated,
        });
        return submission;
    }

    async list(args: {
        user: SessionUser;
        formKey: string;
        accountKey?: string;
        limit?: number;
        offset?: number;
    }) {
        const form = getForm(args.formKey);
        if (!form) throw new ParameterError(`Unknown form: ${args.formKey}`);
        // assumes org-scoped read by default
        return this.deps.formSubmissionModel.list({
            form_key: form.key,
            organization_uuid: args.user.organizationUuid!,
            account_key: args.accountKey,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
        });
    }

    private assertHasScope(user: SessionUser, scope: string) {
        // implementation: see Lightdash's ability/permission helpers or a Protopie-local check
        // For v1: any authenticated org member can submit. Tighten later.
        if (!user.userUuid) throw new ForbiddenError('Auth required');
    }
}
```

### Controller (TSOA)

```ts
// packages/backend/src/protopie/controllers/FormController.ts
import {
    Body, Controller, Get, Middlewares, OperationId, Path, Post, Query,
    Request, Response, Route, Security, SuccessResponse, Tags,
} from '@tsoa/runtime';
import express from 'express';
import { allowApiKeyAuthentication, isAuthenticated } from '../../controllers/authentication';
import { getProtopieServices } from '../services';

@Route('/api/v1/protopie/forms')
@Tags('Protopie — Forms')
@Response('default', 'Error response')
export class FormController extends Controller {

    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse(201, 'Created')
    @Post('/{formKey}/submissions')
    @OperationId('submitProtopieForm')
    async submit(
        @Request() req: express.Request,
        @Path() formKey: string,
        @Body() body: { payload: unknown; accountKey?: string; projectUuid?: string; notes?: string },
    ) {
        const services = getProtopieServices(req);
        const submission = await services.formService.submit({
            user: req.user!,
            formKey,
            payload: body.payload,
            accountKey: body.accountKey,
            projectUuid: body.projectUuid,
            notes: body.notes,
        });
        this.setStatus(201);
        return { status: 'ok' as const, results: submission };
    }

    @Middlewares([allowApiKeyAuthentication, isAuthenticated])
    @SuccessResponse(200, 'Listed')
    @Get('/{formKey}/submissions')
    async list(
        @Request() req: express.Request,
        @Path() formKey: string,
        @Query() accountKey?: string,
        @Query() limit?: number,
        @Query() offset?: number,
    ) {
        const services = getProtopieServices(req);
        const items = await services.formService.list({
            user: req.user!,
            formKey,
            accountKey,
            limit, offset,
        });
        return { status: 'ok' as const, results: items };
    }

    @Get('/schemas')
    async listSchemas() {
        // public-ish, but still auth-gated; returns form definitions for the frontend
        return { status: 'ok' as const, results: Object.values(FORM_REGISTRY).map(toClientShape) };
    }
}
```

> **Important.** The controller is named `*Controller.ts` and lives under `src/protopie/controllers/`. The TSOA glob `src/**/*Controller.ts` picks it up **automatically**. No edit to `tsoa.yml` is needed. After creating it, run `pnpm generate-api` to refresh `routes.ts` and OpenAPI.

### Model

```ts
// packages/backend/src/protopie/models/FormSubmissionModel.ts
import { Knex } from 'knex';

const TABLE = 'protopie_form_submissions';

export class FormSubmissionModel {
    constructor(private readonly deps: { database: Knex }) {}

    async insert(row: {
        formKey: string;
        schemaVersion: number;
        createdByUserUuid: string;
        organizationUuid: string;
        projectUuid: string;
        formDefinitionUuid: string;
        accountKey: string | null;
        cloudUrl: string | null;
        salesforceAccountId: string | null;
        payload: unknown;
    }) {
        const [submission] = await this.deps.database(TABLE)
            .insert(row)
            .returning('*');
        return submission;
    }

    async list(filter: {
        formKey: string;
        organizationUuid: string;
        accountKey?: string;
        limit: number;
        offset: number;
    }) {
        const q = this.deps.database(TABLE)
            .where('form_key', filter.formKey)
            .andWhere('organization_uuid', filter.organizationUuid)
            .andWhere(function () { this.whereNull('deleted_at'); });
        if (filter.accountKey) q.andWhere('account_key', filter.accountKey);
        return q.orderBy('created_at', 'desc')
            .limit(filter.limit).offset(filter.offset);
    }

    async softDelete(submissionUuid: string) {
        return this.deps.database(TABLE)
            .where('form_submission_uuid', submissionUuid)
            .update({ deleted_at: this.deps.database.fn.now() });
    }
}
```

## Frontend: dynamic form renderer

The `DynamicForm` React component takes a `FormDefinition` and renders Mantine fields:

```tsx
// packages/frontend/src/protopie/components/DynamicForm.tsx
import { useForm, zodResolver } from '@mantine/form';
import { TextInput, Textarea, Radio, Stack, Button } from '@mantine-8/core';
import type { FormDefinition } from '@lightdash/common/protopie/forms/defineForm';

export function DynamicForm<F extends Record<string, unknown>>({
    definition, onSubmit, defaultValues,
}: {
    definition: FormDefinition<any>;
    onSubmit: (values: F) => Promise<void>;
    defaultValues?: Partial<F>;
}) {
    const form = useForm({
        initialValues: defaultValues ?? {},
        validate: zodResolver(definition.schema),
    });

    const ordered = definition.uiHints?.fieldOrder ?? Object.keys(definition.fields);

    return (
        <form onSubmit={form.onSubmit(async (v) => onSubmit(v as F))}>
            <Stack gap="md">
                {ordered.map((key) => renderField(definition, key as string, form))}
                <Button type="submit" loading={form.submitting}>Submit</Button>
            </Stack>
        </form>
    );
}
```

`renderField` switches on the Zod type + ui hint:

- `z.string` + textarea hint → `<Textarea />`
- `z.enum` + radio hint → `<Radio.Group />`
- `z.date` → Mantine `<DateInput />`
- `z.boolean` → `<Switch />`
- etc.

Adding a new field type means adding a case to `renderField`. Keep this list short; if a form needs something custom, write a bespoke page instead of contorting `DynamicForm`.

### Submit hook

```ts
// packages/frontend/src/protopie/hooks/useSubmitForm.ts
import { useMutation } from '@tanstack/react-query';
import { protopieApi } from '../api/protopieApi';

export function useSubmitForm(formKey: string) {
    return useMutation({
        mutationFn: (vars: { payload: unknown; accountKey?: string; projectUuid?: string }) =>
            protopieApi.submitForm(formKey, vars),
    });
}
```

`protopieApi.submitForm` is a thin wrapper over `fetch` reusing Lightdash's `BASE_API_URL` and `getDefaultHeaders()` from `packages/frontend/src/api.ts`.

## Submissions as a dbt source

dbt declares the Postgres app DB as a source pointing at `protopie_form_submissions`. From there, one mart per form key:

```sql
-- dbt/models/marts/protopie/mart_churn_score_form_inputs.sql
select
    form_submission_uuid,
    created_at,
    created_by_user_uuid,
    account_key,
    (payload->>'signal_date')::date       as signal_date,
    payload->>'signal_name'               as signal_name,
    (payload->>'signal_value')::numeric   as signal_value,
    payload->>'notes'                     as notes
from {{ source('protopie_postgres', 'protopie_form_submissions') }}
where form_key = 'churn_score_input'
  and deleted_at is null
```

When a new field is added to the form schema, dbt's mart also needs an update (extract the new key from JSONB). This is the same drift risk we have on the churn-rules side; the same review discipline applies.

## Read patterns the dashboards use

- "Last touchpoint per Account": window function over `mart_sales_touchpoints`.
- "Negative-sentiment touchpoints in last 30 days": filter on `sentiment = 'negative' AND meeting_date > today - 30`.
- These become dimensions/metrics in the Lightdash explore for `mart_sales_touchpoints`.

## Permissions matrix (v1 — locked)

The user's request says sales should "make form so sales team make form and inserts data". Two readings:

- **(a)** Sales literally builds form definitions in a UI (à la Google Forms).
- **(b)** Sales fills out engineer-defined forms.

**v1 decision: (b) only.** Engineers define form schemas in code (`packages/common/src/protopie/forms/schemas/*.ts`); sales submits them. Reasons:

1. Schema-driven forms guarantee `account_key` extraction, validation, and dbt readability — critical for Churn Score correctness. A drag-and-drop form builder would surface arbitrary fields that dbt can't model without follow-up engineering.
2. v1 has 3 forms (touchpoint, renewal, override). Building a form-builder UI for 3 forms is over-engineering.

If sales asks for "add a field to the touchpoint form", that's an engineering ticket. Turnaround target: same-day for a backend-only addition (new field on the Zod schema + dbt mart column).

For v2: revisit DB-stored form schemas after we've shipped 5+ forms and the engineering channel becomes a bottleneck.

### Who can do what

This is the target permission model for the final sales workflow. The current POC is simpler: organization-scoped authenticated users can use the dummy form, and org admins manage MCP settings.

| Action | Authenticated org member | Sales contributor | Sales manager | Org admin |
|--------|---------------------------|--------------------|----------------|-----------|
| **Submit any form** | ✓ | ✓ | ✓ | ✓ |
| **Soft-delete own submission** | ✓ (within 24h) | ✓ (within 24h) | ✓ (any time) | ✓ |
| **Soft-delete any submission** | ✗ | ✗ | ✓ | ✓ |
| **Supersede a submission** | Planned, not in current foundation migration | Planned | Planned | Planned |
| **Hard-delete** (GDPR-style purge) | ✗ | ✗ | ✗ | ✓ (via SQL only — no UI) |
| **View own submissions** | ✓ | ✓ | ✓ | ✓ |
| **View org-wide submission history** | ✓ (read-only) | ✓ | ✓ | ✓ |
| **Edit scoring weights** (`protopie_churn_score_factors`) | ✗ | ✗ | ✓ | ✓ |
| **Create a new score config version** | ✗ | ✗ | ✓ | ✓ |
| **Trigger ad-hoc score recompute** | ✗ | ✗ | ✓ | ✓ |
| **Create/edit Account overrides** | ✗ | ✗ | ✓ | ✓ |
| **Bootstrap dashboards** (via API) | ✗ | ✗ | ✗ | ✓ (also requires `manage:ContentAsCode`) |
| **Toggle org-level MCP write tools** | ✗ | ✗ | ✗ | ✓ |
| **View MCP audit log** | ✗ | ✗ | ✗ | ✓ |

**Current POC role mapping:**

- The backend requires an authenticated, organization-scoped Lightdash user.
- There is no `protopie_sales_team` table in the current foundation migration.
- "Sales contributor" and "Sales manager" are product roles for the future final form workflow, not implemented Lightdash roles yet.
- "Org admin" maps to the existing Lightdash ability to `manage` the `Organization`, used today for the MCP settings toggle.

If we need sales-specific submit/manage permissions later, add a Protopie-owned role table or upstream-friendly custom-role design in a separate migration.

### MCP and forms

The MCP write-tool path **never** writes form submissions or Protopie config. The MCP write tools cover charts, dashboards, spaces (generic content) — never Protopie operational data. If a future requirement asks for "let an agent submit a touchpoint", we'd add a separate, narrower MCP tool gated by a new scope.

## Editing a submission

Current POC behavior: submit a new row and soft-delete the old row if a correction is needed. The foundation migration does not include `supersedes_submission_uuid`.

Planned behavior, if sales needs explicit correction chains: add `supersedes_submission_uuid` in a future migration and let dbt resolve the latest row in each chain:

```sql
with chain as (
    select form_submission_uuid, supersedes_submission_uuid
    from {{ source('protopie_postgres', 'protopie_form_submissions') }}
    where deleted_at is null
),
latest as (
    select form_submission_uuid
    from chain
    where form_submission_uuid not in (select supersedes_submission_uuid from chain where supersedes_submission_uuid is not null)
)
select s.* from {{ source('protopie_postgres', 'protopie_form_submissions') }} s
where s.form_submission_uuid in (select form_submission_uuid from latest)
```

This preserves history (you can always reconstruct what was active on any past date) and avoids "did sales rewrite this last week?" questions when explaining a churn score.

## Open questions

- Schemas in code vs. in DB? → v1 in code, synced to `protopie_form_definitions` on startup. v1.1 may allow runtime editing.
- Form versioning policy? → Increment `version` on breaking schema changes; previous submissions retain their `schema_version`. dbt handles versions in the mart.
- Hard delete? → v1: never. Soft-delete only (sets `deleted_at`). Hard delete via DB by admin if legal/privacy requires it.

See [10-open-questions.md](./10-open-questions.md).
