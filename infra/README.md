# Lightdash Infra

Terraform for the Protopie Lightdash deployment now lives in this repo.

## Layout

- `dev/` - development ECS/RDS/S3 stack
- `prod/` - production ECS/RDS/S3 stack
- `ecr/` - shared ECR repository for the custom Lightdash image

## Deploy

From the repo root:

```bash
make deploy-dev
make deploy-prod
```

The Makefile builds the forked Lightdash Docker image, pushes it to ECR, then applies Terraform with:

- `lightdash_oci_image`
- `lightdash_oci_tag`

`make build-dev`, `make build-prod`, `make deploy-dev`, and `make deploy-prod` all ensure the shared ECR repository exists before pushing images.

## Sensitive Files

The moved `.env`, `.terraform/`, and `terraform.tfstate*` files remain on disk for local continuity, but they are ignored by git from this repo. Do not commit runtime secrets or Terraform state into the Lightdash application repo.
