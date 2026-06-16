SHELL := /bin/bash
.DEFAULT_GOAL := help

# Lightdash fork — local build/deploy for the ProtoPie custom image.
#
# Source of truth for DEV infrastructure is the in-repo infra/ directory.
# DEV deploy is one command:  make deploy-dev   (build -> push -> plan -> apply)
# PROD is intentionally NOT deployable from here yet (prod still runs the
# upstream image; cutover requires a reconciled infra/prod + explicit approval).
#
# Override any default at invocation, for example:
#   make build-dev SKIP_PREFLIGHT=1
#   make deploy-dev DEV_IMAGE_TAG=dev-hotfix
AWS_REGION ?= us-west-2
# infra/dev currently uses xid-prod for both backend and provider.
DEV_AWS_PROFILE ?= xid-prod
ECR_AWS_PROFILE ?= xid-prod
AWS_ACCOUNT_ID ?= 750128304405
ECR_REPOSITORY ?= protopie/lightdash
ECR_REGISTRY := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
IMAGE_REPO := $(ECR_REGISTRY)/$(ECR_REPOSITORY)
DOCKERFILE ?= dockerfile
DOCKER_TARGET ?= prod
PLATFORM ?= linux/amd64
GIT_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)
DEV_IMAGE_TAG ?= dev-$(GIT_SHA)
DEV_LATEST_TAG ?= dev-latest
PROD_IMAGE_TAG ?= prod-$(GIT_SHA)
# Set SKIP_PREFLIGHT=1 to skip the backend typecheck (e.g. clean checkout w/o node_modules).
SKIP_PREFLIGHT ?=

# DEV ECS coordinates (used by deploy-dev-quick / logs-dev).
DEV_ECS_CLUSTER ?= lightdash-cluster-dev
DEV_ECS_SERVICE ?= lightdash-service-dev
DEV_LOG_GROUP ?= /ecs/lightdash-log-groups-dev

# PROD ECS coordinates (used by logs-prod).
PROD_ECS_CLUSTER ?= lightdash-cluster
PROD_ECS_SERVICE ?= lightdash-service
PROD_LOG_GROUP ?= /ecs/lightdash-log-groups

# Optional Sentry build args. Leave empty for normal builds.
SENTRY_BUILD_ARGS = \
	--build-arg SENTRY_AUTH_TOKEN="$(SENTRY_AUTH_TOKEN)" \
	--build-arg SENTRY_ORG="$(SENTRY_ORG)" \
	--build-arg SENTRY_RELEASE_VERSION="$(SENTRY_RELEASE_VERSION)" \
	--build-arg SENTRY_FRONTEND_PROJECT="$(SENTRY_FRONTEND_PROJECT)" \
	--build-arg SENTRY_BACKEND_PROJECT="$(SENTRY_BACKEND_PROJECT)" \
	--build-arg SENTRY_ENVIRONMENT="$(SENTRY_ENVIRONMENT)"

# Terraform deploy integration. infra/ in this repo is the DEV source of truth.
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
	@awk 'BEGIN {FS = ":.*##"; printf "\nLightdash fork — DEV build/deploy targets\n\n"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-22s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\nTypical dev workflow:\n"
	@printf "  make build-dev        # build + push image to ECR\n"
	@printf "  make plan-dev         # terraform plan only (review changes)\n"
	@printf "  make deploy-dev       # build + push + plan + (confirm) apply\n"
	@printf "  make deploy-dev-quick # restart current image, no rebuild\n"
	@printf "  make logs-dev         # tail dev CloudWatch logs\n"
	@printf "  make health-dev DEV_SITE_URL=https://lightdash-dev.protopie.io\n"
	@printf "\nResolved config:\n"
	@printf "  IMAGE_REPO=%s\n" "$(IMAGE_REPO)"
	@printf "  DEV_IMAGE_TAG=%s PLATFORM=%s DOCKER_TARGET=%s\n" "$(DEV_IMAGE_TAG)" "$(PLATFORM)" "$(DOCKER_TARGET)"
	@printf "  DEV_INFRA_DIR=%s\n\n" "$(DEV_INFRA_DIR)"

.PHONY: preflight
preflight: ## Run backend typecheck before build. Skip with SKIP_PREFLIGHT=1.
	@if [ "$(SKIP_PREFLIGHT)" = "1" ]; then \
		echo "Skipping preflight typecheck (SKIP_PREFLIGHT=1)"; \
	else \
		pnpm --filter backend typecheck; \
	fi

.PHONY: docker-mem-check
docker-mem-check: ## Warn about other running containers that can OOM the frontend build.
	@others=$$(docker ps --format '{{.Names}}' 2>/dev/null | grep -vE 'buildx_buildkit' | wc -l | tr -d ' '); \
	if [ "$$others" != "0" ]; then \
		echo "⚠️  $$others other container(s) running — the Vite frontend build can OOM (exit 137)."; \
		echo "    Consider 'docker stop' on heavy stacks (e.g. airflow) before building. Current usage:"; \
		docker stats --no-stream --format '    {{.Name}}\t{{.MemUsage}}' 2>/dev/null || true; \
	fi

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
	aws ecr get-login-password --profile "$(ECR_AWS_PROFILE)" --region "$(AWS_REGION)" | \
		docker login --username AWS --password-stdin "$(ECR_REGISTRY)"

.PHONY: ensure-ecr
ensure-ecr: ## Create or update the shared ECR repository with Terraform.
	@test -d "$(ECR_INFRA_DIR)" || (echo "Missing ECR_INFRA_DIR=$(ECR_INFRA_DIR)" && exit 1)
	cd "$(ECR_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	cd "$(ECR_INFRA_DIR)" && $(TERRAFORM) apply -auto-approve \
		-var "aws_profile=$(ECR_AWS_PROFILE)" \
		-var "aws_region=$(AWS_REGION)" \
		-var "ecr_repository_name=$(ECR_REPOSITORY)"

.PHONY: build-dev
build-dev: preflight docker-mem-check ecr-login ## Build and push the dev image to ECR.
	@echo "Building dev image $(IMAGE_REPO):$(DEV_IMAGE_TAG)"
	docker buildx build \
		--platform "$(PLATFORM)" \
		-f "$(DOCKERFILE)" \
		--target "$(DOCKER_TARGET)" \
		-t "$(IMAGE_REPO):$(DEV_IMAGE_TAG)" \
		-t "$(IMAGE_REPO):$(DEV_LATEST_TAG)" \
		$(SENTRY_BUILD_ARGS) \
		--push .
	@echo "Pushed $(IMAGE_REPO):$(DEV_IMAGE_TAG) (and $(DEV_LATEST_TAG))"

.PHONY: plan-dev
plan-dev: ## Terraform plan for dev only (no apply). Pass DEV_IMAGE_TAG to plan a specific image.
	@test -d "$(DEV_INFRA_DIR)" || (echo "Missing DEV_INFRA_DIR=$(DEV_INFRA_DIR)" && exit 1)
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) plan \
		-var "lightdash_image_repo=$(IMAGE_REPO)" \
		-var "lightdash_oci_tag=$(DEV_IMAGE_TAG)"

.PHONY: deploy-dev
deploy-dev: build-dev ## Build+push dev image, show plan, then apply after confirmation.
	@test -d "$(DEV_INFRA_DIR)" || (echo "Missing DEV_INFRA_DIR=$(DEV_INFRA_DIR)" && exit 1)
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) plan \
		-var "lightdash_image_repo=$(IMAGE_REPO)" \
		-var "lightdash_oci_tag=$(DEV_IMAGE_TAG)"
	@if [ "$(CONFIRM)" = "yes" ]; then \
		echo "CONFIRM=yes — applying dev."; \
	else \
		read -r -p "Apply the plan above to DEV? Type 'yes' to continue: " ans; \
		[ "$$ans" = "yes" ] || (echo "Aborted." && exit 1); \
	fi
	cd "$(DEV_INFRA_DIR)" && $(TERRAFORM) apply -auto-approve \
		-var "lightdash_image_repo=$(IMAGE_REPO)" \
		-var "lightdash_oci_tag=$(DEV_IMAGE_TAG)"

.PHONY: deploy-dev-quick
deploy-dev-quick: ## Restart the dev service on its current image (no rebuild, no terraform).
	aws ecs update-service \
		--profile "$(DEV_AWS_PROFILE)" --region "$(AWS_REGION)" \
		--cluster "$(DEV_ECS_CLUSTER)" --service "$(DEV_ECS_SERVICE)" \
		--force-new-deployment \
		--query "service.{service:serviceName,taskDef:taskDefinition,status:status}" --output table

.PHONY: logs-dev
logs-dev: ## Tail recent dev CloudWatch logs. Override SINCE (default 10m).
	aws logs tail "$(DEV_LOG_GROUP)" \
		--profile "$(DEV_AWS_PROFILE)" --region "$(AWS_REGION)" \
		--since "$(or $(SINCE),10m)" --follow

.PHONY: build-prod
build-prod: preflight docker-mem-check ecr-login ## Build and push a prod-tagged image to ECR (image only; does NOT deploy).
	@echo "Building prod image $(IMAGE_REPO):prod-$(GIT_SHA)"
	docker buildx build \
		--platform "$(PLATFORM)" \
		-f "$(DOCKERFILE)" \
		--target "$(DOCKER_TARGET)" \
		-t "$(IMAGE_REPO):prod-$(GIT_SHA)" \
		$(SENTRY_BUILD_ARGS) \
		--push .
	@echo "Pushed $(IMAGE_REPO):prod-$(GIT_SHA)"

.PHONY: deploy-prod
plan-prod: ## Terraform plan for prod only (no apply). Pass PROD_IMAGE_TAG to plan a specific image.
	@test -d "$(PROD_INFRA_DIR)" || (echo "Missing PROD_INFRA_DIR=$(PROD_INFRA_DIR)" && exit 1)
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) plan \
		-var "lightdash_image_repo=$(IMAGE_REPO)" \
		-var "lightdash_oci_tag=$(PROD_IMAGE_TAG)"

deploy-prod: ## PROD cutover. Build+push prod image, show plan, require CONFIRM=PROD before apply.
	@echo "⚠️  PROD deploy. This cuts production over to $(IMAGE_REPO):$(PROD_IMAGE_TAG)." >&2
	@echo "    Ensure a fresh prod RDS snapshot exists before proceeding." >&2
	@test -d "$(PROD_INFRA_DIR)" || (echo "Missing PROD_INFRA_DIR=$(PROD_INFRA_DIR)" && exit 1)
	$(MAKE) build-prod
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) init -upgrade=false
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) plan \
		-var "lightdash_image_repo=$(IMAGE_REPO)" \
		-var "lightdash_oci_tag=$(PROD_IMAGE_TAG)"
	@if [ "$(CONFIRM)" = "PROD" ]; then \
		echo "CONFIRM=PROD — applying production."; \
	else \
		read -r -p "Apply the plan above to PRODUCTION? Type 'PROD' to continue: " ans; \
		[ "$$ans" = "PROD" ] || (echo "Aborted." && exit 1); \
	fi
	cd "$(PROD_INFRA_DIR)" && $(TERRAFORM) apply -auto-approve \
		-var "lightdash_image_repo=$(IMAGE_REPO)" \
		-var "lightdash_oci_tag=$(PROD_IMAGE_TAG)"

logs-prod: ## Tail recent prod CloudWatch logs. Override SINCE (default 10m).
	aws logs tail "$(PROD_LOG_GROUP)" \
		--profile "$(ECR_AWS_PROFILE)" --region "$(AWS_REGION)" \
		--since "$(or $(SINCE),10m)" --follow

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
		"  HEADLESS_BROWSER_HOST=localhost" \
		"  HEADLESS_BROWSER_PORT=3001" \
		"  INTERNAL_LIGHTDASH_HOST=https://<dev-lightdash-domain>" \
		"  PROTOPIE_DBT_LOCAL_PATH=/Users/mamur/Documents/projects/data-modeling" \
		"  PROTOPIE_DBT_GITHUB_OWNER=ProtoPie" \
		"  PROTOPIE_DBT_GITHUB_REPO=data-modeling" \
		"  PROTOPIE_DBT_GITHUB_REF=main" \
		"  PROTOPIE_DBT_GITHUB_TOKEN=<fine-grained-read-only-pat>" \
		"  PROTOPIE_DBT_ALLOWED_PATHS=models,marts,macros,seeds,snapshots,analyses,analysis,tests,dbt_project.yml,packages.yml,selectors.yml,exposures.yml,README.md"

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

.PHONY: health-dev
health-dev: ## Check dev Lightdash health. Usage: make health-dev DEV_SITE_URL=https://...
	@test -n "$(DEV_SITE_URL)" || (echo "Set DEV_SITE_URL=https://..." && exit 1)
	curl -fsS "$(DEV_SITE_URL)/api/v1/health"

.PHONY: mcp-auth-check-dev
mcp-auth-check-dev: ## Check dev MCP endpoint returns auth challenge. Usage: make mcp-auth-check-dev DEV_SITE_URL=https://...
	@test -n "$(DEV_SITE_URL)" || (echo "Set DEV_SITE_URL=https://..." && exit 1)
	curl -i -sS "$(DEV_SITE_URL)/api/v1/mcp" | sed -n '1,12p'
