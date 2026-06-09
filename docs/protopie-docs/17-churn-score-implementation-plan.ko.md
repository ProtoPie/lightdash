# 17 — Churn Score: 구현 계획 (리뷰 초안)

> **상태:** 구현 시작됨. 이 계획을 바탕으로 백엔드 스키마, 서비스/API, 스케줄러 훅, 최소한의 루브릭/점수 UI가 진행 중이다.
>
> **목표:** **엔터프라이즈 고객**(team)별로 0–100 숫자를 계산하는 churn 점수를 출시한다. 점수는 영업이 직접 조정할 수 있는 **편집 가능한 루브릭(rubric)**으로 구동된다. 먼저 수동 재계산을 지원하고, 다음 단계로 매일 밤 예약 재계산을 자연스럽게 추가한다.

---

## 1. Notion 페이지 내용 — 공식 요약

영업은 현재 ChurnZero에서 10-factor 가중 점수를 운영한다. Notion 페이지 표 기준:

| 가중치 | Factor 이름 | 목표 (90일당) | 소스 이벤트 |
|--------|------------|---------------------|----------------|
| 5  | 시작 액션을 한 사용자 % | ≥ 50% | `Studio - App - Launched`, `Cloud - Studio - Launched`, `session_start`, `Cloud - Page - Entered` |
| 5  | 사용자당 시작 액션 수 | ≥ 20 | (동일 이벤트) |
| 10 | 활성화/로그인 사용자 % | ≥ 50% | `Studio - Login - Completed`, `editor_activated` |
| 10 | 사용자당 pie 생성/저장 액션 수 | ≥ 20 | `Studio - Pie - Created`, `Studio - Pie - Opened`, `Studio - Pie - Saved`, `Studio - Plugin - Imported`, `Studio - Preview - Opened` |
| 10 | pie 생성/저장 액션을 한 사용자 % | ≥ 50% | (동일 이벤트) |
| 10 | AI 기능을 사용한 사용자 % | ≥ 50% | `Studio - AI - Prompt Sent`, `Studio - AI Panel - Panel Toggled` |
| 15 | Trigger 또는 Response 액션을 한 사용자 % | ≥ 50% | `Studio - Response Interaction - Added`, `Studio - Trigger Interaction - Added` |
| 15 | 사용자당 trigger/response 액션 수 | ≥ 20 | (동일 이벤트) |
| 10 | 수신 메시지 수 | ≥ 5 | 편집 가능한 이벤트 매핑; 데이터 소스 확정 전까지 기본값 비어 있음 |
| 10 | 활성 일수 (Active days) | ≥ 10 | — (모든 이벤트 타임스탬프가 카운트됨) |
| **100** | | | |

**공식 (factor별, 선형 부분 점수):**

```
points_awarded = LEAST(actual_value / goal_value, 1) * max_points
```

**Account별 합산. 활성 factor의 합은 *100*.** 루브릭 편집기나 다운스트림 대시보드가 "어떤 max가 적용되는지"를 따질 필요가 없도록 **두 개**의 점수 값을 저장한다 (영업이 이후 가중치를 바꿔도 안전):

```
total_points     = SUM(points_awarded over active factors)          // 원시값, 0 → max_points (현재 100)
max_points       = SUM(max_points over active factors)              // 현재 100; 영업이 factor를 추가하면 변함
score_percent    = total_points / max_points                         // 0 → 1
normalized_score = score_percent * 100                               // 0 → 100, 사용자에게 보이는 숫자
risk_band        = CASE
    WHEN score_percent ≥ thresholds.low    THEN 'low'                // 기본값: 0.75 / 0.50
    WHEN score_percent ≥ thresholds.medium THEN 'medium'
    ELSE 'high'
END
```

Notion 페이지가 참조하는 두 앵커는 모두 선형 비례(linear-prorate) 형태를 뒷받침한다 (하나는 루브릭 스크린샷, 다른 하나는 "사용자당 12 이벤트 → 7 포인트" 예시인데, 이는 결국 `LEAST(12 / goal, 1) * weight`를 다르게 표현한 것). 아직 step-wise 함수는 없다.

> **가중치 합은 100이 아닌 임의의 값이 될 수 있다.** 영업은 합을 100 미만 또는 초과로 만드는 factor 추가/가중치 변경을 할 수 있다. 루브릭 편집기는 100이 아닌 합을 **거부하지 않는다** — 저장 버튼 옆에 현재 `SUM(max_points)`를 표시하고 그 값을 정규화 분모로 사용한다. 사용자에게 보이는 `normalized_score`는 가중치가 어떻게 변하든 항상 0–100이다. §9 참조.

---

## 2. 범위 (v1에 포함되는 것, 미루는 것)

### 범위 내 (v1 — 이 계획)

- **엔터프라이즈 고객별** (`dim_enterprise_summary`의 행, `namespace`로 `dim_team_summary`에 조인).
- 프로젝트당 **한 번에 하나의 활성 루브릭**; Postgres에 버전 관리되어 가중치 변경이 히스토리를 덮어쓰지 않음.
- **영업 편집 가능 루브릭**: factor (name, max_points, goal_value, goal_unit, events[], aggregation, window_days).
- **선형 부분 점수 공식만** (스키마에 향후 step-wise용 스위치 하나).
- 관리자/영업 리드가 루브릭 편집기 페이지에서 트리거하는 **수동 재계산 엔드포인트**.
- **일일 스냅샷 테이블** `protopie_churn_score`: (account_key, scored_for_date, config_uuid)당 한 행.
- **Factor별 분해**를 각 점수 행에 JSONB로 인라인 저장 (대시보드에는 충분; v1에는 별도 `factor_results` 테이블 없음).
- **`dim_team_summary.team_id`가 account key.** `namespace` / `cloud_url`은 표시 및 추후 Salesforce 조인용으로 함께 보유.

### v1.1로 미룸

- 예약 야간 재계산 (Graphile Worker cron). v1은 **task 핸들러**를 출시하지만 cron 라인은 선택 — 영업이 재계산 버튼을 누르면 됨.
- Account별 오버라이드 (점수 강제 / 제외). 설계 문서에는 이미 있으나 이 PR에는 없음.
- Salesforce 조인 (`salesforce_account_id`) — 컬럼은 예약, 소스가 생기면 채움.
- Step-wise 점수 함수.
- 루브릭 변경 시 과거 날짜 백필.
- UI의 risk-band 임계값 편집기 (임계값은 config의 `risk_band_thresholds` JSONB에 존재; v1은 편집기를 `0.75 / 0.50`로 하드코딩).

### 명시적 비목표 (non-goals)

- `find_explores` / `find_fields` / `run_metric_query`의 재구현 없음 — 백엔드는 `WarehouseClient`를 직접 사용. 디스커버리 도구는 AI 에이전트 전용.
- 새 MCP 도구 없음. (대시보드를 추가하면 점수는 `find_content`를 통해 에이전트에게 보이게 됨.)
- 자동 이메일 로깅 없음.

---

## 3. 데이터 소스 (`/Users/mamur/Documents/projects/data-modeling`에 대해 검증됨)

계산 시점에 읽는 입력값, 모두 `WarehouseClient`를 통해 Redshift에서 가져옴:

| 소스 | 필요한 이유 |
|--------|-----------------|
| `mart.dim_product_all_events` (`event_id`, `event_time`, `event_name`, `event_source`, `user_id`) | 이벤트 로그. Amplitude + Cloud를 이미 통합. |
| `mart.dim_product_all_event_properties` (`event_id`, `event_time`, `team_id`, `pie_id`, …) | 이벤트 → `team_id` 조인. 이것 없이는 이벤트를 Account에 귀속시킬 수 없음. |
| `mart.dim_team_summary` (`team_id`, `namespace`, `url`, `plan_type`, `plan_id`, …) | Account 식별자 + 플랜 메타데이터. |
| `mart.dim_enterprise_summary` (`namespace`, MRR, 계약 좌석 수) | 엔터프라이즈 고객으로 필터; 매출 컨텍스트 제공. |
| `mart.dim_latest_plan` (`team_id`, `plan_type`, `plan_id`) | 대시보드에서 Pro / Pro Plus / Enterprise 티어 구분. |

계산 쿼리는 재계산 실행당 하나의 큰 집계 쿼리다 (§6에 기술).

---

## 4. 새 Postgres 테이블 (이미 출시된 4개 외 추가)

단일 마이그레이션 `20260514000000_create_protopie_churn_score.ts`가 4개 테이블을 추가한다. 이름은 기존 `protopie_` 관례를 따른다.

**생성 순서 (FK 해소를 위해 중요):**

1. `protopie_churn_score_configs`
2. `protopie_churn_score_factors` (FK → configs)
3. `protopie_churn_score_runs` (FK → configs)
4. `protopie_churn_score` (FK → configs, FK → runs) — 둘 다 참조하므로 반드시 **마지막**.

`down()` 마이그레이션은 역순으로 드롭한다.

### 4.1 `protopie_churn_score_configs`

루브릭 **버전**당 한 행. `status='active'`가 되면 불변; 편집은 새 버전을 생성한다.

| 컬럼 | 타입 | 비고 |
|--------|------|-------|
| `config_uuid` | uuid pk | |
| `project_uuid` | uuid fk → projects | |
| `name` | text | 기본값 `'Default Churn Score'`. |
| `version` | int | `(project_uuid, name)`별 단조 증가. |
| `lookback_days` | int | 기본값 90. |
| `score_function` | text | v1에서는 `'linear'`만; `'stepwise'`용 예약 컬럼. |
| `risk_band_thresholds` | jsonb | `{ low: 0.75, medium: 0.50 }`. |
| `effective_from` | timestamptz | 이 버전이 권위를 갖기 시작한 시점. |
| `effective_to` | timestamptz null | 대체될 때 채워짐. |
| `status` | text | `'draft' \| 'active' \| 'archived'`. |
| `created_by_user_uuid` | uuid fk → users null | **Nullable** — 마이그레이션 시드에는 실제 사용자가 없음; 이후 API 편집 시 채워야 함. |
| `updated_by_user_uuid` | uuid fk → users null | 동일. |
| `created_at`, `updated_at` | timestamptz | |

Unique: `(project_uuid, name, version)`. `status='active' AND effective_to IS NULL` 조건의 `(project_uuid, name)` 인덱스.

### 4.2 `protopie_churn_score_factors`

config를 구성하는 N개의 factor. v1은 Notion 페이지의 9개를 정확히 출시한다.

| 컬럼 | 타입 | 비고 |
|--------|------|-------|
| `factor_uuid` | uuid pk | |
| `config_uuid` | uuid fk → configs (cascade) | |
| `factor_key` | text | 예: `pct_users_with_starting_action`. |
| `label` | text | UI 라벨. |
| `max_points` | numeric(5,2) | 가중치; 활성 factor 합은 임의 값 가능. 서비스가 활성 합으로 정규화. |
| `goal_value` | numeric(14,4) | 예: 50%면 `0.5`, "사용자당 20"이면 `20`. |
| `goal_unit` | text | `'fraction' \| 'count_per_user' \| 'days'`. |
| `aggregation` | text | `'pct_users_with_event' \| 'event_count_per_user' \| 'active_days'`. |
| `event_group` | jsonb | OR 시맨틱용 `{ operator: 'or', events: ['...'] }`. 빈 배열 허용 (`active_days`용). |
| `step_thresholds` | jsonb null | 향후 step-wise용 예약. |
| `sort_order` | int | UI 표시 순서. |

Unique: `(config_uuid, factor_key)`. `(config_uuid, sort_order)` 인덱스.

### 4.3 `protopie_churn_score`

엔터프라이즈 team별 **점수 스냅샷**당 한 행. 대시보드가 재유도할 필요 없도록 원시 포인트와 정규화된 0–100 값을 모두 저장한다.

| 컬럼 | 타입 | 비고 |
|--------|------|-------|
| `score_uuid` | uuid pk | |
| `project_uuid` | uuid fk → projects | |
| `account_key` | text | = `dim_team_summary`의 `team_id`. |
| `namespace` | text null | `dim_team_summary`에서. 엔터프라이즈 롤업 키 — 여러 `team_id`가 한 `namespace`를 공유 가능. |
| `cloud_url` | text null | `dim_team_summary.url`에서. 표시용. |
| `scored_for_date` | date | 이 점수가 적용되는 날. |
| `lookback_days` | int | 계산 시점 config에서 스냅샷됨. |
| `config_uuid` | uuid fk → configs (restrict) | |
| `config_version` | int | 비정규화. |
| `total_points` | numeric(6,2) | 활성 factor에 대한 `points_awarded`의 원시 합. 현재 루브릭에서 max는 100. |
| `max_points` | numeric(6,2) | 이 config 버전에서 활성인 factor의 `max_points` 합. |
| `score_percent` | numeric(5,4) | `total_points / max_points`. 0..1. |
| `normalized_score` | numeric(6,2) | `score_percent * 100`. 사용자에게 보이는 0–100 숫자. |
| `risk_band` | text | `'low' \| 'medium' \| 'high'` (`score_percent` + 임계값에서 유도). |
| `factor_scores` | jsonb | `{ factor_key: { raw, goal, points } }`. |
| `computed_at` | timestamptz | |
| `run_uuid` | uuid fk → runs (cascade) | |

Unique: `(account_key, scored_for_date, lookback_days, config_uuid)`. `(account_key, scored_for_date DESC)` 및 `(project_uuid, risk_band, scored_for_date DESC)` 인덱스.

### 4.4 `protopie_churn_score_runs`

재계산 호출당 감사 행.

| 컬럼 | 타입 | 비고 |
|--------|------|-------|
| `run_uuid` | uuid pk | |
| `project_uuid` | uuid fk → projects | |
| `config_uuid` | uuid fk → configs | |
| `triggered_by` | text | `'scheduler' \| 'manual' \| 'mcp'`. v1: `'manual'`만. |
| `triggered_by_user_uuid` | uuid fk → users null | |
| `status` | text | `'queued' \| 'running' \| 'completed' \| 'failed'`. |
| `started_at`, `finished_at` | timestamptz | |
| `accounts_scored` | int | |
| `error_message` | text null | |
| `created_at` | timestamptz | |

`(project_uuid, created_at DESC)` 인덱스.

### 4.5 시드 데이터 (동일 마이그레이션 내)

Notion 루브릭과 정확히 일치하는 활성 config 1개 + factor 9개를 삽입. 이로써 시스템이 1일차부터 동작함을 보장하고, 영업은 편집기로 반복 개선한다.

- 시드 행은 `created_by_user_uuid` / `updated_by_user_uuid`를 **NULL**로 둠 — 마이그레이션에는 실제 사용자가 없음. 영업의 첫 `PUT /config` 호출이 새 버전에서 이를 채움.
- 시드는 `projects` 테이블의 모든 기존 프로젝트를 대상으로 함 — 프로젝트당 기본 config 하나. 테이블이 비어 있으면 (새 로컬 dev) 시드는 no-op; API가 첫 읽기 시 config를 생성.

---

## 5. 편집 가능한 루브릭 — 영업 대면 표면

**백엔드 (REST, `packages/backend/src/protopie/controllers/` 아래 TSOA 자동 발견 컨트롤러):**

| 메서드 | 경로 | 목적 |
|--------|------|---------|
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/config` | 활성 config + factor 조회. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/config/versions` | 모든 버전 목록 (히스토리 뷰용). |
| `PUT` | `/api/v1/projects/{projectUuid}/protopie/churn/config` | 편집된 factor로 **새 버전** 생성. Body: `{ name, lookback_days, score_function, risk_band_thresholds, factors: [...] }`. 새 버전을 원자적으로 활성화: 이전 버전을 `archived`로 표시, `effective_to` 채움. |
| `POST` | `/api/v1/projects/{projectUuid}/protopie/churn/recompute` | 수동 재계산을 Graphile Worker 작업으로 **큐잉**. `{ run_uuid, status: 'queued' }`를 즉시 반환. Redshift 쿼리에서 **블록하지 않음** — 느린 재계산 시 HTTP 타임아웃 위험을 피함. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/runs` | 실행 히스토리 (최신순), 상태 포함. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/runs/{runUuid}` | 한 실행의 상태 (폴링 대상). `status`, `started_at`, `finished_at`, `accounts_scored`, `error_message` 반환. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/scores/latest` | 활성 config에 대한 Account별 최신 점수 목록. 필터: `risk_band`, `min_score`, `max_score`, `namespace`, `limit`, `offset`. |
| `GET` | `/api/v1/projects/{projectUuid}/protopie/churn/scores/{accountKey}` | 한 Account의 점수 히스토리 (`account_key` = `team_id`). |

**비동기 재계산 UX:** 루브릭 편집기의 "Recompute now" 버튼이 `POST /recompute`를 호출해 `run_uuid`를 받고, `status='completed'` 또는 `'failed'`가 될 때까지 약 2초마다 `GET /runs/{runUuid}`를 폴링한다. 프론트엔드는 TanStack Query 폴링을 사용하며 약 3분 후 적절히 중단한다. 느린 Redshift 상황에 관대하고 컨트롤러를 장시간 요청 영역에서 벗어나게 한다.

> **왜 루브릭에 기존 `protopie_form_*` 프레임워크를 재사용하지 않는가?** Forms는 Zod로 검증되는 JSONB 페이로드를 가진 영업 담당자 데이터 입력 표면이다. 루브릭은 점수 서비스가 조인하는 구조화·쿼리 가능 컬럼(`max_points`, `goal_value`, `event_group`)이 필요하다. 전용 테이블에 두면 점수 쿼리가 단순해지고, 감사 추적이 깔끔하며, UI가 무엇을 편집하는지 정직해진다. `forms/schemas/churnScoreInput.ts`의 플레이스홀더 `churn_score_input` form은 이 작업의 일부로 **삭제**된다 (현재의 "최종 필드는 추후 정의" 주석을 이 계획이 해소한다).

**프론트엔드 (`packages/frontend/src/protopie/`):**

- 새 페이지: `/projects/:projectUuid/protopie/churn/rubric`의 `ChurnScoreRubricPage`.
  - 9개(또는 N개) factor의 테이블 뷰: 편집 가능한 Weight, Goal, Goal Unit, Events (멀티 태그 입력), Aggregation (select).
  - "Save as new version" 버튼 → `PUT /config` 호출.
  - "Recompute now" 버튼 → `POST /recompute` 호출. 실행 요약 토스트 표시.
  - 과거 루브릭을 보는 버전 드롭다운 (읽기 전용).
- 새 페이지: `/projects/:projectUuid/protopie/churn/scores`의 `ChurnScoreListPage`.
  - `total_score` 오름차순 정렬 Account 목록.
  - 필터: risk_band, plan_tier (추후 Salesforce 조인), namespace/cloud_url 검색.
  - 행 클릭 → factor 분해를 보여주는 상세 드로어.
- 네비게이션 항목은 이미 존재 (`ProtopieNavButton`). Protopie 홈 내에 서브 네비게이션 탭 스트립 추가: Forms / Rubric / Scores.

**권한 (v1, 의도적으로 단순 — 새 CASL 스코프 없음):**

| 액션 | 허용 대상 |
|--------|-------------|
| `GET` 루브릭 / 점수 / 실행 | 프로젝트 범위의 인증된 모든 사용자 |
| `PUT` 루브릭 (새 버전) | 조직 admin 또는 프로젝트 admin (컨트롤러 내 인라인 체크) |
| `POST` 재계산 | 동일 |

제품이 요청하면 v1.1에서 `protopie:churn:rules:write` 스코프로 강화. 인라인 체크는 `projectMemberAbility.ts` / `roleToScopeMapping.ts` 편집을 피하고 격리 규칙을 보존한다.

---

## 6. 점수 서비스

**`packages/backend/src/protopie/services/ChurnScoreService.ts`** (신규).

### 6.1 public 메서드

```ts
class ChurnScoreService {
    // 읽기
    getActiveConfig(projectUuid): Promise<{ config, factors }>
    listVersions(projectUuid): Promise<Config[]>
    listLatestScores(projectUuid, filters): Promise<ChurnScoreRow[]>
    getAccountHistory(projectUuid, accountKey, limit): Promise<ChurnScoreRow[]>
    listRuns(projectUuid, limit): Promise<RunRow[]>
    getRun(projectUuid, runUuid): Promise<RunRow>

    // 쓰기 (동기, Postgres 전용 빠른 연산)
    upsertConfigAsNewVersion(user, projectUuid, payload): Promise<{ config, factors }>
    enqueueRecompute(user, projectUuid, opts: { triggeredBy }): Promise<{ runUuid, status: 'queued' }>

    // 쓰기 (스케줄러 워커에서 호출 — 장시간 실행)
    executeRecompute(runUuid: string): Promise<void>
}
```

### 6.2 `enqueueRecompute()` — HTTP 컨트롤러가 하는 일

컨트롤러는 동기 친화적:

1. 활성 config + factor 로드 (Postgres, 빠름).
2. `status='queued'`로 `protopie_churn_score_runs` 행 삽입.
3. 페이로드 `{ runUuid, projectUuid, triggeredByUserUuid }`로 Graphile Worker 작업 `protopie.recomputeChurnScore` 큐잉. 워커가 비어 있으면 즉시 작업을 가져감.
4. 호출자에게 `{ run_uuid, status: 'queued' }` 반환. 요청 경로에 Redshift 쿼리 없음.

### 6.3 `executeRecompute()` — 스케줄러 워커가 하는 일

워커는 HTTP를 블록하면 안 되는 장시간 단계를 처리:

1. `run_uuid`로 실행 행 로드; `status='running'`으로 전환, `started_at` 채움.
2. config + factor 재로드 (행이 `config_uuid`를 참조하므로 "최신 활성"이 아닌 그것을 사용 — 영업이 실행 중 루브릭을 바꿔도 재계산이 재현 가능하도록 유지).
3. `ProjectService.getWarehouseCredentialsForProject(projectUuid)` + `warehouseClientFromCredentials` 팩토리로 프로젝트의 `WarehouseClient` 해소.
4. 프로젝트의 **구성된** mart 스키마 해소. `mart.`나 `warehouse.`를 하드코딩하지 **않음** — 그것들은 dbt 모델 이름이지 Redshift 스키마가 아님. 대신 프로젝트의 웨어하우스 `schema`/`database`를 연결 config에서 읽어 `{schema}.dim_product_all_events`, `{schema}.dim_product_all_event_properties`, `{schema}.dim_team_summary`, `{schema}.dim_enterprise_summary`를 사용. dev는 `warehouse_dev`, prod는 `warehouse_prod` (둘 다 `prod` 데이터베이스 안에 있음 — dev/prod가 하나의 Redshift 클러스터를 공유하고 스키마로만 구분; [11-dbt-integration.md](./11-dbt-integration.md) 참조). 두 릴레이션 이름(events + properties)은 dbt 스키마가 다를 경우 env 또는 프로젝트 수준 설정으로 구성 가능하게 할 수 있음.

> **런타임 `{schema}`는 Lightdash 프로젝트의 Redshift "연결" `schema` 필드 값 그대로** — `getWarehouseSchema()`가 env 오버라이드 없이 자격증명에서 바로 읽음. dev 프로젝트의 연결 스키마가 `warehouse_dev`가 *아니면* (예: team/enterprise 차원은 있지만 최근 이벤트가 없는 stale한 `warehouse_staging`으로 남아 있으면) 모든 점수가 0으로 계산됨. 루브릭을 디버깅하기 전에 연결 스키마부터 확인할 것.
5. **단일 Redshift 쿼리**로, 한 번의 패스에서 `team_id`당 한 행과 모든 factor가 필요로 하는 모든 메트릭을 반환. 의사코드 (보간은 아래 설명):

   ```sql
   WITH event_attribution AS (
       SELECT
           e.event_id,
           e.event_time,
           e.event_name,
           e.user_id,
           ep.team_id
       FROM {schema}.dim_product_all_events e
       LEFT JOIN {schema}.dim_product_all_event_properties ep ON e.event_id = ep.event_id
       WHERE ep.team_id IS NOT NULL
         AND e.event_time >= DATEADD(day, -:lookback_days, CURRENT_TIMESTAMP)
   ),
   enterprise_teams AS (
       SELECT t.team_id, t.namespace, t.url AS cloud_url
       FROM {schema}.dim_team_summary t
       INNER JOIN {schema}.dim_enterprise_summary es ON es.namespace = t.namespace
   ),
   per_account AS (
       SELECT
           et.team_id,
           et.namespace,
           et.cloud_url,
           COUNT(DISTINCT ea.user_id) AS total_users,
           -- factor의 이벤트 그룹마다 하나의 CASE; 플레이스홀더는 이벤트별로 확장됨 (아래 참조)
           COUNT(DISTINCT CASE WHEN ea.event_name IN (:starting_action_e0, :starting_action_e1, :starting_action_e2, :starting_action_e3) THEN ea.user_id END) AS users_with_starting_action,
           SUM(CASE WHEN ea.event_name IN (:starting_action_e0, :starting_action_e1, :starting_action_e2, :starting_action_e3) THEN 1 ELSE 0 END) AS starting_action_event_count,
           ...
           COUNT(DISTINCT DATE_TRUNC('day', ea.event_time)) AS active_days
       FROM enterprise_teams et
       LEFT JOIN event_attribution ea ON ea.team_id = et.team_id
       GROUP BY et.team_id, et.namespace, et.cloud_url
   )
   SELECT * FROM per_account
   ```

   **파라미터화 전략.** `IN (:events)` 배열 확장에 의존하지 말 것 — `WarehouseClient.runQuery`가 바인딩을 받긴 하지만 배열→리스트 확장 동작은 어댑터(Redshift / Postgres 등)마다 균일하지 않음. 두 가지를 한다:

   1. **이벤트당 바인드 하나.** 각 factor에 대해 `event_group.events`를 `:{factorKey}_e0, :{factorKey}_e1, …`로 확장. SQL 빌더가 IN 절당 올바른 수의 `?` 플레이스홀더를 내보내고 값 목록을 위치 기반으로 바인딩. 이는 모든 `WarehouseClient` 구현에서 균일하게 안전함.
   2. **이벤트 이름 화이트리스트 가드.** 바인딩 전에 모든 이벤트 이름을 `/^[A-Za-z0-9 \-_]+$/`로 검증. 실패하면 `PUT /config` 저장 시점에 `ParameterError`를 던져, 루브릭 편집기가 안전하지 않은 값을 절대 저장하지 않게 함. 구형 드라이버의 바인딩 우회 엣지 케이스로부터 보호.

   `{schema}`는 SQL 파라미터가 **아님** — 허용 목록(`/^[a-z][a-z0-9_]+$/`)으로 검증한 뒤 SQL 빌드 시점에 치환됨.

6. 각 team별 행에 대해 순수 함수 `scoreAccount(factors, accountRow)`로 TypeScript에서 factor 하위 점수 계산:

   ```ts
   for (const factor of factors) {
       const actual = pickActual(factor, accountRow);
       const subScore = Math.min(actual / Math.max(factor.goalValue, 1e-9), 1) * factor.maxPoints;
       factorScores[factor.factorKey] = { raw: actual, goal: factor.goalValue, points: subScore };
       totalPoints += subScore;
       maxPoints   += factor.maxPoints;
   }
   const scorePercent = maxPoints > 0 ? totalPoints / maxPoints : 0;
   const normalizedScore = scorePercent * 100;
   ```

   `pickActual`은 `aggregation`에 따라 디스패치:
   - `'pct_users_with_event'` → `users_with_<factor>` / `total_users`
   - `'event_count_per_user'` → `<factor>_event_count` / `total_users`
   - `'active_days'` → `active_days` (`event_group` 무시)

7. `config.risk_band_thresholds`에서 `risk_band` 유도.
8. unique 키 `(account_key, scored_for_date, lookback_days, config_uuid)`로 `protopie_churn_score`에 **upsert**. 같은 날 재실행은 행을 덮어씀.
9. 실행을 `status='completed'`로 표시, `finished_at`와 `accounts_scored` 채움.
10. 예외 시 `status='failed'`로 표시, `error_message` 기록, 재던짐 (Graphile Worker가 `last_error`에 오류를 캡처).

### 6.4 그래뉼래리티 — team별, namespace 병기

점수는 **`team_id`별**로 계산됨 (`dim_team_summary.team_id`당 Lightdash 행 하나). 엔터프라이즈 `namespace`는 여러 team을 가질 수 있고, 이를 롤업하면 신호를 잃음 — 한 team의 도입률이 형제 team에 대해 알려주는 바가 없음. 모든 점수 행에 `namespace`를 실어 영업이 요청 시 대시보드가 엔터프라이즈 수준에서 그룹/집계할 수 있게 하되, 저장 그레인은 team별이다.

코드와 문서에서 사용하는 명명 규칙:

- `account_key` = `team_id` (team별 그레인).
- "Enterprise account" 또는 "enterprise team" = `namespace`가 `dim_enterprise_summary`에 나타나는 `account_key`.

향후 namespace별 롤업 mart는 이 스키마 변경 없이 dbt에서 추가할 수 있음.

### 6.5 성능

- 약 500개 엔터프라이즈 team × 재계산당 쿼리 1개 = Redshift 쿼리 1개. 따뜻한 웨어하우스에서 예상 실행 시간은 1분 미만.
- CASE 확장은 factor 수에 따라 증가. 9개 factor, factor당 평균 4개 이벤트 → 9 × 2 (DISTINCT users + SUM count) = 18개 컬럼 표현식. Redshift에 무리 없음.
- Postgres upsert: 한 트랜잭션에 약 500행. 무시할 수준.
- Graphile Worker를 통한 비동기 실행이므로 느린 재계산이 HTTP 타임아웃을 유발하지 **않음**. 워커가 재시도 처리 (`maxAttempts = 3`).

### 6.6 왜 백엔드 전용인가 (dbt 아님)

설계 문서(및 `CLAUDE.md`)가 이미 말하는 바 재확인: 편집 가능성을 위해 가중치는 Postgres에 둔다. dbt에서 계산하면 가중치 변경마다 dbt run이 필요하다. 반복 속도에서 백엔드가 이김; dbt는 입력만 모델링한다.

---

## 7. 스케줄러

- 새 task 이름: `protopie.recomputeChurnScore`. 페이로드: `{ projectUuid, triggeredBy, triggeredByUserUuid? }`.
- `@lightdash/common`의 `SCHEDULER_TASKS` + `TaskPayloadMap`, 그리고 OSS `SchedulerWorker.ts` task 맵에 등록 (터치 포인트 3a + 3b).
- v1은 **핸들러만** 출시 — cron 라인 없음. 수동 재계산이 v1 트리거.
- v1.1이 cron 엔트리 추가: `0 2 * * *` (매일 02:00 UTC).
- 지수 백오프와 함께 `maxAttempts = 3`; 최종 실패 시 `graphile_worker.jobs.last_error`에 엔트리 + Sentry breadcrumb 남김.

---

## 8. 와이어업 터치 포인트

이미 문서화된 7개 터치 포인트에 추가됨; 대체되는 것은 없음.

| 터치 포인트 | 편집 |
|-------------|------|
| `packages/backend/src/protopie/database/migrations/` | 4개 테이블 + 시드가 있는 신규 파일 `20260514000000_create_protopie_churn_score.ts`. |
| `packages/backend/src/protopie/services/index.ts` | `ChurnScoreService` 등록 (기존 `FormService` / `SettingsService` 팩토리에 합류). |
| `packages/common/src/types/schedulerTaskList.ts` | `SCHEDULER_TASKS`에 `PROTOPIE_RECOMPUTE_CHURN_SCORE` + `TaskPayloadMap`에 페이로드 타입 추가. |
| `packages/backend/src/scheduler/SchedulerWorker.ts` | import 하나 + OSS task 핸들러 맵에 엔트리 하나. |
| `packages/backend/src/ee/scheduler/SchedulerWorker.ts` | **상용/EE** 스케줄러 워커에 동일 엔트리. 우리 배포는 EE 실행; 이것 없이는 task 이름이 OSS 맵에 등록돼도 실제 실행은 EE 워커가 하므로 작업이 조용히 디스패치 실패함. |
| `packages/backend/src/protopie/controllers/` | 신규 `ChurnScoreController.ts` (TSOA — 자동 발견). |
| `packages/frontend/src/protopie/routes.tsx` | 새 lazy-load 페이지 3개. |
| `packages/frontend/src/protopie/` | 새 페이지, 훅, API 클라이언트. |

기존 7개 터치 포인트 외에 **Lightdash 코어에 새 편집 0건**. `SchedulerWorker.ts` (OSS와 EE 모두), `@lightdash/common/schedulerTaskList.ts` 편집은 설계 문서가 이미 카탈로그화한 동일 터치 포인트(터치 포인트 3)다 — 새 엔트리만 추가할 뿐.

---

## 9. 테스트 계획

| 레이어 | 테스트 |
|-------|------|
| Unit (TS) | `scoreAccount(factors, accountRow)` — 골든 케이스: 전부 0 입력 → `totalPoints=0, normalizedScore=0`; 모든 목표 충족 입력 → `totalPoints=max_points, normalizedScore=100`; 혼합 입력 → 예상 중간 점수; 목표 초과 입력은 factor max에서 클램프. |
| Unit (TS) | `goalValue=0`인 `scoreAccount`가 0으로 나누지 않음 (1e-9로 클램프). |
| Unit (TS) | `risk_band_thresholds` JSONB에서 risk-band 유도. 커스텀 임계값(예: `{ low: 0.8, medium: 0.6 }`)이 반영됨. |
| Unit (TS) | 가중치 합이 **100이 아닌 다른 값**인 `scoreAccount`도 0–100 `normalizedScore` 생성. 현재 10-factor 루브릭은 모든 factor가 목표 충족 시 `normalizedScore=100`. |
| Unit (TS) | `upsertConfigAsNewVersion` — 버전이 올바르게 증가; 이전 버전의 `effective_to` 채워짐; **100이 아닌 가중치 합 허용** (편집기 UI만 경고 표시); 같은 제출 내 중복 `factor_key`는 거부. |
| Integration | `WarehouseClient` 테스트 더블로 모킹된 픽스처 Redshift 쿼리. 재계산이 예상 행을 기록. |
| Integration | 비동기 재계산 엔드투엔드: HTTP로 큐잉 → 워커가 가져감 → 실행이 queued → running → completed 전환; `GET /runs/:runUuid`가 각 상태 반영. |
| Integration | 같은 날 재계산 재실행이 덮어씀 (unique 키에서 멱등). |
| API | `PUT /config`는 admin 필요; `GET`은 모든 프로젝트 멤버 허용. |
| Frontend 스모크 | 루브릭 편집기 → 저장 → "Recompute now" → 폴링 → 점수 목록이 갱신된 값 표시. |

---

## 10. 해소된 질문 + 미해결 항목

### 해소된 구현 결정 (2026-05-14)

- **점수는 `team_id`별, `namespace` 병기** (엔터프라이즈 롤업용). §6.4에 문서화.
- **`PUT /config`는 원자적 생성-및-활성화** (현재 계획).
- **`active_days`의 빈 이벤트 그룹** 유지 — 시맨틱은 `aggregation` 컬럼이 담당.
- **`goal_value = 0`은 `scoreAccount`에서 1e-9로 클램프** (0 나눗셈 없음) AND 루브릭 편집기가 경고 표시. 저장 자체는 거부되지 않음.
- **100이 아닌 가중치 합 허용.** 편집기가 저장 버튼 옆에 현재 `SUM(max_points)` 표시; 저장된 점수의 `normalizedScore`는 활성 `max_points`로 나눠 항상 0–100 렌더링. 앞선 "경고" vs "거부" 표현은 §9에서 조정됨.
- **비동기 재계산**은 Graphile Worker 작업으로 (HTTP 요청에서 동기 아님). §6.2 / §6.3 / §5.
- **EE 스케줄러 워커**는 `super.getFullTaskList()`로 OSS 핸들러 맵을 상속; 현재 코드베이스에서 별도 EE task 등록 불필요. §8.
- **스키마 치환.** `mart.` 하드코딩 없음. 실제 Redshift 스키마(`warehouse_dev` dev / `warehouse_prod` prod, 둘 다 `prod` 데이터베이스)는 프로젝트 웨어하우스 연결 config에서 읽음. §6.3.
- **파라미터화 전략.** 이벤트당 플레이스홀더 하나; 저장 시점 이벤트 이름 화이트리스트 가드. `IN (:array)` 확장 의존 없음. §6.3.
- **점수 모델.** `total_points`(원시)와 `normalized_score`(0–100), 그리고 `score_percent`, `max_points` 모두 저장. §4.3, §1.
- **마이그레이션 테이블 순서:** configs → factors → runs → scores. §4.
- **시드된 감사 사용자 UUID는 nullable.** §4.1, §4.5.
- **`churn_score_input` form 삭제는 UI PR에 게이트됨.** §13. PR 3(UI)가 form을 제거하는 유일한 곳; PR 1과 2는 그대로 둠. 같은 PR에서 Forms 페이지를 (a) 플레이스홀더 숨김, 또는 (b) 새 루브릭 편집기 안내로 업데이트. §14의 "기존 protopie forms에 회귀 없음" 라인은 다음으로 업데이트됨: "플레이스홀더 `churn_score_input` form이 제거됨; 다른 form은 영향 없음."

### 미해결 (영업 결정이 필요한 항목)

1. **엔터프라이즈 필터.** `dim_enterprise_summary` team만 점수화(현재 계획)할지, `team_id`가 있는 self-serve team도 점수화할지? Self-serve 점수화는 저렴하지만(같은 쿼리, 결과셋만 큼) 대시보드에 노이즈를 줄 수 있음. 기본: enterprise만.
2. **같은 날 덮어쓰기.** 확인 요청: 같은 날 두 번째 재계산이 점수 행을 덮어씀 (감사는 `protopie_churn_score_runs`에 존재). 대안은 모든 재계산 행을 보존하는 것(드문 2일차 데이터지만 무손실). 나는 덮어쓰기 선호.
3. **네비게이션 내 루브릭 편집기 배치.** 현재 계획: 형제 페이지 `/projects/:p/protopie/churn/rubric`. 대안: 통합 Protopie 페이지 내 탭. 둘 다 가능; 외형 문제.

---

## 11. 추가할 구체적 파일

```
packages/backend/src/protopie/
├── database/migrations/
│   └── 20260514000000_create_protopie_churn_score.ts        ← 마이그레이션 + 시드
├── models/
│   ├── ChurnScoreConfigModel.ts
│   ├── ChurnScoreFactorModel.ts
│   ├── ChurnScoreModel.ts
│   ├── ChurnScoreRunModel.ts
│   └── tableNames.ts                                         ← 확장
├── services/
│   ├── ChurnScoreService.ts
│   ├── churnScore/
│   │   ├── scoreAccount.ts                                   ← 순수 함수 (단위 테스트 가능)
│   │   ├── buildAggregationQuery.ts                          ← factor → SQL 변환
│   │   ├── deriveRiskBand.ts
│   │   └── churnScore.test.ts
│   └── index.ts                                              ← 확장
├── controllers/
│   └── ChurnScoreController.ts                               ← TSOA, 자동 발견

packages/common/src/protopie/churnScore/
├── types.ts                                                  ← 공유 타입
├── constants.ts                                              ← 기본 10-factor 루브릭, risk band 기본값
└── index.ts

packages/common/src/types/schedulerTaskList.ts                ← +1 task 이름 + 페이로드
packages/backend/src/scheduler/SchedulerWorker.ts             ← +1 task 핸들러

packages/frontend/src/protopie/
├── pages/
│   ├── ChurnScoreRubricPage.tsx
│   ├── ChurnScoreListPage.tsx
│   └── ChurnScoreAccountDetailPage.tsx
├── components/
│   ├── ChurnScoreFactorRow.tsx
│   ├── RiskBandBadge.tsx
│   └── EventGroupInput.tsx
├── hooks/
│   ├── useChurnConfig.ts
│   ├── useUpdateChurnConfig.ts
│   ├── useRecomputeChurnScore.ts
│   └── useChurnScores.ts
└── api.ts                                                    ← 확장
```

이 작업의 일부로 **삭제할 파일** — **PR 3(UI)에만 게이트됨**. PR 1과 2는 기존 Forms 페이지를 깨지 않고 출시 가능:
- `packages/common/src/protopie/forms/schemas/churnScoreInput.ts` (플레이스홀더)
- `forms/registry.ts`와 `protopie/index.ts`의 참조
- 같은 PR에서 `ProtopieFormsPage`를 플레이스홀더 항목을 숨기거나 "이건 무엇이었나?" 빈 상태로 새 루브릭 편집기로 링크하도록 업데이트. UI는 form을 조용히 잃지 **않음**.

---

## 12. PR 시퀀스 제안 (Graphite 스택)

리뷰 친화성을 위해 세 개의 얇은 PR로 출시:

1. **PR 1 — 스키마 + 타입.** 마이그레이션, 시드 데이터, 모델, `@lightdash/common`의 공유 타입. 서비스 없음, UI 없음. Lint + typecheck + 마이그레이션 스모크 테스트.
2. **PR 2 — 서비스 + REST.** `ChurnScoreService`, SQL 빌더, 점수 계산, 컨트롤러. 스케줄러 task 핸들러 포함 (아직 cron 없음). `scoreAccount`의 unit + integration 테스트. 이 PR 이후 admin이 루브릭을 curl하고 재계산을 트리거할 수 있음.
3. **PR 3 — UI.** 루브릭 편집기 페이지 + 점수 목록 페이지 + Account 상세 드로어. 네비게이션에 연결.

영업이 요청하면 **PR 4**가 야간 cron 라인 추가.

---

## 13. 이 계획에서 하지 않는 것 (의도적)

- dbt 모델 변경 없음. 기존 `dim_product_all_events`, `dim_product_all_event_properties`, `dim_team_summary`, `dim_enterprise_summary`로 충분.
- 새 MCP 도구 없음. 루브릭 + 점수가 출시되면 AI 에이전트가 `find_content`와 기존 API 브리지로 점수를 읽을 수 있고, `lightdash_api_mutate`로 루브릭을 쓸 수 있음 (동일 컨트롤러를 거치며 `mcp:write` + 조직 옵트인 준수).
- 대시보드의 프론트엔드 부트스트랩 없음. 설계 문서의 대시보드(Account 360, Churn Score Portfolio)는 content-as-code이며 PR 3 이후 별도 PR로 출시.
- ChurnZero에 대한 정합성(reconciliation) 하니스 없음. 그것은 phase-2 백엔드가 아닌 phase-5 컷오버 관심사.

---

## 14. 인수 기준 (v1 PR 세트용)

- 영업 리드가 `/projects/:projectUuid/protopie/churn/rubric`로 이동해 9개 기본 factor를 보고, 가중치나 목표를 편집·저장하고, "New version v2 active. Recompute to refresh scores."를 인라인으로 볼 수 있음.
- "Recompute now" 클릭 시 `{ runUuid, status: 'queued' }`로 즉시 반환; UI가 실행 상태를 폴링하고 워커 완료 시 `accountsScored: <엔터프라이즈-team-수>` 표시.
- `/projects/:projectUuid/protopie/churn/scores`가 점수 오름차순 정렬 + risk-band 배지로 재계산된 목록 표시.
- admin이 `curl -X POST /api/v1/projects/.../protopie/churn/recompute -H 'Authorization: ApiKey <PAT>'`로 동일 효과 확인 가능.
- 같은 날 재실행이 점수를 멱등하게 덮어씀; 실행 히스토리에 두 개의 run 행 표시.
- Typecheck, lint, 기존 protopie 테스트, 새 `scoreAccount` unit 테스트가 모두 통과.
- 플레이스홀더 `churn_score_input` form이 PR 3에서 제거되며, 그 제거를 설명하는 Forms 페이지 업데이트와 함께; 다른 form은 영향 없음; MCP 도구와 설정은 불변.

---

## 15. 빠른 결정 요약

- 루브릭에는 **전용 테이블 (제네릭 form 아님)**. → §4, §5.
- v1에서는 **선형 공식만**; 스키마는 stepwise용 예약. → §1, §4.2.
- 조직 전역이 아닌 **프로젝트별 루브릭**. → §4.1.
- 100이 아닌 가중치 합이 대시보드를 깨지 않도록 **`total_points`(원시)와 `normalized_score`(0–100) 모두 저장**. → §1, §4.3.
- **100이 아닌 가중치 합 허용.** 현재 기본 루브릭은 100 합이지만, 영업이 총합을 바꾸면 편집기가 차단 대신 경고; 저장된 점수는 항상 0–100. → §1, §9, §10.
- **`team_id`별 그레인**, 엔터프라이즈 롤업용으로 `namespace` 병기. → §6.4.
- **같은 날 재계산은 행을 덮어씀**; `protopie_churn_score_runs`가 감사. → §4.3.
- **인라인 admin 체크**, 새 CASL 스코프 없음. → §5.
- **Graphile Worker를 통한 비동기 재계산** — HTTP가 큐잉, UI가 run 행 폴링. → §5, §6.2, §6.3.
- 프로젝트 웨어하우스 config에서 **스키마 치환**; `mart.` / `warehouse.` 하드코딩 없음. → §6.3.
- **파라미터화**: 이벤트당 바인드 하나 + 저장 시점 화이트리스트 가드. `IN (:array)` 없음. → §6.3.
- **마이그레이션 테이블 순서**: configs → factors → runs → scores. 시드된 감사 사용자 컬럼은 nullable. → §4, §4.5.
- **EE 스케줄러 워커가 OSS와 함께 터치 포인트**. → §8.
- **3-PR 스택**: 스키마 → 서비스+REST+스케줄러 → UI. → §12.
- **`churn_score_input` form 삭제는 PR 3(UI)에 게이트됨**이며 Forms 페이지 업데이트와 함께 출시; PR 1과 2는 그대로 둠. → §11, §13, §14.
