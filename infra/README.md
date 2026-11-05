# Lightdash Infra

Terraform for the ProtoPie Lightdash deployment. **This in-repo `infra/` is the
source of truth for DEV** (reconciled to byte-match the live dev stack). The separate
`lightdash_Infra` repo is deprecated.

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

### PROD

Prod has run the custom image since the 2026-06-17 cutover. Images are built by GitHub
Actions (`.github/workflows/build-image.yml`) on push to `main` and tagged `prod-<sha>`.
Deploy a built image with `make deploy-prod BUILD=0 PROD_IMAGE_TAG=prod-<sha> CONFIRM=PROD`
after reviewing `terraform plan` for destroys. See the `lightdash-deploy-flow` skill.

## Sensitive Files

`.env`, `.terraform/`, and `terraform.tfstate*` are gitignored. Runtime secrets come
from SSM Parameter Store `/lightdash/<env>/*` (injected via the ECS task definition
`secrets[]`); `.env` carries non-secret config only. Refresh local `.env` with
`lightdash_Infra/scripts/pull-secrets.sh`. Never commit secrets or Terraform state.
