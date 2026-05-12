# Protopie Custom Lightdash Build — Documentation Index

> **Purpose.** This folder documents a Protopie-specific extension to Lightdash that (1) replaces ChurnZero with a self-hosted Usage Data + Churn Score Dashboard, (2) adds a manual data-entry form system for the sales team, and (3) extends Lightdash's existing MCP server with **write** tools so external AI agents (Claude Code, Codex, Cursor) can create and update charts, dashboards, and spaces via Lightdash APIs.
>
> **Audience.** Engineers implementing or maintaining this fork.
>
> **North star.** Keep *all* Protopie-specific code in a single, clearly demarcated tree (`packages/*/src/protopie/`) so future Lightdash upstream merges remain low-conflict.

## Where to start

- **Non-technical reader / stakeholder?** Read **[`../POC.md`](../POC.md)** — a non-technical overview explaining the idea, what it takes, and what changes after the work ships.
- **Engineer about to implement?** Start with [00-context.md](./00-context.md) then [02-isolation-strategy.md](./02-isolation-strategy.md). The numbered docs below are the full design spec for v1.

---

## How to read these docs

If you are picking this up for the first time, read in order:

| # | Doc | What it covers |
|---|-----|----------------|
| 00 | [Context](./00-context.md) | Why we're forking — the ChurnZero replacement business case, scope, success criteria. Includes the Notion brief summary. |
| 01 | [Architecture](./01-architecture.md) | High-level system view: components, data flow, request/response paths. |
| 02 | [Isolation strategy](./02-isolation-strategy.md) | **Most important doc.** Folder layout, provider pattern, naming rules. How to keep Protopie code out of Lightdash core files. |
| 03 | [Data model](./03-data-model.md) | New PostgreSQL tables (form schemas, submissions, scoring rules, churn scores). Migration conventions. |
| 04 | [Churn score engine](./04-churn-score-engine.md) | SQL/dbt mart model for the 9-factor score, scheduled recompute job, weight management. |
| 05 | [Forms system](./05-forms-system.md) | Backend form schema + submission service. Sales-team data entry. |
| 06 | [Dashboards](./06-dashboards.md) | The two dashboards (Usage Data, Churn Score) and how they read from the new marts. |
| 07 | [MCP server extension](./07-mcp-server-extension.md) | Adding **write tools** (create chart / dashboard / space, update, delete) to Lightdash's existing read-only MCP server. |
| 08 | [Frontend integration](./08-frontend-integration.md) | New route tree (`/protopie/...`), nav entry, form UI, isolated React folder. |
| 09 | [Implementation roadmap](./09-implementation-roadmap.md) | Phased milestone plan. What to ship first, what depends on what. |
| 10 | [Open questions](./10-open-questions.md) | C7–C10 from the Notion brief, plus engineering decisions still to make. |
| 11 | [dbt integration](./11-dbt-integration.md) | Concrete plan for adding the Protopie marts + sources to the existing `data-modeling` repo (Redshift, dbt). |
| 12 | [Acceptance matrix](./12-acceptance-matrix.md) | One-row-per-requirement checklist with verification steps. Sign-off block. |
| 13 | [Operational runbook](./13-operational-runbook.md) | Procedures for failed recomputes, dashboard rollback, retention sweep, credential rotation, cutover monitoring. |
| 14 | [Security & privacy](./14-security-privacy.md) | Data classification, access control, audit logging, retention, threat model. |
| 15 | [Deployment & infrastructure](./15-deployment.md) | AWS ECS Fargate, Terraform, custom Docker image, env vars, Airflow → RDS network plumbing. |
| 16 | [Local run and Okta MCP auth](./16-local-run-and-okta-mcp-auth.md) | Local validation checklist plus production Okta/OAuth path for MCP clients. |

---

## TL;DR — the three deliverables

```
┌──────────────────────────────────────────────────────────────────────────┐
│  1. CHURN REPLACEMENT                                                    │
│     Amplitude → Redshift dbt (data-modeling repo) → Lightdash dashboards │
│     Sales forms → Lightdash Postgres → dbt → Churn Score → Dashboards    │
├──────────────────────────────────────────────────────────────────────────┤
│  2. FORM SYSTEM (generic, not churn-specific)                            │
│     Schema-driven forms ⇨ submissions table ⇨ surfaced as dbt sources    │
│     Sales team fills "Account Touch", "Meeting Log", "Renewal Status"    │
├──────────────────────────────────────────────────────────────────────────┤
│  3. MCP WRITE TOOLS (generic, not churn-specific)                        │
│     Extends existing McpService with create/update/delete tools for      │
│     charts, dashboards, spaces — so external agents can author content  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Three repos, one initiative

```
/Users/mamur/Documents/projects/lightdash          ← THIS REPO (Lightdash fork — github.com/ProtoPie/lightdash)
    └── packages/{common,backend,frontend}/src/protopie/    ← all custom code
    └── docs/protopie-docs/                                  ← these docs

/Users/mamur/Documents/projects/data-modeling       ← dbt project (separate repo)
    └── models/marts/warehouse/protopie/                     ← NEW: churn marts
    └── models/staging/protopie_app/                         ← NEW: Lightdash app DB as source
    └── lightdash/charts/protopie-*.yml                      ← NEW: chart YAMLs (alongside existing)
    └── lightdash/dashboards/protopie-*.yml                  ← NEW: dashboard YAMLs

/Users/mamur/Documents/projects/lightdash-infra     ← Terraform IaC (separate repo)
    └── infra/{dev,prod}/                                    ← AWS ECS Fargate + RDS + S3 + ALB stack
        └── ecs.tf, rds.tf, s3.tf, alb.tf, route53.tf
        └── .env                                             ← deploy-time env vars
```

The Account key on the warehouse side is **`team_id`** (from `dim_team_summary`), with `namespace` and `cloud_url` (= `dim_team_summary.url`) as secondary identifiers.

The deployment stack is **AWS ECS Fargate + Postgres RDS + S3**, Terraform-managed. To ship the fork we build a custom Docker image, push to ECR, and update the Terraform task definition. See [15-deployment.md](./15-deployment.md).

## Folder layout at a glance (target state)

```
packages/
├── backend/
│   └── src/
│       └── protopie/                  ← ALL backend custom code lives here
│           ├── controllers/           ← TSOA controllers (auto-picked-up by glob)
│           ├── services/
│           ├── models/
│           ├── database/migrations/
│           ├── scheduler/             ← churn recompute task
│           ├── mcp/                   ← write-tool plugins for McpService
│           └── index.ts               ← provider wire-up
├── common/
│   └── src/
│       └── protopie/                  ← shared types (form schemas, churn types)
├── frontend/
│   └── src/
│       └── protopie/                  ← React routes, pages, hooks
└── ...
```

See [02-isolation-strategy.md](./02-isolation-strategy.md) for the rationale and exact wire-up points.

---

## Conventions used in these docs

- **File paths** are absolute from the repo root (e.g., `packages/backend/src/protopie/services/ChurnScoreService.ts`).
- **Code blocks** marked `// existing — DO NOT MODIFY` describe Lightdash core files we *read* but should never edit.
- **Code blocks** marked `// new — protopie` describe files we own and write.
- **Wire-up touch points** are flagged with `🔌 WIRE-UP` — these are the *only* places we modify Lightdash core. Each touch point should be the smallest possible change (an import + a single registration line where possible).

---

## Not in scope

- Replacing Salesforce, Amplitude, or dbt — we *consume* their data.
- Building a new BI tool from scratch — Lightdash already does dashboards/charts/spaces.
- A general-purpose form builder UI (drag-and-drop) — forms are schema-defined in code, see [05-forms-system.md](./05-forms-system.md).
- Migrating Lightdash's own MCP read tools — those stay as-is.

## Related analyses

A parallel analysis lives in [`docs/codex-docs/`](../codex-docs/) — a separate research pass through the same brief and codebase. Key insights from that doc set that are now incorporated here:

- **MCP write tools should wrap `CoderService`** (Lightdash's existing content-as-code layer), not raw service calls. Content-as-code is slug-based, idempotent, and permission-gated — exactly what agent-driven authoring needs. See [07-mcp-server-extension.md](./07-mcp-server-extension.md).
- **`mcp:read` / `mcp:write` OAuth scopes already exist** in `packages/common/src/utils/oauth.ts` but are not enforced per-tool today. The new `requireMcpWrite()` helper closes that gap.
- **Versioned score configs** (a `protopie_churn_score_configs` row per version) are cleaner than mutating a single rules table. See [03-data-model.md](./03-data-model.md) and [04-churn-score-engine.md](./04-churn-score-engine.md).
- **`supersedes_submission_uuid`** for form corrections — append-only history, dbt resolves chains. See [05-forms-system.md](./05-forms-system.md).
- **Event group as a dbt seed** — declarative OR semantics, parity-tested against the Postgres factor config. See [04-churn-score-engine.md](./04-churn-score-engine.md).
- **Bootstrap endpoint** for idempotent dashboard creation via `CoderService`. See [06-dashboards.md](./06-dashboards.md).
