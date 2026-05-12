# Protopie POC Overview - What Changes and What Work Is Needed

> **Audience:** non-technical stakeholders, sales leadership, sales ops, customer success, and project owners.
>
> **Purpose:** explain the proof of concept in business terms: what will change, what the POC proves, what still needs to be built, and what decisions are needed before replacing ChurnZero.
>
> **This is not an engineering build guide.** Technical implementation details live in [`docs/protopie-docs/`](./protopie-docs/).

---

## Executive Summary

Protopie currently uses ChurnZero to monitor account health and churn risk. The subscription expires on **2026-07-30**, and the plan is to replace the parts Sales actually uses with a custom experience inside Lightdash.

The replacement has three main pieces:

1. **Usage and Churn Score dashboards**
   Sales can see account usage, churn score, score breakdown, and risk bands in Lightdash.

2. **Sales activity forms**
   Sales reps can manually log account touchpoints, renewal notes, and account risk context directly in Lightdash. This replaces the ChurnZero activity logging workflow for v1.

3. **Agent-assisted dashboard creation**
   AI coding/agent tools such as Claude Code or Codex can use Lightdash MCP tools to create or update dashboards, charts, and spaces. This is not only for churn dashboards; it is a general Lightdash capability.

The POC should prove that these pieces can work together before the team invests in the full production version.

---

## Why We Are Doing This

ChurnZero costs about **USD $30,000/year**. The team only uses a small part of it:

| ChurnZero capability | v1 replacement |
|---|---|
| Churn Score | Rebuilt in Lightdash using warehouse usage data |
| Account activity logging | Replaced by manual Lightdash forms |
| Bulk email send | Out of scope; use another tool |
| Automatic email logging | Out of scope for v1 |

The main value is keeping the churn workflow alive while removing a tool that is not worth the cost.

---

## What Changes for Sales

### Today

Sales goes to ChurnZero to:

- check churn score,
- inspect account health,
- log or review account activity,
- identify at-risk customers.

The usage data comes from Amplitude and Salesforce, then ChurnZero calculates the account score.

### After v1

Sales goes to Lightdash to:

- open the **Usage Data Dashboard** for one account,
- open the **Churn Score Dashboard** for the full customer portfolio,
- filter by account, plan tier, owner, risk band, and date,
- log an account touchpoint or renewal note through a Lightdash form,
- see recent touchpoints on the dashboard.

The work moves from ChurnZero into Lightdash, but the sales workflow should feel familiar: find an account, inspect health, record context, and act on risk.

---

## What Does Not Change

The POC does not replace every system around Sales.

| Area | Status |
|---|---|
| Salesforce | Stays as-is. We read Salesforce-related data from the warehouse when available. |
| Amplitude | Stays as-is. Usage events continue flowing into the data warehouse. |
| Lightdash | Becomes the main UI for churn dashboards and forms. |
| dbt / data warehouse | Continues to model product usage and account data. |
| Email sending | Not part of this project. |
| Automatic Gmail/Outlook email logging | Not part of v1. |

---

## What the POC Must Prove

The POC is successful if we can demonstrate this complete flow:

1. A sales rep opens a Lightdash page for account touchpoints.
2. The rep submits a touchpoint form.
3. The form submission is saved in the Lightdash application database.
4. Usage data is available from the warehouse or mocked for the demo.
5. A churn score is calculated from usage factors.
6. The churn score appears in a Lightdash dashboard.
7. An external agent can create or update a Lightdash dashboard through MCP.

This proves the main product idea: Lightdash can become the place where Sales sees account health, adds manual account context, and builds or updates dashboards programmatically.

---

## What the POC Does Not Prove

The POC is intentionally smaller than the production system.

| Not proven in POC | Required before production |
|---|---|
| Full ChurnZero score parity | Run a 2-week side-by-side comparison before cutover |
| Nightly scheduled recompute | Add a nightly background job |
| Real Redshift mart refresh end-to-end | Build dbt models and Airflow app DB -> Redshift sync |
| Sales manager permissions | Add role checks and approval rules |
| Production MCP security | Add `mcp:write` scope, org opt-in, audit log |
| Dashboard bootstrap from YAML | Add content-as-code bootstrap endpoint |
| Production deployment | Build custom Docker image and deploy to ECS Fargate |
| Data retention and privacy controls | Add retention sweep, audit checks, and documented deletion process |

The POC answers "can this work?" The production project answers "can Sales safely depend on this every day?"

---

## The Future Workflow in Plain English

### 1. Usage data already exists

Product usage events already land in the data warehouse. We use dbt models to organize those events by customer account.

Examples:

- how many active users an account had,
- whether users created or saved pies,
- whether users used AI features,
- whether users used triggers or responses,
- how many active days the account had in the last 90 days.

### 2. Sales adds human context

Some important context does not come from product events. Sales knows things like:

- "We had a renewal call yesterday."
- "The customer is unhappy about pricing."
- "There is an intervention plan."
- "This account should be treated as high risk even if usage looks healthy."

Sales enters that context through Lightdash forms.

### 3. The churn score is calculated

The system combines:

- product usage metrics from the warehouse,
- scoring weights and goals,
- optional sales overrides,
- recent sales activity.

It produces:

- a score from 0 to 100,
- a risk band such as low, medium, or high,
- a factor-by-factor explanation.

### 4. Dashboards show the result

Sales uses normal Lightdash dashboards:

- **Account 360:** one-account detail view.
- **Churn Score Portfolio:** all accounts sorted by risk.

### 5. Agent tools help create and update content

MCP write tools let approved external agents create or update Lightdash spaces, charts, SQL charts, and dashboards.

This means a user could ask an agent:

> "Create a dashboard for at-risk Pro Plus accounts and save it in the Sales Ops space."

The agent uses Lightdash APIs through MCP instead of manually clicking through the UI.

---

## Work Needed to Reach Production

### Workstream 1 - Lightdash fork foundation

**Goal:** keep Protopie-specific changes isolated from upstream Lightdash.

Work needed:

- create `protopie/` folders in backend, frontend, and common packages,
- add a `PROTOPIE_ENABLED` feature flag,
- add Protopie database migrations,
- keep core Lightdash edits small and easy to remove.

Proof of completion:

- Protopie code can be enabled or disabled cleanly,
- existing Lightdash behavior still works,
- the "kill switch" process is documented and tested.

---

### Workstream 2 - Sales forms

**Goal:** let Sales submit structured account context inside Lightdash.

Work needed:

- build account touchpoint form,
- build renewal status form,
- build account override form,
- save submissions in Postgres,
- support corrections without overwriting history,
- expose form data to dbt and dashboards.

Important v1 decision:

- Sales fills out engineer-defined forms.
- Sales does not get a drag-and-drop form builder in v1.

Proof of completion:

- a sales rep can submit a touchpoint,
- the row is saved in the database,
- the row appears in the sales touchpoint mart and dashboard.

---

### Workstream 3 - Churn score engine

**Goal:** calculate a trusted account churn score without ChurnZero.

Work needed:

- build default 9-factor scoring config,
- store score configs and factor weights,
- compute score from warehouse usage data,
- store score history,
- expose factor breakdown,
- allow sales managers to update weights,
- support manual recompute for operations.

Proof of completion:

- score is produced for every active account,
- score explains which factors contributed points,
- nightly recompute runs successfully for 7 days,
- results are close enough to ChurnZero during side-by-side validation.

---

### Workstream 4 - dbt and warehouse models

**Goal:** prepare the account usage data the score engine needs.

Work needed in `/Users/mamur/Documents/projects/data-modeling`:

- create Protopie dbt models,
- create account identity bridge,
- create 90-day usage mart,
- create sales touchpoint mart,
- create latest churn score mart,
- add plan tier labels,
- expose marts to Lightdash with metadata.

Also needed:

- copy Protopie app DB tables into Redshift through Airflow,
- add tests for account identity, event groups, and freshness.

Proof of completion:

- dbt builds all Protopie models,
- Lightdash sees the new explores,
- form submissions and churn scores appear in the warehouse within the agreed refresh window.

---

### Workstream 5 - Dashboards

**Goal:** give Sales the replacement views they need before ChurnZero is shut down.

Dashboards needed:

1. **Usage Data Dashboard / Account 360**
   - one account at a time,
   - usage trends,
   - latest churn score,
   - factor breakdown,
   - recent touchpoints.

2. **Churn Score Portfolio Dashboard**
   - all accounts,
   - score distribution,
   - at-risk accounts,
   - accounts getting worse,
   - plan tier split.

Work needed:

- build chart YAML files,
- build dashboard YAML files,
- create a Sales Ops Lightdash space,
- add dashboard bootstrap endpoint,
- define dashboard ownership and edit rules.

Proof of completion:

- Sales can open the dashboards in Lightdash,
- all required filters work,
- sampled account scores match ChurnZero within the accepted tolerance.

---

### Workstream 6 - MCP agent tools

**Goal:** allow approved agents to create and update Lightdash content.

Work needed:

- add tools to list spaces and content,
- add tools to create/update spaces,
- add tools to create/update charts,
- add tools to create/update SQL charts,
- add tools to create/update dashboards,
- enforce `mcp:write` permission,
- require org-level opt-in,
- log all write attempts.

Proof of completion:

- Claude Code or Codex can create a dashboard through MCP,
- repeated calls are safe and idempotent,
- unauthorized users cannot write,
- audit log shows who called which tool and what happened.

---

### Workstream 7 - Deployment and operations

**Goal:** run the fork safely in Protopie's production environment.

Work needed:

- build custom Lightdash Docker image,
- push image to ECR,
- update Terraform ECS task definition,
- add Protopie environment variables,
- connect Airflow to Lightdash RDS with read-only access,
- monitor scheduler, dbt freshness, and MCP write activity.

Proof of completion:

- dev deployment runs the Protopie fork,
- production deploy plan is reviewed,
- rollback path is tested,
- operational runbook is published.

---

### Workstream 8 - Security, privacy, and cutover

**Goal:** make the replacement safe enough for Sales to rely on.

Work needed:

- define who can submit, view, delete, and override forms,
- confirm retention policy for sales notes,
- ensure public sharing is disabled for Sales Ops dashboards,
- audit MCP write tools,
- export historical ChurnZero data before shutdown,
- run side-by-side validation with ChurnZero.

Proof of completion:

- security/privacy review is complete,
- runbook is tested,
- Sales signs off,
- ChurnZero is safely cancelled before **2026-07-30**.

---

## POC Demo Script

This is the non-technical demo we should show stakeholders.

### Scene 1 - Sales logs a touchpoint

Show:

- Lightdash Sales Ops page,
- account touchpoint form,
- successful submission.

Message:

> Sales can now enter account context inside Lightdash instead of ChurnZero.

### Scene 2 - The data is saved

Show:

- a simple database or admin view proving the form submission exists.

Message:

> The touchpoint is stored as structured data, so it can be used in dashboards and future scoring.

### Scene 3 - Churn score is calculated

Show:

- a sample account score,
- the factor breakdown.

Message:

> The score is explainable. Sales can see why the account is healthy or at risk.

### Scene 4 - Dashboard shows the result

Show:

- Account 360 dashboard,
- score tile,
- recent touchpoint tile.

Message:

> The daily workflow moves from ChurnZero to Lightdash.

### Scene 5 - Agent creates or updates a dashboard

Show:

- Claude/Codex request,
- dashboard created or updated in Lightdash.

Message:

> Approved agents can automate dashboard creation using Lightdash APIs.

---

## Success Criteria for the POC

The POC is complete when these are true:

| Area | Success check |
|---|---|
| Sales form | A touchpoint can be submitted from Lightdash |
| Database | The submission is saved |
| Score | A sample churn score can be calculated |
| Dashboard | The score appears in a Lightdash dashboard |
| MCP | An agent can create or update a dashboard |
| Stakeholder understanding | Sales and leadership understand what the full project will require |

---

## Production Acceptance Criteria

The production version is ready for ChurnZero cutover only when:

1. Sales can use Lightdash dashboards without engineering help.
2. Sales can log touchpoints and renewal notes in Lightdash.
3. Churn score recomputes nightly.
4. Scores are close enough to ChurnZero during parallel validation.
5. Pro vs Pro Plus / Pro Plus Plus filters are visible.
6. MCP write tools are permissioned, audited, and disabled by default per org.
7. Operations has a runbook for failures and rollback.
8. Security/privacy review is complete.
9. Esther and Sales leadership sign off.
10. ChurnZero historical data is exported before cancellation.

---

## Timeline

The target deadline is **2026-07-30**, when the ChurnZero subscription ends.

| Phase | Target | Outcome |
|---|---|---|
| POC | First milestone | Prove the end-to-end idea |
| Foundations and data | Weeks 1-2 | Protopie module skeleton and dbt usage marts |
| Forms and score backend | Weeks 3-4 | Forms API and score calculation |
| Dashboards and UI | Weeks 5-7 | Sales-facing Lightdash experience |
| MCP write tools | Parallel | Agent-created dashboards and spaces |
| Hardening and UAT | Weeks 9-11 | ChurnZero comparison, fixes, sign-off |
| Cutover | By 2026-07-30 | ChurnZero cancelled |

---

## Key Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Scores do not match ChurnZero | Sales may not trust the replacement | Run side-by-side validation for at least 2 weeks |
| Account identity mapping is wrong | Usage events may attach to the wrong account | Build and test an account bridge in dbt |
| Sales notes contain sensitive information | Privacy risk | Retention policy, access control, no public sharing |
| MCP write tools are too powerful | Agents could create unwanted content | Org opt-in, `mcp:write`, CASL checks, audit log |
| Dashboards are manually changed after bootstrap | YAML and UI can drift | Make bootstrap-managed dashboards read-only for Sales |
| Airflow sync is stale | Touchpoints may not appear in dashboards quickly | Freshness checks and alerts |

---

## Decisions Needed from Stakeholders

Before production cutover, we need these decisions:

| Decision | Owner |
|---|---|
| Is daily churn score recompute enough, or is hourly required? | Sales lead / Esther |
| Are linear score formulas acceptable for v1, or must we match ChurnZero step rules exactly? | Sales lead / Esther |
| Who can change scoring weights? | Sales leadership |
| Who can approve manual account overrides? | Sales leadership |
| Are touchpoint form labels English, Korean, or both? | Sales ops |
| How long should sales notes be retained? | Legal / Privacy |
| Should MCP write tools be enabled in production at launch or after churn cutover? | Eng lead / Security |

---

## Glossary

| Term | Meaning |
|---|---|
| ChurnZero | Current customer success tool being replaced for churn scoring |
| Lightdash | BI tool where the new dashboards and forms will live |
| dbt | Data modeling tool that prepares warehouse tables |
| Redshift | Data warehouse where product usage data lives |
| Churn Score | 0-100 account health/risk score |
| Account 360 | Single-account dashboard for Sales |
| MCP | Protocol that lets external AI agents use Lightdash tools |
| Content-as-code | Dashboard/chart definitions stored as files and applied safely |
| POC | Proof of concept; a demo that proves feasibility, not production readiness |

---

## Where to Read More

Technical design and implementation details:

- [`docs/protopie-docs/00-context.md`](./protopie-docs/00-context.md)
- [`docs/protopie-docs/01-architecture.md`](./protopie-docs/01-architecture.md)
- [`docs/protopie-docs/05-forms-system.md`](./protopie-docs/05-forms-system.md)
- [`docs/protopie-docs/07-mcp-server-extension.md`](./protopie-docs/07-mcp-server-extension.md)
- [`docs/protopie-docs/09-implementation-roadmap.md`](./protopie-docs/09-implementation-roadmap.md)
- [`docs/protopie-docs/12-acceptance-matrix.md`](./protopie-docs/12-acceptance-matrix.md)
