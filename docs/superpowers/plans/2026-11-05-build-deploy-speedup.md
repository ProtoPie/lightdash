# Build & Deploy Speedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 코드 push 후 dev에 뜨기까지 25~35분(그중 로컬 점유 25분)을 10~13분(로컬 점유 3분)으로 줄인다.

**Architecture:** 이미지 빌드는 GitHub Actions(`build-image.yml`, 이미 존재)가 하고 ECR에 `dev-<sha>`/`prod-<sha>`로 올린다. 사람은 `make deploy-dev BUILD=0 DEV_IMAGE_TAG=<tag>`로 terraform plan을 확인하고 apply만 한다. 이미지에서 dbt venv 8개를 1개로 줄이고, 로컬 빌드는 ECR 레지스트리 캐시를 읽고, ALB health check를 빠르게 바꾼다.

**Tech Stack:** Docker BuildKit, GitHub Actions (OIDC → ECR), Terraform (AWS ECS Fargate + ALB), Make.

**Spec:** 별도 스펙 문서 없음. 2026-11-05 조사 결과 요약:

| 원인 | 현재 | 목표 |
|---|---|---|
| CI `build-image` 2026-09-04 이후 미실행 → 로컬 빌드 | 로컬 15~25분 | CI 5~10분, 로컬 0분 |
| dbt venv 8개(1.4~1.11) × 어댑터 7종 | 이미지 수 GB | 1개 |
| 로컬 `make build-dev`에 `--cache-from` 없음 | 매번 풀빌드 | ECR `buildcache-*` 재사용 |
| ALB health check 60s × 5회, deregistration 300s | 롤아웃 8~10분 | 10s × 2회, 30s → 약 2분 |
| upstream 워크플로우 9개가 depot 러너 대기 (queued 48개) | 노이즈 | 삭제 |

## Global Constraints

- 배포 흐름은 `lightdash-deploy-flow` 스킬을 따른다: terraform plan에 destroy가 있으면 apply 금지. prod는 `CONFIRM=PROD` 필수.
- Protopie 코드 격리 규칙은 이 계획과 무관 (코드 변경 없음, 빌드/인프라 파일만).
- 이미지 타겟은 `prod`, 플랫폼은 `linux/amd64` 유지.
- 커밋은 작업 단위로 한 개씩. 브랜치: `chore/build-deploy-speedup` (base: `main`).
- 설치 명령은 쓰지 않는다 (의존성 변경 없음).

## Review Focus

1. dev/prod 프로젝트의 dbt 버전이 남겨둔 venv와 다르면 "Refresh dbt"가 `dbt1.x: not found`로 실패한다. → Task 0에서 실제 값을 확인하고 Task 3에서 그 바이너리만 남긴다.
2. ALB health check를 10초×2회로 줄여도 `health_check_grace_period_seconds = 120`은 유지해야 한다. 마이그레이션이 긴 배포에서 grace가 짧으면 태스크가 죽고 재시작을 반복한다. → Task 5 검증에서 롤아웃 `COMPLETED`를 확인한다.
3. `--cache-from`이 가리키는 `buildcache-dev` 태그가 ECR에 없을 때(첫 실행) buildx는 경고만 내고 진행해야 한다. → Task 4 검증에서 태그 없는 상태로 한 번 돌린다.
4. `pr.yml`을 지우면 branch protection의 required status check가 영원히 pending이 될 수 있다. → Task 1에서 repo 설정의 required checks를 확인한다.
5. CI가 안 도는 원인이 과금 한도가 아닐 수 있다. → Task 0에서 `workflow_dispatch` 수동 실행으로 실제 복구 여부를 확인하고, 안 되면 원인을 적은 뒤 Task 1~5는 그대로 진행한다 (로컬 빌드도 Task 3·4·5의 이득은 그대로 받는다).

---

### Task 0: 사전 확인 (코드 변경 없음)

**Files:** 없음. 결과는 이 문서 하단 "Task 0 결과"에 기록.

**Produces:** `DBT_KEEP` (예: `1.11`), `CI_STATUS` (`ok` | `blocked:<이유>`), `REQUIRED_CHECKS` (목록 또는 없음).

- [ ] **Step 1: CI가 왜 안 도는지 확인**

GitHub 웹 → Organization `ProtoPie` → Settings → Billing and plans → "Actions" 사용량과 spending limit 확인. 한도 초과면 한도 상향 또는 결제 갱신.

- [ ] **Step 2: 수동 실행으로 복구 확인**

```bash
gh workflow run build-image.yml --ref develop -f environment=dev
sleep 60; gh run list --workflow=build-image.yml --limit 1 --json status,conclusion,databaseId
```
Expected: `status` 가 `in_progress` 또는 `completed`/`success`. `queued`에 머물면 Step 1로 돌아간다. 결과를 `CI_STATUS`에 기록.

- [ ] **Step 3: 프로젝트의 dbt 연결 방식과 버전 확인**

dev, prod 각각 Lightdash UI → Project settings → "dbt connection" 탭. 또는 API:

```bash
curl -s -H "Authorization: ApiKey $LDPAT" "$SITE_URL/api/v1/projects/<PROJECT_UUID>" \
  | python3 -c "import json,sys; r=json.load(sys.stdin)['results']; print(r['dbtConnection']['type'], r.get('dbtVersion'))"
```
Expected 출력 예: `github latest` 또는 `none`. 규칙:
- type이 `github`/`gitlab`/`bitbucket`/`azure_devops`/`dbt`이면 dbt 필요. `dbtVersion`이 `latest`면 `DBT_KEEP=1.11` (`getLatestSupportDbtVersion()` = enum 마지막 = v1.11), 아니면 그 버전.
- type이 `none`/`manifest`/`dbt_cloud_ide`이면 `DBT_KEEP=none`.
- dev와 prod가 다르면 둘 다 남긴다.

- [ ] **Step 4: branch protection required checks 확인**

```bash
gh api repos/ProtoPie/lightdash/branches/main/protection/required_status_checks --jq '.contexts' 2>&1
gh api repos/ProtoPie/lightdash/branches/develop/protection/required_status_checks --jq '.contexts' 2>&1
```
Expected: `404`(보호 없음) 또는 컨텍스트 목록. `pr.yml`의 잡 이름(`Build & Test` 등)이 있으면 `REQUIRED_CHECKS`에 기록.

- [ ] **Step 5: 결과 기록**

이 파일 맨 아래 "Task 0 결과" 표를 채우고 커밋:

```bash
git checkout -b chore/build-deploy-speedup main
git add docs/superpowers/plans/2026-11-05-build-deploy-speedup.md
git commit -m "docs(ci): record build/deploy speedup preflight results"
```

---

### Task 1: upstream 워크플로우 삭제

**Files:**
- Delete: `.github/workflows/pr.yml`, `renovate.yml`, `release.yml`, `post-release.yml`, `release-qa.yml`, `test-easy-install.yml`, `validate-pr-title.yml`, `ai-agent-integration-tests.yml`, `cache-cleanup.yml`
- Delete: `.github/workflows/_setup_node_pnpm_cypress/` (pr.yml만 참조)
- Keep: `.github/workflows/build-image.yml`

**Consumes:** Task 0 `REQUIRED_CHECKS`.

- [ ] **Step 1: 참조 확인**

```bash
grep -rl "_setup_node_pnpm_cypress\|workflow_call" .github/workflows/
```
Expected: `pr.yml`만. 다른 파일이 나오면 그 파일도 삭제 대상인지 확인.

- [ ] **Step 2: 삭제**

```bash
cd .github/workflows && git rm -r pr.yml renovate.yml release.yml post-release.yml release-qa.yml \
  test-easy-install.yml validate-pr-title.yml ai-agent-integration-tests.yml cache-cleanup.yml _setup_node_pnpm_cypress
ls
```
Expected: `build-image.yml`만 남음.

- [ ] **Step 3: required checks 정리**

`REQUIRED_CHECKS`에 pr.yml 잡이 있으면 GitHub 웹 → Settings → Branches → 해당 규칙에서 그 체크를 제거. 없으면 건너뜀.

- [ ] **Step 4: 대기 중인 run 취소**

```bash
gh run list --status queued --limit 100 --json databaseId --jq '.[].databaseId' | xargs -n1 gh run cancel
gh run list --status queued --limit 5
```
Expected: 두 번째 명령 출력이 비어 있음.

- [ ] **Step 5: 커밋**

```bash
git commit -m "ci: remove upstream workflows that need depot runners (fork keeps build-image only)"
```

---

### Task 2: `build-image.yml` 트리거 정리

**Files:**
- Modify: `.github/workflows/build-image.yml:15-27`

**Produces:** push 트리거가 `develop`, `main`에서 돌고, `infra/**`·`Makefile`·`docs/**`·`*.md`만 바뀐 push는 건너뜀. `workflow_dispatch`는 기존대로 (dev는 아무 ref, prod는 main만).

- [ ] **Step 1: `paths-ignore` 확장**

`on.push.paths-ignore`에 `'infra/**'`, `'Makefile'`을 추가. 다른 트리거는 그대로.

- [ ] **Step 2: 문법 확인**

```bash
gh workflow view build-image.yml --yaml | head -30
```
Expected: 추가한 두 줄이 보임. (actionlint가 있으면 `actionlint .github/workflows/build-image.yml` → 출력 없음.)

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/build-image.yml
git commit -m "ci(build-image): skip image build for infra-only and Makefile-only pushes"
```

---

### Task 3: Dockerfile dbt 다이어트

**Files:**
- Modify: `dockerfile:49-147` (base 스테이지 venv 블록 2개), `dockerfile:374-390` (prod 스테이지 COPY + 심링크), `dockerfile:358-360` (prod 스테이지 python3 apt, `DBT_KEEP=none`일 때만)

**Consumes:** Task 0 `DBT_KEEP`.

**Produces:** 이미지에 `/usr/local/dbt<DBT_KEEP>` 하나와 `/usr/local/bin/dbt<DBT_KEEP>` 심링크만 존재. (`DBT_KEEP=1.4`인 경우 심링크 이름은 `dbt`. `DbtCliClient.ts:77-85`의 `DbtCommands` 매핑과 같다.)

- [ ] **Step 1: base 스테이지 정리**

`dockerfile:49-147`의 두 `RUN --mount=type=cache,target=/root/.cache/pip` 블록(49행, 61행 시작)을 하나로 합쳐 `DBT_KEEP` venv만 남긴다. 어댑터는 `dbt-core~=<ver>.0`, `dbt-redshift~=<ver>.0`(1.11은 기존처럼 `dbt-redshift~=1.10.0`), `psycopg2-binary==2.9.6`만. 다른 어댑터(snowflake, bigquery, databricks, trino, clickhouse, athena, duckdb) 줄 삭제. 심링크는 `ln -s /usr/local/dbt<ver>/bin/dbt /usr/local/bin/dbt<ver>` 한 줄 (1.4면 `/usr/local/bin/dbt`).

`DBT_KEEP=none`이면 두 RUN 블록 전체 삭제.

- [ ] **Step 2: prod 스테이지 정리**

`dockerfile:374-381` COPY 8줄 → `DBT_KEEP` 한 줄. `dockerfile:383-390` 심링크 8줄 → 한 줄. `DBT_KEEP=none`이면 둘 다 삭제하고 `dockerfile:358-360`의 `python3 python3-psycopg2 python3-venv` apt 줄도 삭제.

- [ ] **Step 3: 로컬 빌드로 검증**

```bash
make build-local SKIP_PREFLIGHT=1
docker run --rm --platform linux/amd64 lightdash-local:$(git rev-parse --short HEAD) dbt<DBT_KEEP> --version
docker images lightdash-local --format '{{.Tag}} {{.Size}}'
```
Expected: `Core: installed: <ver>.x`, `Plugins: redshift`. 이미지 크기를 Task 0 결과 표에 기록 (기존 대비 비교).
`DBT_KEEP=none`이면 두 번째 명령 대신 `... sh -c 'command -v dbt || echo no-dbt'` → `no-dbt`.

- [ ] **Step 4: 커밋**

```bash
git add dockerfile
git commit -m "build(docker): ship only dbt <DBT_KEEP> + redshift adapter (was 8 venvs x 7 adapters)"
```

---

### Task 4: 로컬 빌드가 ECR 레지스트리 캐시를 읽게 하기

**Files:**
- Modify: `Makefile:142-152` (`build-dev`), `Makefile:199-208` (`build-prod`), `Makefile:118-125` (`build-local`)

**Produces:** 세 타겟의 `docker buildx build`에 `--cache-from "type=registry,ref=$(IMAGE_REPO):buildcache-<env>"` 추가. dev/local은 `buildcache-dev`, prod는 `buildcache-prod`. `--cache-to`는 추가하지 않는다 (CI가 쓰는 캐시를 로컬이 덮어쓰지 않도록).

- [ ] **Step 1: 변수 추가**

`Makefile` 상단 `PROD_IMAGE_TAG` 아래에:
```make
DEV_CACHE_REF ?= $(IMAGE_REPO):buildcache-dev
PROD_CACHE_REF ?= $(IMAGE_REPO):buildcache-prod
```

- [ ] **Step 2: 세 타겟에 `--cache-from` 추가**

`build-local`과 `build-dev`에 `--cache-from "type=registry,ref=$(DEV_CACHE_REF)" \`, `build-prod`에 `--cache-from "type=registry,ref=$(PROD_CACHE_REF)" \`. `build-local`은 ECR 로그인이 선행되어야 하므로 의존성을 `preflight ecr-login`으로 변경.

- [ ] **Step 3: 캐시 없는 경우 검증**

```bash
make build-local SKIP_PREFLIGHT=1 DEV_CACHE_REF=$(IMAGE_REPO):buildcache-does-not-exist 2>&1 | grep -iE 'cache|error' | head
```
Expected: `importing cache manifest ... not found` 류 경고만 있고 빌드는 계속 진행 (exit 0).

- [ ] **Step 4: 캐시 있는 경우 검증**

Task 0에서 CI가 복구됐다면 (`CI_STATUS=ok`) CI run 하나가 끝난 뒤:
```bash
make build-dev 2>&1 | tee /tmp/build-dev.log | grep -c CACHED
```
Expected: `CACHED` 줄이 10개 이상 (base·prod-builder·pnpm install 레이어). 전체 시간을 Task 0 결과 표에 기록.

- [ ] **Step 5: 커밋**

```bash
git add Makefile
git commit -m "build(make): reuse ECR registry build cache for local image builds"
```

---

### Task 5: ALB health check / deregistration 단축 (dev → prod)

**Files:**
- Modify: `infra/dev/target-group.tf:14-19`, `infra/prod/target-group.tf:14-19`

**Produces:** 두 환경 target group에
```hcl
deregistration_delay = 30
health_check {
  interval            = 10
  path                = "/api/v1/health"
  healthy_threshold   = 2
  unhealthy_threshold = 3
}
```
`infra/*/ecs.tf`의 `health_check_grace_period_seconds = 120`은 그대로.

- [ ] **Step 1: dev 수정**

`infra/dev/target-group.tf`에서 `interval 60→10`, `healthy_threshold 5→2`, 리소스 블록에 `deregistration_delay = 30` 추가.

- [ ] **Step 2: dev plan**

```bash
make plan-dev DEV_IMAGE_TAG=$(aws ecs describe-services --profile xid-prod --region us-west-2 --cluster lightdash-cluster-dev --services lightdash-service-dev --query 'services[0].taskDefinition' --output text | xargs -I{} aws ecs describe-task-definition --profile xid-prod --region us-west-2 --task-definition {} --query 'taskDefinition.containerDefinitions[0].image' --output text | sed 's/.*://')
```
Expected: `Plan: 0 to add, 1 to change, 0 to destroy.` (target group in-place). destroy가 있으면 중단.

- [ ] **Step 3: dev apply + 롤아웃 시간 측정**

```bash
cd infra/dev && terraform apply -auto-approve -var "lightdash_image_repo=<IMAGE_REPO>" -var "lightdash_oci_tag=<현재 태그>" && cd ../..
date; make deploy-dev-quick
watch -n 10 'aws ecs describe-services --profile xid-prod --region us-west-2 --cluster lightdash-cluster-dev --services lightdash-service-dev --query "services[0].deployments[].{s:status,r:rolloutState,run:runningCount}" --output table'
```
Expected: 새 deployment `rolloutState=COMPLETED`까지 3분 이내, 이전 deployment 사라짐. `make health-dev` 200. 시간을 결과 표에 기록.

- [ ] **Step 4: dev 커밋**

```bash
git add infra/dev/target-group.tf
git commit -m "infra(dev): faster ALB health check (10s x2) and 30s deregistration"
```

- [ ] **Step 5: prod 동일 적용**

`infra/prod/target-group.tf` 같은 변경 → `make plan-prod PROD_IMAGE_TAG=<현재 prod 태그>` → `0 to destroy` 확인 → 업무 시간 외에 `terraform apply` (CONFIRM 절차는 `deploy-prod`와 동일하게 수동 확인) → `make logs-prod`로 health 200 확인.

```bash
git add infra/prod/target-group.tf
git commit -m "infra(prod): faster ALB health check (10s x2) and 30s deregistration"
```

---

### Task 6: 문서 갱신

**Files:**
- Modify: `Makefile:3-12` (헤더 주석), `infra/README.md` (prod 비활성 문구), `CLAUDE.md` "Deployment" 절

- [ ] **Step 1: Makefile 헤더**

"PROD is intentionally NOT deployable" 문단을 삭제하고 표준 흐름을 적는다:
```
# Standard flow: push to develop/main -> GitHub Actions builds + pushes ECR image
#   make deploy-dev  BUILD=0 DEV_IMAGE_TAG=dev-<sha>
#   make deploy-prod BUILD=0 PROD_IMAGE_TAG=prod-<sha> CONFIRM=PROD
# Local build (make build-dev) is the fallback when CI is unavailable; it reads the ECR build cache.
```

- [ ] **Step 2: infra/README.md, CLAUDE.md**

`infra/README.md`에서 "prod disabled" 문구 삭제. `CLAUDE.md` Deployment 절의 **Deploy** 줄을 "CI builds; deploy with `BUILD=0`" 기준으로 고치고, **Image** 줄에 dbt venv 1개만 포함됨을 한 줄 추가.

- [ ] **Step 3: 커밋 + PR**

```bash
git add Makefile infra/README.md CLAUDE.md
git commit -m "docs: describe CI-build + BUILD=0 deploy flow"
git push -u origin chore/build-deploy-speedup
gh pr create --base main --title "chore: speed up image build and deploy" --body-file docs/superpowers/plans/2026-11-05-build-deploy-speedup.md
```

PR 머지 후 `build-image.yml`이 `main`에서 돌아 `prod-<sha>`를 만드는지 확인하고, 그 태그로 `make deploy-prod BUILD=0 CONFIRM=PROD`.

---

## Task 0 결과

| 항목 | 값 |
|---|---|
| `CI_STATUS` | |
| CI 미실행 원인 | |
| dev `dbtConnection.type` / `dbtVersion` | |
| prod `dbtConnection.type` / `dbtVersion` | |
| `DBT_KEEP` | |
| `REQUIRED_CHECKS` | |
| 이미지 크기 (전 → 후) | |
| 로컬 `make build-dev` 시간 (캐시 사용) | |
| dev 롤아웃 시간 (전 → 후) | |
