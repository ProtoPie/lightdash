# 19 — Churn Score 재계산: Airflow DAG (submit + poll)

> **상태**: 구현 계획 (Plan)
> **방식**: Airflow DAG가 Lightdash 백엔드의 재계산 API를 호출 (옵션 A)
> **선행 문서**: [17-churn-score-rubric.md](./17-churn-score-rubric.md), [11-dbt-integration.md](./11-dbt-integration.md), [15-deployment.md](./15-deployment.md)
> **관련 레포**: `lightdash` (이 레포, API 제공) · `airflow` (DAG) · `data-modeling` (dbt 마트)

---

## 1. 목표

Churn score를 **매일 자동으로** 재계산한다. 단, 인앱 크론이 아니라 **Airflow DAG가 Lightdash 백엔드 API를 호출**하는 방식으로 구현한다.

핵심 이유 (옵션 B 인앱 크론 대비):
1. **데이터 의존성이 시간이 아니라 이벤트다.** Churn score는 `protopie_account_event_usage`(+ `protopie_account_contacts`, dbt가 Redshift에 빌드, Airflow `dbt_models` DAG가 오케스트레이션)를 읽는다. 따라서 재계산은 "새벽 2시"가 아니라 **"마트가 갱신된 직후"** 돌아야 정확하다. Airflow는 이 의존성을 task graph로 표현할 수 있다.
2. **포크 재배포 불필요.** API는 이미 구현돼 있다 ([ChurnScoreController.ts:265](../../packages/backend/src/protopie/controllers/ChurnScoreController.ts#L265)). DAG + PAT만 추가하면 된다. 격리 규칙(7개 touch point)을 건드리지 않는다.
3. **관측/재시도/알림이 팀이 이미 보는 Airflow에 통합**된다.

> **기존 DAG 대체**: `airflow/airflow/dags/protopie_churn_score/`에 과거 **쿼리 기반**(`queries.py` + `service.py`로 SQL을 직접 돌려 점수 계산) DAG가 존재했으나 소스가 제거됐다(`__pycache__`만 잔존). 이번 작업은 그 자리를 **API 호출 기반** DAG로 대체한다. 점수 계산 로직은 백엔드(`ChurnScoreService`)가 단일 진실 공급원이며, dbt/Airflow에서 점수를 재계산하지 않는다 (CLAUDE.md 원칙).

---

## 2. 아키텍처

```
┌─────────────────────── Airflow ───────────────────────┐
│                                                        │
│  dbt_models DAG (0 6 * * * = 15:00 KST)                │
│    setup → staging → marts                             │
│      └─ marts/warehouse/protopie  ← (신규, §6에서 추가) │
│              │ mart_account_usage_90d 완료             │
│              ▼  (cross-DAG 신호: Dataset 또는 Sensor)  │
│  protopie_churn_score DAG                              │
│    wait_for_mart → trigger_recompute → poll_until_done │
│         │                  │                  │        │
└─────────┼──────────────────┼──────────────────┼────────┘
          │       POST .../recompute             │ GET .../runs/{uuid}
          ▼                                       ▼
   ┌────────────────────── Lightdash 백엔드 (ECS) ──────────────────┐
   │  ChurnScoreController.recompute → enqueueRecompute (202, runUuid)│
   │  Graphile Worker: PROTOPIE_RECOMPUTE_CHURN_SCORE                 │
   │    → ChurnScoreService.executeRecompute(runUuid)                │
   │        → WarehouseClient 로 protopie_account_event_usage 읽기 (Redshift)│
   │        → protopie_churn_score 테이블에 일별 점수 기록            │
   └─────────────────────────────────────────────────────────────────┘
```

**왜 submit + poll인가**: recompute 엔드포인트는 **동기가 아니다.** Graphile Worker 잡을 enqueue하고 `runUuid`만 즉시 반환(HTTP 202)한다. "동기 호출"을 흉내내려면 DAG가 `runs/{runUuid}`를 폴링해 `completed`/`failed`까지 기다려야 한다. 이래야 Airflow가 실제 성공/실패를 정확히 반영하고, 실패 시 알림·재시도가 의미를 갖는다.

---

## 3. API 계약 (요약)

전체 명세는 [ChurnScoreController.ts](../../packages/backend/src/protopie/controllers/ChurnScoreController.ts) 참조. DAG가 쓰는 두 엔드포인트:

### 3.1 트리거

```
POST /api/v1/projects/{projectUuid}/protopie/churn/recompute?configUuid={configUuid}
Authorization: ApiKey {PAT}
```

- 인증: PAT (`allowApiKeyAuthentication`), 등록된 org-scoped 계정, demo 차단.
- Query: `configUuid`(권장, 명시) 또는 `name`. **둘 다 생략 시 active config로 폴백되는데, 활성 config가 복수면 알파벳순 첫 config가 선택돼 "all 0" 류 혼선이 생길 수 있다** → DAG는 **반드시 `configUuid`를 명시**한다 (§8 참조).
- 응답 **202**:
  ```json
  { "status": "ok", "results": { "runUuid": "<uuid>", "status": "queued" } }
  ```

### 3.2 상태 폴링

```
GET /api/v1/projects/{projectUuid}/protopie/churn/runs/{runUuid}
Authorization: ApiKey {PAT}
```

응답 `results` ([types.ts:154 `ChurnScoreRun`](../../packages/common/src/protopie/churnScore/types.ts#L154)):

| 필드 | 의미 |
|---|---|
| `status` | `queued` → `running` → `completed` \| `failed` (폴링 대상) |
| `accountsScored` | 성공 시 점수 매긴 account 수 (0이면 의심 — 알림 필요) |
| `errorMessage` | 실패 사유 |
| `startedAt` / `finishedAt` | 실행 시각 |
| `triggeredBy` | `scheduler` \| `manual` \| `mcp` (API 트리거는 `manual`로 기록됨) |

---

## 4. 선행 조건 (Prerequisites)

| # | 항목 | 상세 |
|---|---|---|
| P-1 | **서비스 PAT 발급** | Lightdash dev에서 org-scoped 계정으로 PAT 생성. 만료일 관리(달력 리마인더). demo 계정 불가. |
| P-2 | **프로젝트 UUID 확보** | `PROTOPIE_PROJECT_UUID` (Protopie 콘텐츠 소유 프로젝트). dev RDS `projects` 테이블에서 확인. |
| P-3 | **활성 config UUID 확보** | CZ-faithful 활성 config의 `config_uuid`. `protopie_churn_score_configs`에서 `status='active'` 조회. (메모리 [churn rewrite plan] 참조) |
| P-4 | **네트워크 도달성** | Airflow worker → Lightdash dev ALB(HTTPS) 아웃바운드 가능 여부 확인. SG/네트워크 경로 ([15-deployment.md](./15-deployment.md)). |
| P-5 | **⚠️ prod는 아직 stock 이미지** | 메모리 [prod runs STOCK image]: prod ECS는 `lightdash/lightdash:latest`라 **recompute API가 prod엔 존재하지 않는다.** 이 DAG는 **cutover(2026-07-30 이전) 전까지 dev만 타깃**한다. prod 타깃은 포크가 prod에 배포된 이후 활성화. |
| P-6 | **dbt protopie 마트가 Airflow에서 빌드되는지** | 현재 `dbt_models` DAG의 `MARTS_DOMAINS`에 protopie 마트가 **없다.** §6에서 추가 필요(또는 별도 확인). 이게 없으면 의존성을 걸 대상이 없다. |

---

## 5. DAG 구현 (`airflow/airflow/dags/protopie_churn_score/`)

기존 레포 컨벤션(`learnworld`, `dbt_models`)을 따른다: `config.py`(env 기반) · `dag.py`(@dag + TaskGroup) · `api_client.py`(requests + `commons.utils.error_handler`) · `notifications.py` · `common_callbacks.create_failure_callback`.

### 5.1 파일 구조

```
airflow/airflow/dags/protopie_churn_score/
├── __init__.py
├── config.py          # env var 기반 설정
├── dag.py             # @dag 정의, task graph
├── api_client.py      # LightdashChurnClient: trigger + poll
└── notifications.py   # Slack 성공/실패 메시지
```

### 5.2 `config.py` (env var — K8s secret 패턴)

```python
import os

ENV = os.getenv('ENV', 'local').lower()

DAG_ID = 'protopie_churn_score'
# dbt_models가 06:00 UTC. 마트 완료 의존이 1순위이므로 Dataset/Sensor 사용 권장.
# 폴백 cron은 dbt 완료 이후로 충분히 늦게 둔다 (예: 07:00 UTC).
SCHEDULE = os.getenv('CHURN_RECOMPUTE_SCHEDULE', '0 7 * * *')

# Lightdash API (dev 전용 — prod cutover 전까지 prod URL 금지)
LIGHTDASH_API_URL   = os.getenv('LIGHTDASH_API_URL')      # 예: https://lightdash-dev.xxx
LIGHTDASH_PAT       = os.getenv('LIGHTDASH_PAT')          # K8s secret
LIGHTDASH_PROJECT_UUID = os.getenv('LIGHTDASH_PROJECT_UUID')
CHURN_CONFIG_UUID   = os.getenv('CHURN_CONFIG_UUID')      # 명시 필수 (§8)

# Poll 설정
POLL_INTERVAL_SEC = int(os.getenv('CHURN_POLL_INTERVAL_SEC', '15'))
POLL_TIMEOUT_SEC  = int(os.getenv('CHURN_POLL_TIMEOUT_SEC', '1800'))  # 30분
HTTP_TIMEOUT_SEC  = int(os.getenv('CHURN_HTTP_TIMEOUT_SEC', '30'))

RETRIES = int(os.getenv('RETRIES', '2'))
RETRY_DELAY_MINUTES = int(os.getenv('RETRY_DELAY_MINUTES', '5'))

# Slack (dbt_models와 동일 패턴)
SLACK_TOKEN = os.getenv('SLACK_TOKEN', '')
SLACK_CHANNEL = os.getenv('SLACK_CHANNEL', '#data-pipeline')
```

### 5.3 `api_client.py` (submit + poll)

```python
import time
import requests
from commons.utils.logger import get_logger
from commons.utils.error_handler import retry, handle_errors
from protopie_churn_score import config

logger = get_logger(__name__)


def _headers():
    return {
        "Authorization": f"ApiKey {config.LIGHTDASH_PAT}",
        "Content-Type": "application/json",
    }


def _base():
    return (
        f"{config.LIGHTDASH_API_URL}/api/v1/projects/"
        f"{config.LIGHTDASH_PROJECT_UUID}/protopie/churn"
    )


@retry(max_attempts=3, delay=2.0, backoff=2.0,
       exceptions=(requests.exceptions.RequestException,))
def trigger_recompute() -> str:
    """POST /recompute → runUuid 반환. configUuid 명시."""
    resp = requests.post(
        f"{_base()}/recompute",
        headers=_headers(),
        params={"configUuid": config.CHURN_CONFIG_UUID},
        timeout=config.HTTP_TIMEOUT_SEC,
    )
    resp.raise_for_status()              # 202 기대
    run_uuid = resp.json()["results"]["runUuid"]
    logger.info("Enqueued churn recompute run_uuid=%s", run_uuid)
    return run_uuid


@retry(max_attempts=3, delay=2.0, backoff=2.0,
       exceptions=(requests.exceptions.RequestException,))
def _get_run(run_uuid: str) -> dict:
    resp = requests.get(
        f"{_base()}/runs/{run_uuid}",
        headers=_headers(),
        timeout=config.HTTP_TIMEOUT_SEC,
    )
    resp.raise_for_status()
    return resp.json()["results"]


@handle_errors(logger=logger, raise_on_error=True)
def poll_until_done(run_uuid: str) -> dict:
    """completed까지 폴링. failed/timeout 시 예외 → task 실패."""
    deadline = time.monotonic() + config.POLL_TIMEOUT_SEC
    terminal = {"completed", "failed"}
    while time.monotonic() < deadline:
        run = _get_run(run_uuid)
        status = run["status"]
        logger.info("run_uuid=%s status=%s scored=%s",
                    run_uuid, status, run.get("accountsScored"))
        if status in terminal:
            if status == "failed":
                raise RuntimeError(
                    f"Churn recompute failed: {run.get('errorMessage')}")
            if (run.get("accountsScored") or 0) == 0:
                # 데이터 의존성 깨짐 의심 — 마트가 비었거나 stale
                raise RuntimeError(
                    f"Churn recompute completed but accountsScored=0 "
                    f"(run_uuid={run_uuid}) — 마트 신선도 확인 필요")
            return run
        time.sleep(config.POLL_INTERVAL_SEC)
    raise TimeoutError(
        f"Churn recompute did not finish within "
        f"{config.POLL_TIMEOUT_SEC}s (run_uuid={run_uuid})")
```

> `commons.utils.error_handler`의 `retry`/`handle_errors` 시그니처는 사용 전 실제 구현으로 확인할 것(데코레이터 인자명이 다를 수 있음). `learnworld/api_client.py`가 동일 패턴을 쓴다.

### 5.4 `dag.py` (task graph)

3개 task: ① 마트 완료 대기 → ② 트리거 → ③ 폴링.

```python
@dag(
    dag_id=config.DAG_ID,
    schedule=config.SCHEDULE,          # 또는 Dataset 트리거(§7 권장)
    start_date=datetime(2026, 6, 1),
    catchup=False,
    max_active_runs=1,                 # 동시 실행 금지 (§9)
    default_args={
        "retries": config.RETRIES,
        "retry_delay": timedelta(minutes=config.RETRY_DELAY_MINUTES),
        "on_failure_callback": create_failure_callback("ETL Airflow - Churn Score"),
    },
    tags=["protopie", "churn"],
)
def protopie_churn_score():
    # ① dbt_models의 protopie 마트 완료 대기 (§7 옵션 중 택1)
    wait_for_mart = ExternalTaskSensor(
        task_id="wait_for_mart",
        external_dag_id="dbt_models",
        external_task_id="marts.dbt_warehouse_protopie",   # §6에서 만들 task_id
        allowed_states=["success"],
        mode="reschedule",            # worker slot 점유 안 함
        timeout=2 * 3600,
        poke_interval=120,
    )

    @task
    def trigger() -> str:
        return api_client.trigger_recompute()

    @task
    def poll(run_uuid: str):
        run = api_client.poll_until_done(run_uuid)
        notifications.notify_success(run)

    wait_for_mart >> poll(trigger())

protopie_churn_score()
```

---

## 6. dbt protopie 마트를 Airflow 의존 대상으로 만들기 (선행)

현재 `dbt_models/config.py`의 `MARTS_DOMAINS`에 protopie 마트가 **없다.** 의존성을 걸려면 먼저 마트를 `dbt_models` DAG에 등록해야 한다.

**`dbt_models/dag.py` 변경** (1줄): `MARTS_DOMAINS`에 `"warehouse/protopie"` 추가 → path 기반으로 `models/marts/warehouse/protopie/` 빌드, task_id = `dbt_warehouse_protopie`.

```python
MARTS_DOMAINS = [
    "shared",
    "warehouse/billing",
    ...
    "warehouse/protopie",   # ← 추가: mart_account_usage_90d, mart_churn_score_latest 등
]
# 필요 시 의존성:
# marts_tasks["shared"] >> marts_tasks["warehouse/protopie"]
```

> 마트가 이미 `tag:protopie`로 다른 경로로 빌드되고 있다면 이 단계는 생략하고 그 task를 `external_task_id`로 가리킨다. **구현 전 data-modeling 레포와 dbt_models DAG에서 실제 빌드 경로를 확인할 것.**

---

## 7. Cross-DAG 의존성 — 3가지 옵션

마트(`dbt_models`) 완료 → 재계산(`protopie_churn_score`) 순서를 보장하는 방법:

| 옵션 | 방법 | 장점 | 단점 | 권장 |
|---|---|---|---|---|
| **A. Dataset(Asset) 트리거** | `dbt_models`의 protopie 마트 task가 `Dataset("...mart_account_usage_90d")` outlet 방출 → 이 DAG가 `schedule=[dataset]` | 이벤트 기반, 가장 정확, 폴링 없음 | dbt_models DAG도 outlet 추가 필요 | ✅ **1순위** (Airflow 2.4+) |
| **B. ExternalTaskSensor** | 위 §5.4 코드. `mode="reschedule"` | dbt_models 변경 최소 | execution_date 정렬 주의(`execution_date_fn`), 스케줄 두 DAG가 맞아야 함 | 2순위 |
| **C. 단순 시각 cron** | `0 7 * * *` (dbt 06:00 이후) | 구현 최단 | 마트 지연 시 stale 데이터로 계산(silent) — 인앱 크론과 같은 약점 | 비권장 (폴백만) |

**권장: 옵션 A(Dataset).** 옵션 A가 어려우면 B. C는 인앱 크론 대비 이점이 사라지므로 임시 폴백으로만.

---

## 8. config_uuid 명시 (중요)

메모리 [churn score "all 0" root cause]: 활성 config가 복수일 때 미지정 트리거는 알파벳순 첫 config를 잡아 0점만 나오는 사례가 있었다. **DAG는 `CHURN_CONFIG_UUID`를 env로 주입하고 항상 명시 전달**한다. config 버전이 바뀌면(새 rubric 활성화) env 값을 갱신한다 — 이는 의도적 수동 단계(점수 history "as-was" 원칙과 일치).

---

## 9. 멱등성 · 동시성

- **`max_active_runs=1`**: 재계산이 30분 넘게 돌 때 다음 스케줄과 겹치지 않게.
- **멱등성**: `protopie_churn_score`는 `(account_key, scored_for_date, lookback_days, config_uuid)` unique. 같은 날 두 번 트리거해도 upsert(덮어쓰기) — Airflow task 재시도가 안전하다.
- **재시도 분리**: `trigger`와 `poll`을 분리했으므로, 폴링 중 네트워크 오류로 task가 죽어도 재시도 시 **새 run을 또 만들지 않게** 주의. → 안전책: `trigger`는 `retries=0`(또는 멱등 키), `poll`만 재시도. 또는 `poll` task가 XCom의 동일 `run_uuid`를 재사용하도록 task 경계를 둔다(위 구조가 이미 그렇게 됨 — `trigger` XCom 값 고정).

---

## 10. 시크릿 · 보안

- `LIGHTDASH_PAT`는 **K8s secret**으로 주입(레포 평문 금지). 기존 `LW_TOKEN`/`DBT_GITHUB_TOKEN`과 동일 메커니즘.
- PAT는 org-scoped, 최소 권한. 만료일 캘린더 등록.
- HTTPS(ALB)로만 호출. dev URL 하드코딩 금지(env).
- 로그에 PAT/payload 미기록(`api_client`는 run_uuid/status만 로깅).

---

## 11. 알림 · 실패 처리

- `notifications.py`: 성공 시 `accountsScored`/`finishedAt`을 Slack `#data-pipeline`에 전송(dbt_models 패턴).
- 실패(`failed`/timeout/`accountsScored=0`)는 예외 → task fail → `create_failure_callback` Slack 알림.
- **`accountsScored=0`을 실패로 취급**(§5.3): 마트가 비었거나 stale일 때 "성공인데 0점"으로 조용히 넘어가는 것을 막는다.

---

## 12. 롤아웃 · 테스트 계획

1. **P-1~P-6 선행조건 충족** (특히 P-5: dev만 타깃, P-6: 마트 빌드 확인).
2. **로컬/수동 검증**: `curl`로 dev에서 `POST .../recompute` → `runUuid` → `GET .../runs/{uuid}`가 `completed` + `accountsScored>0` 되는지 먼저 확인.
3. **§6 마트 등록** → `dbt_models` DAG에서 `dbt_warehouse_protopie` task 정상 동작 확인.
4. **DAG 배포** → 수동 트리거(`trigger DAG`)로 end-to-end 1회 성공 확인.
5. **의존성 검증**: dbt_models 1회 돌린 뒤 Dataset/Sensor가 churn DAG를 자동 발화하는지 확인.
6. **스케줄 활성화** (dev). 며칠 모니터링.
7. **prod cutover 후**(포크 prod 배포 완료 시): prod용 env(`LIGHTDASH_API_URL`/PAT/PROJECT/CONFIG) 추가, prod DAG 활성화.

검증 curl:
```bash
RUN=$(curl -s -XPOST -H "Authorization: ApiKey $LDPAT" \
  "$SITE/api/v1/projects/$PROJECT/protopie/churn/recompute?configUuid=$CFG" \
  | jq -r '.results.runUuid')
watch -n5 "curl -s -H 'Authorization: ApiKey $LDPAT' \
  $SITE/api/v1/projects/$PROJECT/protopie/churn/runs/$RUN | jq '.results | {status, accountsScored, errorMessage}'"
```

---

## 13. 관측성

- Airflow UI: DAG run/task 로그, Dataset 그래프.
- 백엔드: `protopie_churn_score_runs` 테이블이 audit log(누가/언제/`accountsScored`/에러). `GET .../runs?limit=N`로도 조회.
- CloudWatch `/ecs/lightdash-log-groups`: 백엔드 Graphile Worker 실행 로그.

---

## 14. 미해결 결정 사항

| # | 결정 필요 | 기본값 제안 |
|---|---|---|
| Q-1 | cross-DAG 방식 (Dataset vs Sensor) | Dataset(옵션 A). 불가 시 Sensor. |
| Q-2 | protopie 마트가 이미 dbt DAG에서 빌드되는가? | data-modeling/dbt_models 확인 후 §6 적용 여부 결정. |
| Q-3 | PAT 소유 계정 (전용 서비스 계정 신설 vs 기존) | 전용 서비스 계정 권장(감사/회수 용이). |
| Q-4 | lookback_days/window 파라미터를 DAG가 넘길 필요가 있나 | 현재 API는 config에서 읽음 → 불필요. config_uuid만 명시. |

---

## 15. 작업 체크리스트

- [ ] P-1 서비스 PAT 발급 (dev)
- [ ] P-2/P-3 PROJECT_UUID, CONFIG_UUID 확보
- [ ] P-4 Airflow→ALB 네트워크 도달 확인
- [ ] P-6/§6 protopie 마트를 `dbt_models` `MARTS_DOMAINS`에 등록 (또는 기존 task 확인)
- [ ] `dbt_models` 마트 task에 Dataset outlet 추가 (옵션 A 선택 시)
- [ ] `protopie_churn_score/` DAG 4파일 작성 (config/api_client/dag/notifications)
- [ ] K8s secret에 `LIGHTDASH_*` env 주입
- [ ] dev에서 수동 트리거 e2e 성공 (accountsScored>0)
- [ ] 의존성 자동 발화 검증
- [ ] dev 스케줄 활성화 + 모니터링
- [ ] (cutover 후) prod env + DAG 활성화
```
