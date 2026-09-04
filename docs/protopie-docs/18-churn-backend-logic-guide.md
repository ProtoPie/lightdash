# 18 — Churn Score 백엔드 로직 가이드 (엔지니어용)

> **상태**: 초안 (Draft)
> **독자**: 이 코드를 유지보수할 엔지니어
> **진실 기준**: 이 문서는 실제 코드에서 검증한 내용이다. CLAUDE.md는 "계획서"이므로
> 코드와 어긋나면 **코드가 진실**이다. (아래 §10 "계획 ≠ 구현" 표 참고)

---

## 0. 한눈에 보기

Churn Score는 각 고객사(Account)가 **제품을 얼마나 건강하게 쓰고 있는지**를
0~100점으로 매긴 값이다. ChurnZero(2026-07-30 만료)를 대체하기 위해 만들었다.

- 점수는 **백엔드에서만** 계산한다. dbt나 대시보드에서 다시 계산하지 않는다.
  (계산식을 두 곳에 두면 값이 조용히 갈라지기 때문)
- 점수의 재료는 데이터 웨어하우스(Redshift)의 사용량 집계 테이블이다.
- 가중치·목표값 같은 "채점 기준"(rubric)은 백엔드 Postgres에 저장한다.
- 결과는 `protopie_churn_score` 테이블에 **하루 1줄/계정** 형태로 쌓인다.

```
웨어하우스 사용량 테이블            채점 기준(Postgres)
protopie_account_event_usage   protopie_churn_score_configs
        │                              + _factors
        ▼                                  │
  집계 쿼리(buildAggregationQuery) ◄───────┘
        │  계정별 집계 1줄
        ▼
  채점(scoreAccount)  ── 가중치 적용, 0~100점 산출
        │
        ▼
  protopie_churn_score 에 저장(덮어쓰기)
```

핵심 파일:
- 오케스트레이션: [ChurnScoreService.ts](../../packages/backend/src/protopie/services/ChurnScoreService.ts)
- 채점 공식: [scoreAccount.ts](../../packages/backend/src/protopie/services/churnScore/scoreAccount.ts)
- 위험 구간: [deriveRiskBand.ts](../../packages/backend/src/protopie/services/churnScore/deriveRiskBand.ts)
- 기본 채점 기준(10개 요소): [constants.ts](../../packages/common/src/protopie/churnScore/constants.ts)

---

## 1. 점수가 만들어지는 큰 흐름

재계산 1회(`executeRecompute`, [ChurnScoreService.ts:593](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L593))는 다음 순서로 돈다.

1. **run 기록 시작** — `protopie_churn_score_runs`에 "이번 재계산" 한 줄을 만들고
   상태를 `running`으로 바꾼다.
2. **데이터 신선도 확인**(freshness gate) — 웨어하우스의 사용량 테이블이 비었거나
   너무 오래됐으면 **계산을 건너뛰고**(skip) 이전 점수를 그대로 둔다. (§7 참고)
3. **웨어하우스에서 계정별 집계를 읽음** — `buildAggregationQuery`가 채점 기준에
   맞춰 SQL을 만들고, 계정마다 "요소별 합계" 한 줄을 가져온다.
4. **계정마다 채점** — `scoreAccount()`가 가중치를 적용해 0~100점을 낸다.
5. **저장** — `protopie_churn_score`에 덮어쓰기(upsert)한다.
6. **run 종료** — 상태를 `completed`로 바꾸고 "몇 개 계정을 매겼는지"(accountsScored)를 남긴다.

읽는 웨어하우스 테이블은 코드 기준 **`{schema}.protopie_account_event_usage`** 이다.
(`{schema}`는 프로젝트의 웨어하우스 연결 설정에서 가져온다. 별도 접속 정보를 쓰지 않는다.)

> ℹ️ 예전에는 CLAUDE.md와 설계 문서(01·04·10·13·19)가 `mart_account_usage_90d`를
> 읽는다고 적었으나, **2026-07-08 코드에 맞춰 전부 `protopie_account_event_usage`(+
> 점수 계산 시 `protopie_account_contacts`)로 수정**했다. 그래도 원칙은 동일하다 —
> 문서가 아니라 코드를 따른다. 테이블 이름은 `ChurnScoreService` /
> `buildAggregationQuery.ts`에 하드코딩돼 있고, `{schema}`는 프로젝트 웨어하우스
> 연결 설정에서 온다(`PROTOPIE_WAREHOUSE_MART_TABLE` env 는 코드에서 쓰이지 않는다).

---

## 2. 점수 계산 방식 (scoreAccount)

계정 한 곳의 점수는 [scoreAccount.ts](../../packages/backend/src/protopie/services/churnScore/scoreAccount.ts)에서 만든다.

### 2-1. 요소(factor)와 "실제값(actual)"

채점 기준은 여러 개의 **요소(factor)**로 이뤄진다. 각 요소는 "무엇을, 어떻게 세는지"가
정해져 있다. 세는 방식(`aggregation`)은 4가지다:

| 세는 방식 | 의미 | 실제값 계산 |
|---|---|---|
| `pct_users_with_event` | 해당 행동을 한 **사용자 비율** | (행동한 사용자 수) ÷ (전체 사용자 수) |
| `event_count` | 행동 **총 횟수** | 그대로 합계 |
| `event_count_per_user` | **1인당** 행동 횟수 | (총 횟수) ÷ (전체 사용자 수) |
| `active_days` | **활동한 날 수** | 그대로 |

### 2-2. 점수로 바꾸는 두 가지 방식

요소의 "실제값"을 점수로 바꾸는 방법이 두 가지 있고, 채점 기준마다 하나를 고른다
(`scoreFunction`).

- **단계식(`stepwise`) — 현재 기본값.**
  실제값이 어느 "구간"에 드는지로 정해진 점수를 준다. ChurnZero와 점수를 똑같이
  맞추기 위한 방식이다. 예를 들어 "사용자 비율" 요소는
  `51% 이상 → 만점`, `26~50% → 약 66%`, `1~25% → 약 33%`, `0 → 0점` 식이다.
  구간 판정은 "실제값 이하인 구간 중 가장 높은 칸"을 고른다(올림 없이 내림).
  → [evaluateStepBucket](../../packages/backend/src/protopie/services/churnScore/scoreAccount.ts#L71)
- **선형(`linear`) — 옛 방식/예비용.**
  목표값 대비 비율로 부분 점수를 준다: `min(실제값 ÷ 목표값, 1) × 배점`.
  → [scoreAccount.ts:116](../../packages/backend/src/protopie/services/churnScore/scoreAccount.ts#L116)

> CLAUDE.md에는 "v1 기본은 선형"이라고 적혀 있으나 **실제 기본값은 단계식(`stepwise`)**
> 이다 ([constants.ts:24](../../packages/common/src/protopie/churnScore/constants.ts#L24)).

### 2-3. 합산과 불변식

각 요소의 점수를 더해 `total_points`(받은 점수)와 `max_points`(만점)를 만든다.
**모든 요소의 배점 합은 반드시 100이어야 한다.** 아니면 저장 전에 오류를 던진다
([assertFactorWeightsTotal, ChurnScoreService.ts:1371](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L1371)).

---

## 3. 산출되는 값들 — "건강 점수"와 "이탈 점수"는 방향이 반대다

한 계정을 채점하면 다음 값들이 함께 저장된다 ([scoreAccount.ts:154](../../packages/backend/src/protopie/services/churnScore/scoreAccount.ts#L154)):

| 값 | 계산 | 의미 / 방향 |
|---|---|---|
| `total_points` | 요소 점수 합 | 받은 점수(원점수) |
| `max_points` | 배점 합(=100) | 만점 |
| `score_percent` | total ÷ max (0~1) | 달성 비율 |
| `normalized_score` | score_percent × 100 | **건강 점수. 높을수록 좋음(이탈 위험 낮음).** 화면 기준값 |
| `churn_score` | **100 − normalized_score** | **이탈 점수. 높을수록 나쁨.** ChurnZero식 표기 |
| `factor_scores` | 요소별 {실제값, 목표, 점수} | 분해 내역 |

**가장 헷갈리는 지점:** `normalized_score`는 **건강 점수**(높을수록 좋음)이고,
`churn_score`는 그 반대(`100 − 건강점수`)다. **둘 다 저장**하므로, 코드나 대시보드에서
어느 쪽을 쓰는지 항상 확인해야 한다. (ChurnZero는 "이탈 점수" 방향을 썼다.)

---

## 4. 위험 구간 (risk band)

[deriveRiskBand.ts](../../packages/backend/src/protopie/services/churnScore/deriveRiskBand.ts)는 달성 비율(`score_percent`, 0~1)을 보고 세 등급을 매긴다.
기본 경계값은 [constants.ts:43](../../packages/common/src/protopie/churnScore/constants.ts#L43):

| 등급 | 조건(달성 비율) | 건강 점수로 보면 | 뜻 |
|---|---|---|---|
| `low` | 0.75 이상 | 75점 이상 | 위험 **낮음**(안전) |
| `medium` | 0.50 ~ 0.75 | 50~75점 | 보통 |
| `high` | 0.50 미만 | 50점 미만 | 위험 **높음** |

> 이름이 "위험 등급"임에 주의: **건강 점수가 높을수록 위험 등급은 `low`** 다(방향 반대).

---

## 5. 채점 기준(config)과 버전 관리

채점 기준 한 벌은 두 테이블에 나눠 저장된다:
- `protopie_churn_score_configs` — 기준 1벌의 메타(이름, lookback 일수, 점수 방식, 위험 경계값)
- `protopie_churn_score_factors` — 그 기준에 속한 요소들(배점·목표·세는 방식·이벤트 묶음)

### 5-1. 버전은 고치지 않고 새로 만든다 (immutable)

기준을 바꾸면 기존 행을 수정하지 않고 **새 버전을 만든다**
([upsertConfigAsNewVersion, ChurnScoreService.ts:198](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L198)). 한 트랜잭션 안에서:
1. 다음 버전 번호를 구하고(`getNextVersion`),
2. 기존 활성 버전을 보관(archive) 처리하고,
3. 새 config + 요소들을 넣는다.

### 5-2. 과거 점수는 "그때 기준 그대로"(as-was)

이미 저장된 점수 행은 **자기 `config_uuid`(그때 쓰인 기준 버전)를 그대로 유지**한다.
배점을 바꿔도 과거 점수가 자동으로 다시 계산되지 않는다. 과거를 새 기준으로 다시
매기려면 별도(수동) 작업이 필요하다.

### 5-3. 기본 기준 자동 생성

기준이 하나도 없으면 기본 기준("Default Churn Score")을 자동으로 만든다
([getOrCreateDefaultConfig, ChurnScoreService.ts:778](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L778)). 내용은 [constants.ts](../../packages/common/src/protopie/churnScore/constants.ts)의 기본 요소 10개(배점 합 100)다.

### 5-4. 기본 요소 10개 (ChurnZero 동일성)

[constants.ts:150](../../packages/common/src/protopie/churnScore/constants.ts#L150) 기준. 배점만 정리하면:

| 요소 | 배점 | 비고 |
|---|---|---|
| 시작 행동을 한 사용자 비율 | 5 | |
| 1인당 시작 행동 횟수 | 5 | |
| 활성화/로그인한 사용자 비율 | 10 | **120일** 창 + 2단 구간(특수) |
| 1인당 프로토타입 제작·저장 횟수 | 10 | |
| 프로토타입 제작·저장을 한 사용자 비율 | 10 | |
| AI 기능을 쓴 사용자 비율 | 10 | |
| 트리거/반응을 추가한 사용자 비율 | 15 | |
| 1인당 트리거/반응 추가 횟수 | 15 | |
| 받은 메시지 수 | 10 | 데이터 소스가 없어 **항상 0/10** (ChurnZero와 동일하게 의도적으로 0) |
| 활동 일수 | 10 | |

ChurnZero와 점수를 맞추기 위한 특수 처리:
- "활성화/로그인" 요소만 **120일** 기준(나머지는 90일)이고 2단 구간을 쓴다.
- "받은 메시지 수"는 대응되는 데이터 소스가 없어 **항상 0점**이다. 그래도 100점
  만점을 맞추기 위해 분모에 그대로 남겨둔다(ChurnZero도 이 항목이 0이었음).
- 구간 점수는 올림(ceil) 처리, 비율 요소는 구간 비교 시 ×100 해서 1/26/51 같은
  숫자로 읽히게 한다.

---

## 6. 재계산은 언제·어떻게 도는가

재계산 1회의 트리거 경로:

```
enqueueRecompute (controller/API)
   → SchedulerClient.protopieRecomputeChurnScore
   → 백그라운드 작업(Graphile Worker) "protopie.recomputeChurnScore"
   → ChurnScoreService.executeRecompute(runUuid)
```

- API는 **즉시 끝나지 않는다.** 작업을 큐에 넣고 `runUuid`만 바로 돌려준다(HTTP 202).
  실제 완료 여부는 `runs/{runUuid}`를 조회해 확인한다.
- **자동 매일 실행은 인앱 크론이 아니다.** 별도의 **Airflow DAG**가 매일 백엔드의
  재계산 API를 호출하는 방식으로 설계돼 있다. 이유는 "새벽 2시"가 아니라 "웨어하우스
  마트가 갱신된 직후"에 돌아야 정확하기 때문이다. 설계·구현 계획은
  [19-churn-recompute-airflow-dag.md](./19-churn-recompute-airflow-dag.md) 참고.
- 따라서 **SchedulerWorker 안에는 nightly 크론 등록이 없다.** 자동화는 Airflow 쪽에 있다.
  (코드에서 크론을 찾지 못하면 이 때문이다.)

### 재계산 트리거 시 `config_uuid`를 꼭 지정할 것

재계산 시 어떤 기준으로 매길지 지정하지 않으면 활성 기준으로 폴백되는데, 활성 기준이
여러 개면 의도치 않은 기준이 선택될 수 있다(§9 "전부 0" 함정과 연결). 자동화(Airflow)는
**항상 `config_uuid`를 명시**해 호출한다.

---

## 7. 데이터 신선도 안전장치 (freshness gate)

[checkMartFreshness, ChurnScoreService.ts:1019](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L1019).

재계산 직전에 웨어하우스 사용량 테이블을 점검한다:
- 행이 **0개**거나 마지막 이벤트 날짜를 못 구하면 → "비어 있음"으로 보고 **건너뜀**.
- 마지막 이벤트가 **2일(`MART_STALE_MAX_AGE_DAYS`)** 보다 오래됐으면 → "오래됨"으로 보고 **건너뜀**.

건너뛸 때(`markSkipped`)는:
- **이전 점수를 덮어쓰지 않는다.** (망가진 dbt 빌드가 좋은 점수를 0으로 밀어버리는 사고 방지)
- Slack 알림을 보낸다. (알림 실패가 재계산을 죽이지는 않는다 — 경고만 로깅)

Churn Score는 90일 누적 지표라 1~2일 지연은 영향이 없다. 이 장치는 "지연"이 아니라
"명백히 깨진 데이터"만 막는 용도다.

---

## 8. 점수 조회와 계정 상세

- **최신 점수 목록**: `listLatestScores` — 기준(config) 지정 가능. 미지정 시 기본 기준 사용
  ([getConfigForScores, ChurnScoreService.ts:755](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L755)).
- **계정 이력**: `getAccountHistory` — 한 계정의 날짜별 점수.
- **계정 상세**: `getAccountDetails` — 점수 + 기준 + 요소별 달성도 + 이벤트 사용량.
  이벤트 사용량 탐색 창은 마트의 가장 최근 **90일**(`CHURN_SCORE_EVENT_USAGE_WINDOW_DAYS`)
  로 제한되며, 기준점은 특정 계정이 아니라 **마트 전체의 최신 이벤트 날짜**다.

권한: 모든 조회는 프로젝트 보기 권한이 필요하고, 매니저가 아닌 사용자는
**기본 기준과 자신이 만든 기준만** 보거나 수정할 수 있다
([requireConfigView/Edit, ChurnScoreService.ts:1441](../../packages/backend/src/protopie/services/ChurnScoreService.ts#L1441)).

---

## 9. 운영 함정 (꼭 알아둘 것)

1. **"점수가 전부 0으로 보임"은 백엔드 버그가 아니다.**
   화면(프론트)이 활성 기준 중 특정 기준을 기본 선택하면서, 점수가 거의 0인 기준
   (예: 아직 안 채운 기준)이 잡히면 전부 0으로 보인다. 백엔드는 `config_uuid`로
   고른 기준의 점수를 정확히 돌려줄 뿐이다. → 재계산·조회 모두 **기준을 명시**하면 안전.
2. **신선도 건너뜀 = 점수 미갱신.** 그날 점수가 안 바뀌면 마트가 비었거나 오래된 것일 수
   있다. Slack 알림과 `protopie_churn_score_runs`의 skip 사유를 확인한다.
3. **건강 점수 vs 이탈 점수 방향.** 코드/쿼리/대시보드에서 어느 값을 쓰는지 항상 확인(§3).
4. **배점 합 100 불변식.** 요소 배점 합이 100이 아니면 저장 전 오류. 기준 편집 시 주의.

---

## 10. 계획(CLAUDE.md) ≠ 실제 구현

문서만 믿으면 틀리는 지점 정리:

| CLAUDE.md 표현 | 실제 코드 | 비고 |
|---|---|---|
| ~~`mart_account_usage_90d`를 읽음~~ (2026-07-08 문서 정정 완료) | `protopie_account_event_usage`(+ `protopie_account_contacts`)를 읽음 | §1 |
| 점수 기본은 선형(linear) | 기본은 단계식(stepwise) | §2-2 |
| 매일 밤 인앱 크론으로 재계산 | Airflow DAG가 API 호출(인앱 크론 없음) | §6, 문서 19 |
| `protopie_account_overrides`로 점수 강제/제외 | 해당 테이블·기능 **미구현** | 가이드/UI에서 "있는 기능"처럼 쓰지 말 것 |
| 터치포인트/갱신상태 폼 다수 | 폼 스키마는 `accountIdentity` + `churnScoreInput`(삭제 예정 placeholder)뿐 | 폼 프레임워크는 스캐폴딩 단계 |

---

## 부록 — 주요 파일

| 역할 | 파일 |
|---|---|
| 재계산 오케스트레이션·조회·권한 | [ChurnScoreService.ts](../../packages/backend/src/protopie/services/ChurnScoreService.ts) |
| 계정 1곳 채점 공식 | [scoreAccount.ts](../../packages/backend/src/protopie/services/churnScore/scoreAccount.ts) |
| 위험 등급 판정 | [deriveRiskBand.ts](../../packages/backend/src/protopie/services/churnScore/deriveRiskBand.ts) |
| 집계 SQL 생성 | [buildAggregationQuery.ts](../../packages/backend/src/protopie/services/churnScore/buildAggregationQuery.ts) |
| 기본 채점 기준·구간 정의 | [constants.ts](../../packages/common/src/protopie/churnScore/constants.ts) |
| 채점 기준 테이블 마이그레이션 | [packages/backend/src/protopie/database/migrations/](../../packages/backend/src/protopie/database/migrations/) |
| 재계산 자동화(Airflow) 설계 | [19-churn-recompute-airflow-dag.md](./19-churn-recompute-airflow-dag.md) |
| 점수 채점 규칙(루브릭) 설계 | [17-churn-score-rubric.md](./17-churn-score-rubric.md) |
