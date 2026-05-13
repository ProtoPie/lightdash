# Protopie Lightdash Fork

This repository is Protopie's fork of Lightdash. It keeps the upstream
Lightdash application, then adds Protopie-specific work for:

- sales-filled forms used as churn score inputs
- custom MCP tools for agents such as Codex and Claude
- AWS ECS/ECR deployment for dev and prod
- isolated implementation notes under `docs/codex-docs`

The dbt/data-modeling work is handled in the separate data-modeling project.
This repo is responsible for Lightdash application changes, local execution,
MCP behavior, forms, Docker image builds, and ECS deployment.

## Important Paths

- `packages/common/src/protopie`: shared Protopie form schemas and registry
- `packages/backend/src/protopie`: backend controllers, services, models, MCP tools, migrations
- `packages/frontend/src/protopie`: forms UI and MCP settings UI
- `docs/codex-docs`: implementation planning docs
- `docs/POC.md`: non-technical POC explanation
- `infra/ecr`: shared ECR repository and lifecycle policy
- `infra/dev`: dev ECS/RDS/S3/ALB Terraform stack
- `infra/prod`: prod ECS/RDS/S3/ALB Terraform stack
- `Makefile`: build and deploy entrypoints

## Local Development

Install dependencies:

```bash
corepack enable
pnpm install
```

Start local infrastructure:

```bash
docker compose -f docker/docker-compose.dev.yml up -d
```

Run checks before pushing or deploying:

```bash
pnpm --filter backend typecheck
pnpm --filter @lightdash/frontend typecheck
pnpm --filter @lightdash/frontend lint
git diff --check
```

If Docker builds fail because local `node_modules` is copied into the image,
check `.gitignore` and `.dockerignore`. This fork expects nested
`node_modules` directories to be ignored.

## Protopie Forms

Forms are developer-defined. Sales users fill the forms in Lightdash; they do
not create form schemas themselves.

Current form flow:

1. Define or update a form schema in `packages/common/src/protopie/forms/schemas`.
2. Register the form in `packages/common/src/protopie/forms/registry.ts`.
3. Backend form APIs read the registry, persist definitions, validate payloads,
   and save submissions.
4. Frontend renders available forms under the `Forms` navigation item.
5. Submitted data is saved to the Lightdash application database and can later
   be used by marts/churn score modeling.

Main files:

- `packages/common/src/protopie/forms/defineForm.ts`
- `packages/common/src/protopie/forms/registry.ts`
- `packages/common/src/protopie/forms/schemas/churnScoreInput.ts`
- `packages/backend/src/protopie/controllers/FormController.ts`
- `packages/backend/src/protopie/services/FormService.ts`
- `packages/backend/src/protopie/models/FormDefinitionModel.ts`
- `packages/backend/src/protopie/models/FormSubmissionModel.ts`
- `packages/frontend/src/protopie/ProtopieFormsPage.tsx`

The current churn score form is intentionally a dummy POC form. Final field
definitions should be added later when the churn score formula and required
inputs are finalized.

## Protopie MCP

MCP is exposed at:

```text
/api/v1/mcp
```

Dev endpoint:

```text
https://lightdash-dev.protopie.io/api/v1/mcp
```

Runtime requirement:

```text
MCP_ENABLED=true
```

MCP write access has three gates:

1. the MCP token must include `mcp:write`
2. the organization must enable MCP writes
3. the authenticated user must have normal Lightdash permissions for the action

The organization write gate exists so an external agent cannot create, update,
or delete Lightdash content unless an org admin explicitly opts in.

Admin UI path:

```text
Settings -> Organization settings -> Integrations -> Protopie MCP
```

The admin toggles:

```text
Enable MCP write tools
```

Main files:

- `packages/backend/src/protopie/mcp/registerProtopieMcpTools.ts`
- `packages/backend/src/protopie/mcp/shared/auth.ts`
- `packages/backend/src/protopie/controllers/SettingsController.ts`
- `packages/backend/src/protopie/services/SettingsService.ts`
- `packages/backend/src/protopie/models/OrganizationSettingsModel.ts`
- `packages/frontend/src/protopie/ProtopieMcpSettingsPanel.tsx`
- `packages/frontend/src/protopie/api.ts`

## MCP Client Connections

Use the dev endpoint while testing:

```text
https://lightdash-dev.protopie.io/api/v1/mcp
```

Use the prod endpoint only after the dev flow is verified:

```text
https://lightdash.protopie.io/api/v1/mcp
```

### Codex

Register the dev MCP server:

```bash
codex mcp add lightdash-mcp --url https://lightdash-dev.protopie.io/api/v1/mcp
```

Authorize Codex through Lightdash OAuth:

```bash
codex mcp login lightdash-mcp --scopes read,write,mcp:read,mcp:write
```

Check that Codex can see the server:

```bash
codex mcp list
codex mcp get lightdash-mcp
```

After changing the URL, scopes, or OAuth state, restart the Codex session so it
rediscovers the tools.

For local development:

```bash
codex mcp add lightdash-local --url http://localhost:3000/api/v1/mcp
codex mcp login lightdash-local --scopes read,write,mcp:read,mcp:write
```

If Codex Desktop asks for manual MCP details, use:

```text
URL: https://lightdash-dev.protopie.io/api/v1/mcp
Bearer token env var: leave empty for OAuth
Headers: leave empty unless debugging with a manual bearer token
```

### Claude Code

Register the dev MCP server:

```bash
claude mcp add --transport http --scope user lightdash-mcp https://lightdash-dev.protopie.io/api/v1/mcp
```

Check that Claude Code saved the connection:

```bash
claude mcp list
claude mcp get lightdash-mcp
```

Start a new Claude Code session after adding the server. If Claude prompts for
OAuth, authorize with the same Lightdash user that should own the API actions.

For local development:

```bash
claude mcp add --transport http --scope user lightdash-local http://localhost:3000/api/v1/mcp
```

If tools are reachable but writes fail with:

```text
MCP write tools are disabled for this organization.
```

then the admin toggle above is still off.

## Build System

The Makefile builds Docker images and pushes them to ECR.

Defaults:

```text
AWS_REGION=us-west-2
ECR_AWS_PROFILE=xid-prod
DEV_AWS_PROFILE=xid-prod
PROD_AWS_PROFILE=xid-prod
ECR_REPOSITORY=protopie/lightdash
DOCKERFILE=dockerfile
DOCKER_TARGET=prod
PLATFORM=linux/amd64
```

ECR repository:

```text
750128304405.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash
```

ECR is managed separately from the dev/prod ECS stacks:

```bash
make ensure-ecr
```

That target runs Terraform in `infra/ecr` and manages the repository plus
lifecycle policy. The lifecycle policy is intended to keep only the recent dev
and prod images instead of retaining every historical image.

Build only:

```bash
make build-dev
make build-prod
```

By default image tags are based on the current Git commit:

```text
dev-<git-sha>
prod-<git-sha>
```

If you deploy uncommitted changes, pass a unique tag. Otherwise Terraform may
see the same image tag and not create a new ECS task definition.

Example:

```bash
make build-dev DEV_IMAGE_TAG=dev-$(git rev-parse --short HEAD)-mcp-ui-$(date +%Y%m%d%H%M)
```

## Deploy Dev

Use dev for testing application, MCP, and UI changes.

Build and deploy with the Makefile:

```bash
make deploy-dev DEV_IMAGE_TAG=dev-$(git rev-parse --short HEAD)-change-name-$(date +%Y%m%d%H%M)
```

`make deploy-dev` does the following:

1. runs backend typecheck
2. ensures ECR exists
3. logs Docker into ECR
4. builds and pushes the dev image
5. runs `terraform init` in `infra/dev`
6. runs `terraform apply` in `infra/dev` with the new image repo and tag

The Terraform apply is interactive. Review the plan before typing `yes`.

If you already built and pushed an image and only need to update ECS:

```bash
terraform -chdir=infra/dev apply \
  -var lightdash_oci_image=750128304405.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash \
  -var lightdash_oci_tag=<dev-image-tag>
```

Wait for ECS to become stable:

```bash
aws ecs wait services-stable \
  --profile xid-prod \
  --region us-west-2 \
  --cluster lightdash-cluster-dev \
  --services lightdash-service-dev
```

Check the deployed task definition:

```bash
aws ecs describe-services \
  --profile xid-prod \
  --region us-west-2 \
  --cluster lightdash-cluster-dev \
  --services lightdash-service-dev \
  --query 'services[0].{taskDefinition:taskDefinition,running:runningCount,desired:desiredCount,deployments:deployments[].{status:status,rolloutState:rolloutState,taskDefinition:taskDefinition}}' \
  --output json
```

Check the dev URL:

```bash
curl -I -sS https://lightdash-dev.protopie.io
```

If a frontend change does not appear, hard refresh the browser. If it still
does not appear, verify that the dev service is on the new ECS task definition
and that the image tag was unique.

## Deploy Prod

Prod uses the same image build path but must be treated as a separate release.
Do not apply prod Terraform without explicit approval.

Build prod image:

```bash
make build-prod PROD_IMAGE_TAG=prod-$(git rev-parse --short HEAD)-release-name-$(date +%Y%m%d%H%M)
```

Plan prod:

```bash
terraform -chdir=infra/prod plan \
  -var lightdash_oci_image=750128304405.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash \
  -var lightdash_oci_tag=<prod-image-tag>
```

Apply prod only after the plan is reviewed and approved:

```bash
terraform -chdir=infra/prod apply \
  -var lightdash_oci_image=750128304405.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash \
  -var lightdash_oci_tag=<prod-image-tag>
```

There is also a Makefile target:

```bash
make deploy-prod PROD_IMAGE_TAG=<prod-image-tag>
```

Use it only when an interactive prod apply is intended.

## Terraform Notes

- `infra/ecr` is separate so ECR can exist before any dev/prod deployment.
- `infra/dev` and `infra/prod` should reference the ECR image repository and
  tag through Terraform variables.
- `.terraform.lock.hcl` should be committed. It keeps provider versions stable.
- Do not commit `.terraform/` directories or local Terraform state files.
- If Terraform detects RDS drift, review carefully before applying.
- Do not apply a plan that downgrades the RDS engine version or parameter group
  family. Keep the actual upgraded database version and update Terraform to
  match it.

## Runtime Environment

Use the Makefile helpers to see the expected runtime environment:

```bash
make print-runtime-env-dev
make print-runtime-env-prod
```

Important runtime flags:

```text
MCP_ENABLED=true
SECURE_COOKIES=true
TRUST_PROXY=true
SITE_URL=<environment-url>
PGCONNECTIONURI=<postgres connection string with sslmode for RDS>
SCHEDULER_ENABLED=true
GROUPS_ENABLED=true
```

Okta is expected in dev/prod for normal login and MCP OAuth:

```text
AUTH_DISABLE_PASSWORD_AUTHENTICATION=true
AUTH_OKTA_OAUTH_CLIENT_ID=<secret>
AUTH_OKTA_OAUTH_CLIENT_SECRET=<secret>
AUTH_OKTA_OAUTH_ISSUER=<issuer>
AUTH_OKTA_DOMAIN=<domain>
AUTH_ENABLE_GROUP_SYNC=true
```

Do not write secrets into this README, Terraform files, or committed env files.

## Verification Checklist

Before deploying:

```bash
pnpm --filter backend typecheck
pnpm --filter @lightdash/frontend typecheck
pnpm --filter @lightdash/frontend lint
git diff --check
```

After deploying dev:

```bash
aws ecs wait services-stable \
  --profile xid-prod \
  --region us-west-2 \
  --cluster lightdash-cluster-dev \
  --services lightdash-service-dev

curl -I -sS https://lightdash-dev.protopie.io
```

For MCP changes:

1. Log into Lightdash as an org admin.
2. Go to `Settings -> Organization settings -> Integrations`.
3. Enable `Protopie MCP -> Enable MCP write tools`.
4. Re-login the MCP client if scopes changed.
5. Test read tools first.
6. Test write tools in dev before prod.

## Common Problems

### MCP endpoint returns 401

The MCP endpoint exists but the client has not completed OAuth or is missing a
valid bearer token. Re-run:

```bash
codex mcp login lightdash-mcp --scopes read,write,mcp:read,mcp:write
```

### MCP tools are not exposed in Codex

Check that:

- `MCP_ENABLED=true` is present in the ECS task definition
- `/api/v1/mcp` is reachable
- OAuth login completed successfully
- the Codex session was restarted after MCP config changes

### MCP writes are blocked

If the error is:

```text
MCP write tools are disabled for this organization.
```

enable writes in the admin UI:

```text
Settings -> Organization settings -> Integrations -> Protopie MCP
```

### Frontend change not visible in dev

Usually one of these is true:

- the image was not rebuilt
- the image tag did not change
- Terraform did not create a new ECS task definition
- the browser is serving an old bundle

Use a unique `DEV_IMAGE_TAG`, deploy, wait for ECS stability, then hard refresh.

### Docker image is large

This is expected for now. Lightdash includes multiple dbt runtimes in the image,
so a production image around 2 GB is normal.

## Commit Guidance

Keep commits separated when possible:

- docs-only changes
- app implementation changes
- infra changes

Do not mix unrelated user changes into your commit. Check the working tree
before committing:

```bash
git status --short
git diff --check
```
