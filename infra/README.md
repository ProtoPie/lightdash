# Lightdash Infra

Terraform for the ProtoPie Lightdash deployment. **This in-repo `infra/` is the
source of truth for DEV** (reconciled to byte-match the live dev stack). The separate
`lightdash_Infra` repo currently still owns prod and will be deprecated after the prod
cutover.

## Layout

- `dev/` - development ECS/RDS/S3 stack (lightdash + browserless sidecar)
- `prod/` - production ECS/RDS/S3 stack
- `ecr/` - shared ECR repository for the custom Lightdash image

## Deploy

From the repo root:

```bash
make deploy-dev        # build image -> push to ECR -> terraform plan -> (confirm) -> apply
make plan-dev          # terraform plan only (review changes, no apply)
make deploy-dev-quick  # restart current image (force-new-deployment), no rebuild
make logs-dev          # tail dev CloudWatch logs
```

`make deploy-dev` builds the forked Lightdash Docker image, pushes it to ECR, shows the
Terraform plan, and applies **only after you confirm** with:

- `lightdash_image_repo` (ECR repo URI)
- `lightdash_oci_tag` (image tag, defaults to `dev-<git-sha>`)

### PROD is disabled

`make deploy-prod` is intentionally disabled. Production still runs the upstream
`lightdash/lightdash` image; cutting it over to the custom ECR image requires a
reconciled `infra/prod` and explicit human approval. Never deploy prod from these
targets. See the `lightdash-deploy-flow` skill for the full rules.

## Sensitive Files

`.env`, `.terraform/`, and `terraform.tfstate*` are gitignored. Runtime secrets come
from SSM Parameter Store `/lightdash/<env>/*` (injected via the ECS task definition
`secrets[]`); `.env` carries non-secret config only. Refresh local `.env` with
`lightdash_Infra/scripts/pull-secrets.sh`. Never commit secrets or Terraform state.
