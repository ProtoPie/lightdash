# 08 — Frontend Integration

> All Protopie-specific React code lives in `packages/frontend/src/protopie/` where possible. Core touch points should stay small: route/nav mounting for Protopie pages, plus the existing Lightdash Settings integrations page for the org-admin MCP toggle.

## Folder layout

```
packages/frontend/src/protopie/
├── index.tsx                      ← exports protopieRoutes: RouteObject[], ProtopieNavEntry
├── routes.tsx                     ← all <Route> children of /protopie/*
├── pages/
│   ├── ProtopieHomePage.tsx       ← landing: links to dashboards, forms, weights
│   ├── FormsListPage.tsx          ← all available forms
│   ├── FormSubmitPage.tsx         ← submit a form (per formKey)
│   ├── FormHistoryPage.tsx        ← submitter's past submissions (org admins see all)
│   ├── ScoringWeightsPage.tsx     ← admin: view/edit churn scoring rules
│   └── AccountOverridesPage.tsx   ← admin: force a score, exclude an Account
├── components/
│   ├── ProtopieNavEntry.tsx       ← the single nav button (mounted by upstream NavBar)
│   ├── DynamicForm.tsx            ← renders any FormDefinition (see 05-forms-system.md)
│   ├── ChurnScoreBadge.tsx        ← reusable colored badge for an Account
│   └── AccountPickerCombobox.tsx  ← typeahead for cloud_url values
├── hooks/
│   ├── useFormSchemas.ts          ← GET /api/v1/protopie/forms/schemas
│   ├── useSubmitForm.ts           ← POST /api/v1/protopie/forms/:key/submissions
│   ├── useFormSubmissions.ts      ← GET list
│   ├── useChurnRules.ts           ← GET /api/v1/protopie/churn/rules
│   ├── useUpdateChurnRule.ts      ← PUT /api/v1/protopie/churn/rules/:key
│   └── useChurnScore.ts           ← GET /api/v1/protopie/churn/score?accountKey=
├── api/
│   └── protopieApi.ts             ← thin fetch wrappers reusing Lightdash's BASE_API_URL
└── styles/
    └── theme.module.css           ← any CSS-module overrides (kept minimal)
```

## Routing — project-scoped

Lightdash's content (dashboards, charts, spaces) is always project-scoped (`/projects/:projectUuid/...`). Protopie pages must follow the same convention so the active project context, project switcher, and `ProjectLayout` wrapper all work correctly.

🔌 **WIRE-UP touch point #6.** Mount the Protopie route tree as a **child** of the project route in `packages/frontend/src/Routes.tsx`. We export `protopieProjectRoutes: RouteObject[]` and spread them as children of the existing project layout:

```tsx
// packages/frontend/src/protopie/routes.tsx
import { lazy } from 'react';
import type { RouteObject } from 'react-router-dom';

const ProtopieHomePage         = lazy(() => import('./pages/ProtopieHomePage'));
const FormsListPage            = lazy(() => import('./pages/FormsListPage'));
const FormSubmitPage           = lazy(() => import('./pages/FormSubmitPage'));
const FormHistoryPage          = lazy(() => import('./pages/FormHistoryPage'));
const ScoringWeightsPage       = lazy(() => import('./pages/ScoringWeightsPage'));
const AccountOverridesPage     = lazy(() => import('./pages/AccountOverridesPage'));

// These mount under /projects/:projectUuid/protopie/* — projectUuid is in useParams()
export const protopieProjectRoutes: RouteObject[] = [
    { path: 'protopie',                              element: <ProtopieHomePage /> },
    { path: 'protopie/forms',                        element: <FormsListPage /> },
    { path: 'protopie/forms/:formKey',               element: <FormSubmitPage /> },
    { path: 'protopie/forms/:formKey/history',       element: <FormHistoryPage /> },
    { path: 'protopie/churn/rules',                  element: <ScoringWeightsPage /> },
    { path: 'protopie/churn/overrides',              element: <AccountOverridesPage /> },
];

// MCP settings are not mounted here. They live in the existing Settings
// integrations page at /generalSettings/integrations.
```

```tsx
// packages/frontend/src/Routes.tsx
// 🔌 WIRE-UP — add imports:
import { protopieProjectRoutes } from './protopie/routes';

// inside the project route's children array (look for /projects/:projectUuid):
// children: [
//     { path: 'dashboards/:dashboardUuid/view', ... },
//     ...protopieProjectRoutes,                  // ← add
// ]
//
```

**Resulting URLs:**

| Path | Page |
|------|------|
| `/projects/:projectUuid/protopie` | Home — list of dashboards + form shortcuts |
| `/projects/:projectUuid/protopie/forms` | Available forms |
| `/projects/:projectUuid/protopie/forms/:formKey` | Submit a form |
| `/projects/:projectUuid/protopie/forms/:formKey/history` | Submitter's history |
| `/projects/:projectUuid/protopie/churn/rules` | Scoring weights admin |
| `/projects/:projectUuid/protopie/churn/overrides` | Account overrides admin |
| `/generalSettings/integrations` | Org-admin MCP write-tools toggle, under "Protopie MCP" |

**Active-project behavior.** All project-scoped pages read `projectUuid` from `useParams()`. The existing `useActiveProjectUuid()` hook works as expected within the project layout. If a user navigates to `/protopie` (no project), redirect to `/projects/<last-active-uuid>/protopie` — implement in the nav entry component.

**Redirects.** Backwards-compatibility shim during rollout: if someone lands on `/protopie/...` (the older shape from earlier drafts), redirect to `/projects/<active-uuid>/protopie/...`. Remove the shim once everyone's bookmarks are updated.

**Auth.** Every project-scoped page is wrapped by the existing `ProjectLayout` → `PrivateRoute` chain — no per-page `<PrivateRoute>` wrapper needed.

**MCP settings.** The MCP write-toggle is intentionally placed inside Lightdash's existing Settings → Organization settings → Integrations page. The component uses `GET/PATCH /api/v1/protopie/mcp-settings` and is visible only when `user?.ability.can('manage', 'Organization')`.

Lazy-loading every page keeps Protopie code out of the main bundle when Protopie is disabled (the lazy import errors at runtime if the page file is missing, so a sentinel feature flag in `ProtopieHomePage.tsx` can short-circuit to a 404 if needed).

## Navigation entry

🔌 **WIRE-UP touch point #7.** A single button in the navbar opens the Protopie home page. We export the button from our module and mount it from `MainNavBarContent.tsx`:

```tsx
// packages/frontend/src/protopie/components/ProtopieNavEntry.tsx
import { Button } from '@mantine-8/core';
import { Link, useParams } from 'react-router-dom';

export function ProtopieNavEntry() {
    const { projectUuid } = useParams<{ projectUuid?: string }>();
    if (!projectUuid) return null;             // only show inside a project context
    return (
        <Button component={Link} to={`/projects/${projectUuid}/protopie`} variant="subtle" size="compact-sm">
            Sales Ops
        </Button>
    );
}
```

```tsx
// packages/frontend/src/components/NavBar/MainNavBarContent.tsx
// 🔌 WIRE-UP — add import:
import { ProtopieNavEntry } from '../../protopie/components/ProtopieNavEntry';

// inside the left button group (next to Explore / Browse / Metrics):
<ProtopieNavEntry />
```

For visibility: only show when the current org has Protopie enabled (a feature flag query, gated client-side after `useHealth` resolves). If we don't bother with a flag, the button is always shown but lands on a 404 for environments where Protopie isn't installed — acceptable for v1.

## Pages — minimal sketches

### `ProtopieHomePage.tsx`

Two-column landing:

```
┌─────────────────────────┬─────────────────────────┐
│  Dashboards             │  Actions                 │
│  ──────────────         │  ──────────────         │
│  • Account 360         │  • Log touchpoint         │
│  • Churn Score         │  • Log renewal status     │
│  • [other]             │  • Override Account score │
│                         │                          │
│                         │  Admin                   │
│                         │  ──────────────         │
│                         │  • Scoring weights        │
│                         │  • Account overrides      │
└─────────────────────────┴─────────────────────────┘
```

Dashboards link out to existing Lightdash dashboard URLs (in the "Protopie — Sales Ops" space). Actions link to `/protopie/forms/:formKey`.

### `FormSubmitPage.tsx`

```tsx
const { formKey } = useParams();
const { data: schemas } = useFormSchemas();
const form = schemas?.find(s => s.key === formKey);
const submit = useSubmitForm(formKey!);

return (
    <Container>
        <Title order={2}>{form.title}</Title>
        <Text c="dimmed">{form.description}</Text>
        <DynamicForm
            definition={form}
            onSubmit={async (values) => {
                await submit.mutateAsync({ payload: values, accountKey: pickedAccount });
                navigate(`/protopie/forms/${formKey}/history`);
            }}
        />
    </Container>
);
```

If `form.requiresAccount`, an `AccountPickerCombobox` mounts above the form fields. The picker types-ahead from `/api/v1/protopie/accounts/search?q=` — a thin endpoint that queries `mart_account_metadata` for known `cloud_url` values + Account names. (Or, simpler v1: hard-list the values from the latest score table.)

### `ScoringWeightsPage.tsx`

A table of the active rules with inline editable weight columns. On save, calls `PUT /api/v1/protopie/churn/rules/:ruleKey` and shows a toast: "Saved. A recompute will run with the new weights tonight, or click 'Recompute now'."

```tsx
<Group justify="space-between">
    <Title order={2}>Churn Scoring Weights</Title>
    <Button onClick={triggerRecompute}>Recompute now</Button>
</Group>
<Table>
  <thead>
    <tr><th>Rule</th><th>Weight</th><th>Goal</th><th>Window</th></tr>
  </thead>
  <tbody>
    {rules.map(r => (
        <tr key={r.rule_key}>
            <td>{r.display_name}</td>
            <td><NumberInput value={...} onChange={...} /></td>
            <td>{r.goal_numeric} {r.goal_unit}</td>
            <td>{r.window_days}d</td>
        </tr>
    ))}
  </tbody>
</Table>
```

### `AccountOverridesPage.tsx`

Similar table:

| Account | Override | Value | Until | Created by |
|---------|----------|-------|-------|------------|
| customer-a.protopie.cloud | force_score | 25 | 2026-12-31 | Esther |

A button "Add override" opens a modal with a `DynamicForm` driven by the `account_override_create` form schema.

## API client

```ts
// packages/frontend/src/protopie/api/protopieApi.ts
import { lightdashApi } from '../../api';   // existing helper

export const protopieApi = {
    listFormSchemas: () =>
        lightdashApi<FormSchema[]>({ url: '/api/v1/protopie/forms/schemas', method: 'GET' }),

    submitForm: (formKey: string, body: { payload: unknown; accountKey?: string }) =>
        lightdashApi<Submission>({
            url: `/api/v1/protopie/forms/${formKey}/submissions`,
            method: 'POST',
            body: JSON.stringify(body),
        }),

    listChurnRules: () =>
        lightdashApi<ScoringRule[]>({ url: '/api/v1/protopie/churn/rules', method: 'GET' }),

    updateChurnRule: (ruleKey: string, patch: Partial<ScoringRule>) =>
        lightdashApi<ScoringRule>({
            url: `/api/v1/protopie/churn/rules/${ruleKey}`,
            method: 'PUT',
            body: JSON.stringify(patch),
        }),

    getChurnScore: (accountKey: string) =>
        lightdashApi<ChurnScore>({
            url: `/api/v1/protopie/churn/score?accountKey=${encodeURIComponent(accountKey)}`,
            method: 'GET',
        }),

    recomputeChurnScore: (body?: { accountKey?: string }) =>
        lightdashApi<{ runUuid: string }>({
            url: '/api/v1/protopie/churn/recompute',
            method: 'POST',
            body: body ? JSON.stringify(body) : undefined,
        }),
};
```

`lightdashApi` is Lightdash's existing thin wrapper around `fetch` in `packages/frontend/src/api.ts` — it adds default headers (auth cookie, embed token, etc.) and unwraps the `{ status: 'ok', results: T }` envelope.

## Hooks (TanStack Query)

Standard pattern — keep them flat, one file per hook:

```ts
// packages/frontend/src/protopie/hooks/useChurnRules.ts
import { useQuery } from '@tanstack/react-query';
import { protopieApi } from '../api/protopieApi';

export function useChurnRules() {
    return useQuery({
        queryKey: ['protopie', 'churn', 'rules'],
        queryFn: protopieApi.listChurnRules,
    });
}
```

Mutations invalidate the right query keys:

```ts
// packages/frontend/src/protopie/hooks/useUpdateChurnRule.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { protopieApi } from '../api/protopieApi';

export function useUpdateChurnRule() {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ ruleKey, patch }: { ruleKey: string; patch: Partial<ScoringRule> }) =>
            protopieApi.updateChurnRule(ruleKey, patch),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['protopie', 'churn', 'rules'] }),
    });
}
```

## Styling

- Mantine v8 components only. No `sx` props (Mantine v6 legacy).
- For anything beyond 3 inline props, use a CSS module (per `CLAUDE.md` style guide).
- Reuse Lightdash's existing color tokens (`ldGray`, `ldDark` from `mantineTheme.ts`); do not introduce a Protopie palette.

## Embedding Lightdash dashboards inside Protopie pages

The `ProtopieHomePage` lists dashboard tiles. Each tile is a card that **links out** to the existing Lightdash dashboard URL — we do not inline the dashboard iframe. Reason: Lightdash's embed flow requires JWT tokens and a separate `/embed/*` route tree; it's not designed for "inline embedding in another React tree of the same app."

If product asks for true inline embedding (e.g., a tile that shows the churn-score gauge directly on `ProtopieHomePage`), the right primitive is a small reused chart component that issues `useGetSavedChartResults(chartUuid)` and renders via Lightdash's existing chart renderer. This is a Phase 2 enhancement, not v1.

## Accessibility & i18n

- Form labels come from the Zod field's `.describe('...')` text. Localize via Lightdash's existing i18n infrastructure if/when we localize.
- `ChurnScoreBadge` colors: red/amber/green — must include text labels for color-blind users ("At risk", "Watch", "Healthy").

## What we don't build in the frontend

- No drag-and-drop form builder (forms are code-defined).
- No bespoke chart renderer (use Lightdash's).
- No new state-management library (TanStack Query + local component state cover everything).
- No new providers at the App root — Lightdash's existing `QueryClient`, `AuthProvider`, `ThemeProvider` are sufficient.
