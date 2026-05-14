# 15 — Deployment & Infrastructure

> Current state: infrastructure now lives inside this Lightdash repo under `infra/`. Dev is deployed from the forked image in ECR, with MCP enabled and dbt GitHub source access available to the MCP tools.

## Current layout

```text
infra/
├── README.md
├── ecr/        ← shared ECR repository for the custom Lightdash image
├── dev/        ← dev ECS/RDS/S3/ALB stack
└── prod/       ← prod ECS/RDS/S3/ALB stack
```

Sensitive runtime files are intentionally ignored by git:

- `.env`
- `.terraform/`
- `terraform.tfstate`
- `terraform.tfstate.*`
- `.terraform.lock.hcl` should stay committed when Terraform providers are intentionally upgraded, unless the team decides to pin providers outside git.

Do not commit runtime secrets, Terraform state, or GitHub PAT values.

## What is deployed

| Component | Current setup |
|-----------|---------------|
| Compute | AWS ECS Fargate, one Lightdash container per environment. |
| Image | Custom fork image from ECR: `750128304405.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash:<tag>`. |
| ECR | Shared repository `protopie/lightdash`, managed by `infra/ecr`. Lifecycle keeps only the latest two image versions per policy. |
| App DB | RDS Postgres managed by Terraform. If AWS upgraded the DB engine version outside Terraform, keep the newer version in Terraform config instead of downgrading it. |
| Object store | S3 bucket per environment. |
| Load balancer | ALB to ECS service on port `8080`. |
| MCP | Enabled through `MCP_ENABLED=true`. Endpoint: `/api/v1/mcp`. |
| dbt source context | MCP reads `ProtoPie/data-modeling` through `PROTOPIE_DBT_GITHUB_*` env vars in dev/prod. |

## Make targets

From the repo root:

```bash
make build-dev
make deploy-dev
make build-prod
make deploy-prod
```

What each target does:

| Target | Behavior |
|--------|----------|
| `make build-dev` | Typechecks backend, ensures ECR exists, logs in to ECR, builds the fork image, and pushes `dev-<git-sha>` plus `dev-latest`. |
| `make deploy-dev` | Runs `build-dev`, then applies Terraform in `infra/dev` with `lightdash_oci_image` and `lightdash_oci_tag=dev-<git-sha>`. |
| `make build-prod` | Same as dev, but tags `prod-<git-sha>` plus `prod-latest`. |
| `make deploy-prod` | Runs `build-prod`, then applies Terraform in `infra/prod`. Do not run this until dev is validated. |

Default image tags come from the local git SHA:

```text
DEV_IMAGE_TAG=dev-$(git rev-parse --short HEAD)
PROD_IMAGE_TAG=prod-$(git rev-parse --short HEAD)
```

You can override tags:

```bash
make deploy-dev DEV_IMAGE_TAG=dev-my-test
```

## Dev deployment

For dev, the normal command is:

```bash
make deploy-dev
```

This does three important things:

1. Builds the current forked Lightdash image.
2. Pushes it to ECR.
3. Runs Terraform in `infra/dev`, updating the ECS task definition to use the image tag that was just built.

Terraform applies only the dev stack from `infra/dev`. It does not apply prod.

## Prod deployment

Prod files can be edited and reviewed in this repo, but prod should not be applied casually.

Recommended prod flow:

1. Merge and deploy to dev.
2. Smoke test dev, including MCP OAuth, dbt file read tools, dashboard reads, and one write tool in a test space.
3. Build a prod tag from the same commit:

   ```bash
   make build-prod
   ```

4. Review `terraform plan` in `infra/prod`.
5. Apply prod only after approval:

   ```bash
   make deploy-prod
   ```

## Required runtime env

Use the templates as the source of truth:

- `.env.example`
- `infra/dev/.env.example`
- `infra/prod/.env.example`

MCP-specific env:

```bash
MCP_ENABLED=true
```

dbt source env for dev/prod:

```bash
PROTOPIE_DBT_GITHUB_OWNER=ProtoPie
PROTOPIE_DBT_GITHUB_REPO=data-modeling
PROTOPIE_DBT_GITHUB_REF=main
PROTOPIE_DBT_GITHUB_TOKEN=<fine-grained-read-only-pat>
PROTOPIE_DBT_ALLOWED_PATHS=models,marts,macros,seeds,snapshots,analyses,analysis,tests,dbt_project.yml,packages.yml,selectors.yml,exposures.yml,README.md
```

Local-only dbt env:

```bash
PROTOPIE_DBT_LOCAL_PATH=/Users/mamur/Documents/projects/data-modeling
```

Do not set `PROTOPIE_DBT_LOCAL_PATH` in ECS unless the container image actually includes that checkout. Dev/prod should use the GitHub path.

## MCP endpoint after deploy

Dev:

```text
https://lightdash-dev.protopie.io/api/v1/mcp
```

Codex:

```bash
codex mcp add lightdash-mcp --url https://lightdash-dev.protopie.io/api/v1/mcp
codex mcp login lightdash-mcp --scopes read,write,mcp:read,mcp:write
```

If tools discover but writes fail with "MCP write tools are disabled for this organization", an org admin must enable writes in:

```text
/generalSettings/integrations
Settings → Organization settings → Integrations → Protopie MCP
```

## Network access for the Airflow DAG

The dbt/Airflow work is separate from the Lightdash fork, but the future pipeline needs to read Protopie app tables from the Lightdash Postgres RDS instance and load them into Redshift.

Required pieces:

| Concern | Setting |
|---------|---------|
| Source endpoint | Terraform output from `infra/{dev,prod}` for the Lightdash RDS endpoint. |
| Source credentials | Read-only Postgres user, not the Lightdash app write user. |
| Network path | RDS security group allows ingress from the Airflow worker security group or approved private network path. |
| Destination | Redshift schemas used by `data-modeling`: `warehouse_staging` for dev, `warehouse` for prod. |

The dbt implementation is owned separately, but this Lightdash repo owns the app DB tables and RDS network exposure.

## Rollback

Fastest rollback is to point ECS back to a prior task definition or image tag.

List recent task definitions:

```bash
aws ecs list-task-definitions --family-prefix lightdash-dev --status ACTIVE --sort DESC --max-items 5
```

Update service manually:

```bash
aws ecs update-service \
  --cluster lightdash-cluster-dev \
  --service lightdash-service-dev \
  --task-definition lightdash-dev:<prior-revision>
```

Or set `DEV_IMAGE_TAG` to a previous known-good tag and rerun Terraform in `infra/dev`.

## Smoke test

After dev deploy:

1. Open `https://lightdash-dev.protopie.io`.
2. Confirm login works.
3. Confirm `/api/v1/mcp` returns an auth challenge, not 404.
4. Connect Codex/Claude to the MCP URL and complete OAuth.
5. Call `protopie_get_overview`.
6. Call `protopie_dbt_list_files` and confirm it lists `ProtoPie/data-modeling` files.
7. If write testing is intended, enable Protopie MCP writes in `/generalSettings/integrations`.
8. Create a test space with `protopie_create_space`.
