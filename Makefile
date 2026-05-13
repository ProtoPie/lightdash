SHELL := /bin/bash
.DEFAULT_GOAL := help

# Build defaults. Override any of these at invocation time, for example:
#   make build-dev AWS_REGION=ap-northeast-2 ECR_REPOSITORY=protopie/lightdash
AWS_REGION ?= us-west-2
# infra/dev/main.tf currently uses xid-prod for both backend and provider.
DEV_AWS_PROFILE ?= xid-prod
PROD_AWS_PROFILE ?= xid-prod
ECR_AWS_PROFILE ?= xid-prod
ECR_REPOSITORY ?= protopie/lightdash
DOCKERFILE ?= dockerfile
DOCKER_TARGET ?= prod
PLATFORM ?= linux/amd64
GIT_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
DEV_IMAGE_TAG ?= dev-$(GIT_SHA)
PROD_IMAGE_TAG ?= prod-$(GIT_SHA)
DEV_LATEST_TAG ?= dev-latest
PROD_LATEST_TAG ?= prod-latest

# Optional Sentry build args. Leave empty for normal builds.
SENTRY_BUILD_ARGS = \
	--build-arg SENTRY_AUTH_TOKEN="$(SENTRY_AUTH_TOKEN)" \
	--build-arg SENTRY_ORG="$(SENTRY_ORG)" \
	--build-arg SENTRY_RELEASE_VERSION="$(SENTRY_RELEASE_VERSION)" \
	--build-arg SENTRY_FRONTEND_PROJECT="$(SENTRY_FRONTEND_PROJECT)" \
	--build-arg SENTRY_BACKEND_PROJECT="$(SENTRY_BACKEND_PROJECT)" \
	--build-arg SENTRY_ENVIRONMENT="$(SENTRY_ENVIRONMENT)"

# Terraform deploy integration. Override INFRA_DIR if needed.
INFRA_ROOT ?= $(CURDIR)/infra
ECR_INFRA_DIR ?= $(INFRA_ROOT)/ecr
DEV_INFRA_DIR ?= $(INFRA_ROOT)/dev
PROD_INFRA_DIR ?= $(INFRA_ROOT)/prod
TERRAFORM ?= terraform

REQUIRED_RUNTIME_ENV = \
	PORT \
	NODE_ENV \
	PGHOST \
	PGPORT \
	PGUSER \
	PGPASSWORD \
	PGDATABASE \
	LIGHTDASH_SECRET \
	SITE_URL \
	SECURE_COOKIES \
	TRUST_PROXY \
	MCP_ENABLED \
	GROUPS_ENABLED \
	SCHEDULER_ENABLED \
	S3_REGION \
	S3_BUCKET

OKTA_RUNTIME_ENV = \
	AUTH_OKTA_OAUTH_ISSUER \
	AUTH_OKTA_OAUTH_CLIENT_ID \
	AUTH_OKTA_OAUTH_CLIENT_SECRET \
	AUTH_OKTA_DOMAIN

.PHONY: help
help: ## Show available targets.
	@awk 'BEGIN {FS = ":.*##"; printf "\nLightdash fork build/deploy targets\n\n"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-28s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\nCommon overrides:\n"
	@printf "  AWS_REGION=%s ECR_AWS_PROFILE=%s DEV_AWS_PROFILE=%s PROD_AWS_PROFILE=%s ECR_REPOSITORY=%s\n" "$(AWS_REGION)" "$(ECR_AWS_PROFILE)" "$(DEV_AWS_PROFILE)" "$(PROD_AWS_PROFILE)" "$(ECR_REPOSITORY)"
	@printf "  DEV_IMAGE_TAG=%s PROD_IMAGE_TAG=%s PLATFORM=%s DOCKER_TARGET=%s\n\n" "$(DEV_IMAGE_TAG)" "$(PROD_IMAGE_TAG)" "$(PLATFORM)" "$(DOCKER_TARGET)"

.PHONY: preflight
preflight: ## Run compile/type checks that should pass before image build.
	pnpm --filter backend typecheck

.PHONY: build-local
build-local: preflight ## Build a local production image without pushing.
	docker buildx build \
		--platform "$(PLATFORM)" \
		-f "$(DOCKERFILE)" \
		--target "$(DOCKER_TARGET)" \
		-t "lightdash-local:$(GIT_SHA)" \
		$(SENTRY_BUILD_ARGS) \
		--load .

.PHONY: ecr-login
ecr-login: ## Login Docker to the shared ECR registry.
	@ACCOUNT_ID=$$(AWS_PROFILE="$(ECR_AWS_PROFILE)" aws sts get-caller-identity --query Account --output text); \
	REGISTRY="$$ACCOUNT_ID.dkr.ecr.$(AWS_REGION).amazonaws.com"; \
	aws ecr get-login-password --profile "$(ECR_AWS_PROFILE)" --region "$(AWS_REGION)" | docker login --username AWS --password-stdin "$$REGISTRY"

.PHONY: ecr-login-dev
ecr-login-dev: ecr-login ## Login Docker to the shared ECR registry for a dev build.

.PHONY: ecr-login-prod
ecr-login-prod: ecr-login ## Login Docker to the shared ECR registry for a prod build.

.PHONY: ensure-ecr
ensure-ecr: ## Create or update the shared ECR repository with Terraform.
	@test -d "$(ECR_INFRA_DIR)" || (echo "Missing ECR_INFRA_DIR=$(ECR_INFRA_DIR)" && exit 1)
	cd "$(ECR_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	cd "$(ECR_INFRA_DIR)" && $(TERRAFORM) apply -auto-approve \
		-var "aws_profile=$(ECR_AWS_PROFILE)" \
		-var "aws_region=$(AWS_REGION)" \
		-var "ecr_repository_name=$(ECR_REPOSITORY)"

.PHONY: ensure-ecr-dev
ensure-ecr-dev: ensure-ecr ## Create or update ECR before a dev build.

.PHONY: ensure-ecr-prod
ensure-ecr-prod: ensure-ecr ## Create or update ECR before a prod build.

.PHONY: build-dev
build-dev: preflight ensure-ecr-dev ecr-login-dev ## Build and push the dev image to ECR.
	@set -euo pipefail; \
	ACCOUNT_ID=$$(AWS_PROFILE="$(ECR_AWS_PROFILE)" aws sts get-caller-identity --query Account --output text); \
	IMAGE_REPO="$$ACCOUNT_ID.dkr.ecr.$(AWS_REGION).amazonaws.com/$(ECR_REPOSITORY)"; \
	echo "Building dev image $$IMAGE_REPO:$(DEV_IMAGE_TAG)"; \
	docker buildx build \
		--platform "$(PLATFORM)" \
		-f "$(DOCKERFILE)" \
		--target "$(DOCKER_TARGET)" \
		-t "$$IMAGE_REPO:$(DEV_IMAGE_TAG)" \
		-t "$$IMAGE_REPO:$(DEV_LATEST_TAG)" \
		$(SENTRY_BUILD_ARGS) \
		--push .; \
	echo "$$IMAGE_REPO:$(DEV_IMAGE_TAG)"

.PHONY: build-prod
build-prod: preflight ensure-ecr-prod ecr-login-prod ## Build and push the prod image to ECR.
	@set -euo pipefail; \
	ACCOUNT_ID=$$(AWS_PROFILE="$(ECR_AWS_PROFILE)" aws sts get-caller-identity --query Account --output text); \
	IMAGE_REPO="$$ACCOUNT_ID.dkr.ecr.$(AWS_REGION).amazonaws.com/$(ECR_REPOSITORY)"; \
	echo "Building prod image $$IMAGE_REPO:$(PROD_IMAGE_TAG)"; \
	docker buildx build \
		--platform "$(PLATFORM)" \
		-f "$(DOCKERFILE)" \
		--target "$(DOCKER_TARGET)" \
		-t "$$IMAGE_REPO:$(PROD_IMAGE_TAG)" \
		-t "$$IMAGE_REPO:$(PROD_LATEST_TAG)" \
		$(SENTRY_BUILD_ARGS) \
		--push .; \
	echo "$$IMAGE_REPO:$(PROD_IMAGE_TAG)"

.PHONY: deploy-dev
deploy-dev: build-dev ## Build dev image and apply Terraform with the new image tag.
	@test -d "$(DEV_INFRA_DIR)" || (echo "Missing DEV_INFRA_DIR=$(DEV_INFRA_DIR)" && exit 1)
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	@ACCOUNT_ID=$$(AWS_PROFILE="$(ECR_AWS_PROFILE)" aws sts get-caller-identity --query Account --output text); \
	IMAGE_REPO="$$ACCOUNT_ID.dkr.ecr.$(AWS_REGION).amazonaws.com/$(ECR_REPOSITORY)"; \
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) apply \
		-var "lightdash_oci_image=$$IMAGE_REPO" \
		-var "lightdash_oci_tag=$(DEV_IMAGE_TAG)"

.PHONY: deploy-prod
deploy-prod: build-prod ## Build prod image and apply Terraform with the new image tag.
	@test -d "$(PROD_INFRA_DIR)" || (echo "Missing PROD_INFRA_DIR=$(PROD_INFRA_DIR)" && exit 1)
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	@ACCOUNT_ID=$$(AWS_PROFILE="$(ECR_AWS_PROFILE)" aws sts get-caller-identity --query Account --output text); \
	IMAGE_REPO="$$ACCOUNT_ID.dkr.ecr.$(AWS_REGION).amazonaws.com/$(ECR_REPOSITORY)"; \
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) apply \
		-var "lightdash_oci_image=$$IMAGE_REPO" \
		-var "lightdash_oci_tag=$(PROD_IMAGE_TAG)"

.PHONY: print-runtime-env-dev
print-runtime-env-dev: ## Print runtime env expected by the dev ECS task/container.
	@printf "%s\n" \
		"Required dev runtime env:" \
		"  PORT=8080" \
		"  NODE_ENV=production" \
		"  PGHOST=<dev-rds-host>" \
		"  PGPORT=5432" \
		"  PGUSER=<dev-rds-user>" \
		"  PGPASSWORD=<dev-rds-password>" \
		"  PGDATABASE=<dev-rds-database>" \
		"  LIGHTDASH_SECRET=<stable-random-secret>" \
		"  SITE_URL=https://<dev-lightdash-domain>" \
		"  SECURE_COOKIES=true" \
		"  TRUST_PROXY=true" \
		"  MCP_ENABLED=true" \
		"  GROUPS_ENABLED=true" \
		"  SCHEDULER_ENABLED=true" \
		"  S3_REGION=$(AWS_REGION)" \
		"  S3_BUCKET=<dev-s3-bucket>" \
		"  S3_ACCESS_KEY=<omit-if-using-task-role>" \
		"  S3_SECRET_KEY=<omit-if-using-task-role>" \
		"  S3_FORCE_PATH_STYLE=false" \
		"  AUTH_DISABLE_PASSWORD_AUTHENTICATION=true" \
		"  AUTH_OKTA_OAUTH_CLIENT_ID=<okta-client-id>" \
		"  AUTH_OKTA_OAUTH_CLIENT_SECRET=<okta-client-secret>" \
		"  AUTH_OKTA_OAUTH_ISSUER=<okta-issuer>" \
		"  AUTH_OKTA_DOMAIN=<your-okta-domain>" \
		"  AUTH_OKTA_AUTHORIZATION_SERVER_ID=<optional-okta-auth-server-id>" \
		"  AUTH_OKTA_EXTRA_SCOPES=groups" \
		"  AUTH_ENABLE_GROUP_SYNC=true" \
		"" \
		"Optional dev runtime env:" \
		"  LIGHTDASH_QUERY_MAX_LIMIT=5000" \
		"  S3_USE_CREDENTIALS_FROM=container_metadata,instance_metadata" \
		"  APPS_S3_BUCKET=<dev-apps-s3-bucket>" \
		"  HEADLESS_BROWSER_HOST=<external-browser-host-if-exports-needed>" \
		"  HEADLESS_BROWSER_PORT=3000" \
		"  INTERNAL_LIGHTDASH_HOST=https://<dev-lightdash-domain>"

.PHONY: print-runtime-env-prod
print-runtime-env-prod: ## Print runtime env expected by the prod ECS task/container.
	@$(MAKE) --no-print-directory print-runtime-env-dev AWS_REGION="$(AWS_REGION)" | sed 's/dev/prod/g'

.PHONY: check-runtime-env
check-runtime-env: ## Check required runtime env vars in the current shell.
	@missing=0; \
	for name in $(REQUIRED_RUNTIME_ENV); do \
		if [ -z "$${!name}" ]; then \
			echo "Missing $$name"; \
			missing=1; \
		fi; \
	done; \
	exit $$missing

.PHONY: check-okta-env
check-okta-env: ## Check Okta env vars required for prod-style login and MCP OAuth.
	@missing=0; \
	for name in $(OKTA_RUNTIME_ENV); do \
		if [ -z "$${!name}" ]; then \
			echo "Missing $$name"; \
			missing=1; \
		fi; \
	done; \
	exit $$missing

.PHONY: check-prod-runtime-env
check-prod-runtime-env: check-runtime-env check-okta-env ## Check required runtime env plus Okta env.

.PHONY: health-dev
health-dev: ## Check dev Lightdash health. Usage: make health-dev DEV_SITE_URL=https://...
	@test -n "$(DEV_SITE_URL)" || (echo "Set DEV_SITE_URL=https://..." && exit 1)
	curl -fsS "$(DEV_SITE_URL)/api/v1/health"

.PHONY: health-prod
health-prod: ## Check prod Lightdash health. Usage: make health-prod PROD_SITE_URL=https://...
	@test -n "$(PROD_SITE_URL)" || (echo "Set PROD_SITE_URL=https://..." && exit 1)
	curl -fsS "$(PROD_SITE_URL)/api/v1/health"

.PHONY: mcp-auth-check-dev
mcp-auth-check-dev: ## Check dev MCP endpoint returns auth challenge. Usage: make mcp-auth-check-dev DEV_SITE_URL=https://...
	@test -n "$(DEV_SITE_URL)" || (echo "Set DEV_SITE_URL=https://..." && exit 1)
	curl -i -sS "$(DEV_SITE_URL)/api/v1/mcp" | sed -n '1,12p'

.PHONY: mcp-auth-check-prod
mcp-auth-check-prod: ## Check prod MCP endpoint returns auth challenge. Usage: make mcp-auth-check-prod PROD_SITE_URL=https://...
	@test -n "$(PROD_SITE_URL)" || (echo "Set PROD_SITE_URL=https://..." && exit 1)
	curl -i -sS "$(PROD_SITE_URL)/api/v1/mcp" | sed -n '1,12p'
