# 15 — Deployment & Infrastructure

> Lightdash is deployed via Terraform-managed AWS ECS Fargate. This doc covers the existing setup, how to extend it for the Protopie fork (custom Docker image, new env vars), and the network/secret plumbing the dbt pipeline needs.

## What's actually deployed

> **Note.** You called it "EKS" but the Terraform in `lightdash-infra/` uses **AWS ECS Fargate**. Documenting what's in the repo. If a separate EKS-based deployment exists somewhere else, point me at it and I'll update this section.

| Component | Spec | Source |
|-----------|------|--------|
| Compute | **ECS Fargate**, single task, 512 CPU / 1024 MiB by default | `lightdash-infra/infra/{dev,prod}/ecs.tf` |
| Image | `lightdash/lightdash:latest` from Docker Hub — **upstream, not the fork (today)** | `ecs.tf` var `lightdash_oci_tag` |
| App DB | **Postgres 15 RDS** (`db.t3.micro`, 20→100 GiB autoscale) via `terraform-aws-modules/rds/aws` | `rds.tf` |
| Object store | S3 bucket (private, versioning ON) | `s3.tf` |
| Load balancer | ALB → target group → ECS service (port 8080) | `alb.tf`, `target-group.tf`, `target-group-rule.tf` |
| DNS | Route53 records | `route53.tf` |
| Logs | CloudWatch `/ecs/lightdash-log-groups` | `ecs.tf` |
| AWS region | `us-west-2` | `main.tf` |
| AWS profile | `xid-prod` (and `xid-dev` analogue in `dev/main.tf`) | `main.tf` |
| Terraform state | S3 backend `xid-prod-terraform/lightdash-prod`, lockfile-based | `main.tf` |
| Environments | `dev/` and `prod/` — separate dirs, separate state files, parallel structure | `lightdash-infra/infra/` |

The fork repo URL is already declared in `main.tf` common tags: `https://github.com/ProtoPie/lightdash`. So the fork exists, but the deployed image still pulls from upstream Docker Hub — that's the gap we close in this doc.

## Two terraform environments

```
lightdash-infra/
├── README.md
└── infra/
    ├── dev/                      ← terraform workspace, AWS profile xid-dev (assumed)
    │   ├── main.tf, ecs.tf, rds.tf, alb.tf, s3.tf, …
    │   ├── .env                  ← deploy-time env vars (read by Terraform local.envs)
    │   └── terraform.tfstate     ← committed to repo (sync via git per README)
    └── prod/                     ← terraform workspace, AWS profile xid-prod
        └── … same shape
```

Deployment workflow per README:

```
terraform fmt
terraform plan
terraform apply
# then commit terraform.tfstate
```

> ⚠ **Security flag.** Both `.env` and `terraform.tfstate` are committed to git per the README's instructions. State files contain secrets in plaintext (RDS password, Slack tokens, etc.). This is an existing operational concern, not introduced by Protopie. Highly recommend moving to either:
> - AWS Secrets Manager / SSM Parameter Store + Terraform `data` blocks, or
> - Terraform Cloud / S3 backend with encryption + remote state locking (you already have S3 backend; just remove state files from git).
>
> Out of scope for the Protopie fork to fix in v1, but should be in the operational runbook backlog.

## What this means for the Protopie fork

We need to do three things to get our forked Lightdash running in prod:

1. **Build a custom Docker image** from the fork and host it where Terraform can pull from.
2. **Add Protopie env vars** to the ECS task definition.
3. **Open network access** between the Airflow DAG (data-modeling repo's ingestion) and the Lightdash RDS instance.

## Step 1 — Custom Docker image

### Build

Lightdash has a `Dockerfile` at the repo root. Add a GitHub Actions workflow in this fork (`.github/workflows/build-image.yml`) that builds and pushes on every push to `main`:

```yaml
name: Build Protopie Lightdash image
on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<account-id>:role/github-actions-ecr-push
          aws-region: us-west-2
      - uses: aws-actions/amazon-ecr-login@v2
        id: ecr
      - name: Build & push
        run: |
          IMAGE_REPO=${{ steps.ecr.outputs.registry }}/protopie/lightdash
          docker buildx build \
            -t $IMAGE_REPO:${{ github.sha }} \
            -t $IMAGE_REPO:latest \
            --push .
```

### Host

Push to **AWS ECR** under repo `protopie/lightdash` in the same account (`xid-prod` / `xid-dev`). Two ECR repos — one per env — so a dev push doesn't accidentally hit prod.

### Wire into Terraform

In `lightdash-infra/infra/{dev,prod}/ecs.tf`, change the image source:

```hcl
# was:
image = "lightdash/lightdash:${var.lightdash_oci_tag}"

# becomes:
image = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.name}.amazonaws.com/protopie/lightdash:${var.lightdash_oci_tag}"
```

And grant the ECS task execution role permission to pull from ECR (most likely already covered by `AmazonECSTaskExecutionRolePolicy` — verify in the IAM console).

`lightdash_oci_tag` defaults to `"latest"`; for pinned deploys, override to a commit SHA: `terraform apply -var "lightdash_oci_tag=abc1234"`.

## Step 2 — Protopie env vars

Edit `lightdash-infra/infra/{dev,prod}/ecs.tf` `container_definitions.environment[]` to add:

```hcl
{ "name" : "PROTOPIE_ENABLED",                  "value" : local.envs["PROTOPIE_ENABLED"] },
{ "name" : "PROTOPIE_PROJECT_UUID",             "value" : local.envs["PROTOPIE_PROJECT_UUID"] },
{ "name" : "PROTOPIE_WAREHOUSE_MART_TABLE",     "value" : local.envs["PROTOPIE_WAREHOUSE_MART_TABLE"] },
                                                                                # e.g. "warehouse.mart_account_usage_90d"
{ "name" : "PROTOPIE_RECOMPUTE_CRON",           "value" : local.envs["PROTOPIE_RECOMPUTE_CRON"] },
                                                                                # default "0 2 * * *"
```

And in `infra/{dev,prod}/.env`, add the values:

```bash
PROTOPIE_ENABLED=true
PROTOPIE_PROJECT_UUID=<the lightdash project UUID that owns the protopie content>
PROTOPIE_WAREHOUSE_MART_TABLE=warehouse.mart_account_usage_90d
PROTOPIE_RECOMPUTE_CRON=0 2 * * *
```

For dev, set `PROTOPIE_ENABLED=true` only when actively testing; `false` otherwise keeps the dev box fast.

## Step 3 — Network access for the Airflow DAG

The Airflow DAG (in the data-modeling repo's deployment) reads `protopie_*` tables from the Lightdash app DB and writes to Redshift. It needs:

| Concern | Setting |
|---------|---------|
| Source: Lightdash RDS endpoint | `module.lightdash_db.db_instance_endpoint` from Terraform output |
| Source credentials | A **read-only** Postgres user — NOT the Lightdash app's read-write user |
| Network path | RDS security group (`aws_security_group.database_sg`) must allow ingress from Airflow's source — likely a worker VPC SG |
| TLS | RDS has `rds.force_ssl = "0"` today (off). Either enable SSL on RDS and tell Airflow to use SSL, or accept un-encrypted traffic *only* if the VPC is private. Recommend enabling SSL. |

### Create the read-only role

Run once via `psql` against the RDS instance:

```sql
CREATE ROLE protopie_readonly LOGIN PASSWORD '<rotated-quarterly>';
GRANT CONNECT ON DATABASE lightdash TO protopie_readonly;
GRANT USAGE ON SCHEMA public TO protopie_readonly;
GRANT SELECT ON
    protopie_form_submissions,
    protopie_form_definitions,
    protopie_churn_score_configs,
    protopie_churn_score_factors,
    protopie_churn_score,
    protopie_churn_score_runs,
    protopie_account_overrides,
    protopie_organization_settings,
    protopie_mcp_audit_log,
    protopie_dashboard_bootstrap_runs
TO protopie_readonly;
-- Auto-grant on future Protopie tables:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO protopie_readonly;
```

Store the password in AWS Secrets Manager and reference from Airflow connections — never in `.env` or `tfstate`.

### Security group rule

In `lightdash-infra/infra/{prod,dev}/services-security-group.tf`, add an ingress rule allowing the Airflow worker SG (or specific IP range) to hit the RDS port:

```hcl
resource "aws_security_group_rule" "rds_from_airflow" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.database_sg.id
  source_security_group_id = var.airflow_worker_sg_id    # add as a tf variable
}
```

## Multiple containers? No, single task

The current task definition runs **one container** (`lightdash`) with `SCHEDULER_ENABLED=true`, meaning the same process handles HTTP + Graphile Worker. Pros: simple. Cons: a heavy scheduler job blocks API responses; also no headless browser container is deployed (so dashboard PDF export will silently fail).

For Protopie v1 this is fine — the nightly recompute task is small (< 30s) and we don't ship dashboard PDF export as a feature. If load grows, split into:

1. Two ECS services in the cluster:
   - `lightdash-api`: `SCHEDULER_ENABLED=false`, runs HTTP only
   - `lightdash-worker`: `SCHEDULER_ENABLED=true`, runs scheduler only

   ALB routes only to `lightdash-api`. Both pull the same image and read the same `.env`.

2. Add a third container if PDFs are needed: `lightdash/headless-browser`.

Defer this split until we have evidence we need it.

## Deploy flow for a Protopie release

```
1. Eng merges PR to main on github.com/ProtoPie/lightdash
2. GitHub Actions builds image, pushes to ECR with tag = commit SHA + "latest"
3. Eng SSH-equivalent: cd lightdash-infra/infra/dev
4. Edit .env if env vars changed
5. terraform plan          # review the task-definition diff
6. terraform apply         # ECS service rolls task definition; one new task spun up before old killed
7. Smoke test dev
8. Repeat steps 3-7 in infra/prod with the same image tag (pinned)
9. Commit lightdash-infra changes including the updated tfstate
```

## Rollback

ECS service supports rolling back the task definition revision:

```bash
# list the last 5 task definition revisions
aws ecs list-task-definitions --family-prefix lightdash --status ACTIVE --sort DESC --max-items 5

# revert the service to a prior revision
aws ecs update-service \
  --cluster lightdash-cluster \
  --service lightdash-service \
  --task-definition lightdash:<prior-revision>
```

Or via Terraform: change `var.lightdash_oci_tag` back to the previous SHA, `terraform apply`. Reverting the image is the simplest rollback; reverting tfstate to a prior commit also works but is riskier (resets _everything_ in the stack).

## Health checks & observability

| Surface | Where |
|---------|-------|
| ECS task health | ALB target health (200 on `/`) |
| Application logs | CloudWatch `/ecs/lightdash-log-groups` — `awslogs-stream-prefix = lightdash-ecs` |
| Slow query / scheduler errors | CloudWatch + Sentry (if `SENTRY_DSN` env var is set — currently missing in `.env.local`; add for Protopie) |
| RDS metrics | CloudWatch RDS namespace |
| S3 errors | CloudWatch S3 namespace |
| Custom Protopie metrics | Lightdash's existing analytics (`LightdashAnalytics.track`); export to your downstream analytics pipeline |

We propose adding `SENTRY_DSN` to the ECS env vars so backend errors land in Sentry. The Protopie module already uses Sentry (`@sentry/node` is imported in `BaseService` and propagates to controllers). Just need to set the DSN.

## Open infra questions

- The user said "EKS"; the code says "ECS Fargate". If there's a separate EKS deployment that's the actual prod target, the relevant Helm chart / Kubernetes manifests are not in `lightdash-infra/` and this doc needs an update. Flag this; confirm and I'll rewrite.
- `terraform.tfstate` is committed to git per the README. Migrate to S3-only state (drop from git) — the S3 backend is already configured.
- `.env` lives in `infra/{dev,prod}/` and likely contains secrets. Confirm `.gitignore` excludes `.env` (and not just `.env.local`), and migrate sensitive values to Secrets Manager.
- `rds.force_ssl = "0"`. Enable SSL and update Lightdash's `PGCONNECTIONURI` to require it.
- No `lightdash_db.db_instance_endpoint` output is exported by the existing Terraform — we add `output "lightdash_db_endpoint"` so the Airflow DAG can reference it without hard-coding.
- No separate headless browser container — dashboard PDF export will fail silently. Acceptable for v1; revisit if PDF export becomes a requirement.

## Quick reference

```
Fork repo:              https://github.com/ProtoPie/lightdash
Infra repo:             /Users/mamur/Documents/projects/lightdash-infra
ECS cluster:            lightdash-cluster (dev + prod)
ECS service:            lightdash-service
ALB listener:           configured via target-group-rule.tf
RDS instance:           lightdash-db (postgres 15, db.t3.micro)
S3 bucket:              from .env S3_BUCKET
ECR repo (proposed):    <account>.dkr.ecr.us-west-2.amazonaws.com/protopie/lightdash
AWS region:             us-west-2
Terraform state:        s3://xid-prod-terraform/lightdash-prod (lockfile-based)
```
