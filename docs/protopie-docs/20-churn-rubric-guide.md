# 20 — Churn Score Rubric 가이드 (사용법 · 권한 · 구조)

> **대상**: Rubric(채점 기준)을 직접 만들거나 수정하려는 사람 — Sales/CS, 데이터, 엔지니어
> **범위**: Lightdash 화면의 **Churn → Rubric** 탭. 점수 계산 내부 로직은 [18-churn-backend-logic-guide.md](./18-churn-backend-logic-guide.md),
> 야간 재계산 파이프라인은 [19-churn-recompute-airflow-dag.md](./19-churn-recompute-airflow-dag.md) 참고
> **영업 담당자용 점수 읽는 법**: [churn-sales-guide.md](./churn-sales-guide.md)

---

## 0. 먼저, 자주 나오는 질문에 대한 답

> **Q. "Can I have access to create a customized rubric without affecting the existing one?"**

**A. 별도 권한 신청이 필요 없습니다. 프로젝트에 접근 권한이 있는 사용자(Viewer 이상)면 누구나
rubric을 만들 수 있고, 그 rubric은 공용 기본 rubric에 전혀 영향을 주지 않습니다. 만들 때
공개 범위도 직접 고릅니다 — 기본은 팀 전체 공개이고, 원하면 나만 보이게 할 수 있습니다.**

영어 답변용 (Slack 붙여넣기):

> You already have it — no extra permission needed. Any project member (Viewer role or above)
> can create their own **custom rubric** on the *Churn → Rubric* page: edit the weights/factors
> you want, type a name in **"New custom rubric"**, and click **"Save edits as custom rubric"**.
>
It is fully isolated from the shared **"Default Churn Score"** rubric:
> - it is stored as a separate config with its own `config_uuid` and its own version history;
> - scores computed with it are written under that `config_uuid`, so they never overwrite the
>   default rubric's scores;
> - you pick **who can see it** — *Everyone in the project* (the default) or *Only me*, and you can
>   flip it any time from the rubric editor;
> - either way **only you and project admins can edit it**, so sharing it does not risk someone
>   overwriting your weights;
> - the *Scores* page has a **Rubric** dropdown, so you can compare "Default" vs. your rubric side by side.
>
> The only thing that is admin-only is **editing the shared "Default Churn Score" rubric itself**
> (project admin or org admin). Everything about your own custom rubric — create, edit, rename,
> delete, recompute — is available to you.
>
> One caution: your rubric is picked up by the nightly recompute job, and each active rubric runs
> a full aggregation query against Redshift. Please delete rubrics you no longer use.

근거 코드: [`ChurnScoreService.requireConfigEdit()`](../../packages/backend/src/protopie/services/ChurnScoreService.ts) —
기본 rubric은 `requireProjectManage`, 그 외 이름은 `requireProjectView` + (본인 소유 or 관리자).

---

## 1. Rubric이란 무엇인가

**Rubric = "이름이 붙은 하나의 채점 공식"** 입니다. 고객사(Account) 한 곳의 90일치 제품 사용
데이터를 몇 개의 **factor(요소)** 로 나눠 채점하고, 그 합을 0~100점의 **건강 점수(health score)** 로
만듭니다.

| 용어 | 뜻 |
|---|---|
| **Rubric (= config)** | 채점 기준 한 벌. 이름 + 버전 + 요소 목록으로 구성. DB의 `protopie_churn_score_configs` 1행 |
| **Factor (요소)** | 채점 규칙 하나. "AI 기능을 쓴 유저 비율" 같은 것. `protopie_churn_score_factors` 1행 |
| **Weight (가중치)** | 그 factor가 받을 수 있는 최대 점수. **모든 factor의 weight 합은 반드시 100** |
| **Goal (목표)** | 만점을 받는 기준값 |
| **Aggregation (집계 방식)** | 실제값(actual)을 어떻게 뽑을지 — 유저 비율 / 이벤트 수 / 유저당 이벤트 수 / 활동 일수 |
| **Events** | 그 factor에 포함되는 제품 이벤트 이름들. 여러 개면 **OR**로 묶임 |
| **Scoring method** | 점수 환산 방식 — `Stepwise (ChurnZero)` 또는 `Linear` |
| **Version** | rubric을 저장할 때마다 +1. 과거 버전은 archived로 남음 |
| **Account key** | 계정 식별자. 엔터프라이즈는 클라우드 URL의 슬러그, Pro-Plus는 Salesforce account name |

핵심 성질 3가지:

1. **버전은 수정되지 않고 새로 쌓인다(immutable).** "Save as new version"을 누르면 기존 활성
   버전은 `archived`가 되고 v+1이 새로 생깁니다. 과거에 계산된 점수는 그때 쓰던 `config_uuid`를
   그대로 들고 있으므로 **소급 변경되지 않습니다("as-was")**.
2. **rubric마다 점수가 따로 저장된다.** `protopie_churn_score`의 유니크 키는
   `(account_key, scored_for_date, lookback_days, config_uuid)` — 즉 `config_uuid`가 다르면
   같은 날 같은 계정이라도 별도 행입니다. **그래서 커스텀 rubric이 기존 점수를 덮어쓸 수 없습니다.**
3. **`"Default Churn Score"` 이름은 예약어**입니다. 이 이름은 공용/관리자 전용이며, 프로젝트에
   없으면 백엔드가 ChurnZero 동일 기준(10개 factor)으로 자동 생성합니다.

---

## 2. 화면 찾아가기

```
Lightdash 상단 네비게이션 → [📋 Churn] 버튼
   └── /projects/{projectUuid}/protopie/churn/rubric   ← Rubric 탭 (채점 기준 편집)
   └── /projects/{projectUuid}/protopie/churn/scores   ← Scores 탭 (계정별 점수 목록)
        └── /.../scores/{accountKey}                   ← 계정 상세 (요소별 달성도 + 이벤트 사용량)
```

두 탭은 화면 상단의 `Scores | Rubric` 탭으로 오갑니다.

> 📷 **[스크린샷 1]** 상단 네비게이션의 `Churn` 버튼 위치
> `![Churn nav button](./images/01-nav-churn-button.png)`

> 📷 **[스크린샷 2]** Rubric 화면 전체
> `![Rubric page](./images/02-rubric-page-full.png)`

### Rubric 화면 구성 (와이어프레임)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Churn score rubric                        [Admin-managed default] [v8] [Max points 100.00]
│ Select the shared default rubric or create your own rubric…                    │
│ ┌ Scores │ Rubric ┐                                                            │
├───────────────────────────────────────────────────────────────────────────────┤
│ Rubric ▾                  New custom rubric            [ Save edits as         │
│ [Default Churn Score (v8)] [EMEA renewal rubric      ]   custom rubric ]        │  ← ①
│                                                                                │
│ [✏ Rename rubric] [🗑 Delete rubric]        ← 커스텀 rubric 선택 시에만 노출     │  ← ②
│                                                                                │
│ Lookback days [90]   Low risk threshold [0.75]   Medium risk threshold [0.50]  │  ← ③
│                                                                                │
│ Scoring method  ( Stepwise (ChurnZero) | Linear )                              │  ← ④
│                                                                    [+ Add factor]
│ ┌──────────┬────────┬──────┬──────┬─────────────┬──────────────────┬─────────┐ │
│ │ Factor   │ Weight │ Goal │ Unit │ Aggregation │ Events           │ Actions │ │  ← ⑤
│ ├──────────┼────────┼──────┼──────┼─────────────┼──────────────────┼─────────┤ │
│ │ % users… │  5     │ 0.5  │Fract.│ % users w/ e│ Studio - App - … │   🗑     │ │
│ │          │ 5·4·2·0│      │      │             │                  │         │ │
│ └──────────┴────────┴──────┴──────┴─────────────┴──────────────────┴─────────┘ │
│                                                                                │
│ Version history                                                                │
│ Previous version [v7 (archived) - 2026-06-10 …]        [🕘 Restore as new version]  ← ⑥
│                                                                                │
│           [↻ Reset unsaved changes] [🧮 Recompute now] [💾 Save as new version] │  ← ⑦
└───────────────────────────────────────────────────────────────────────────────┘
```

| # | 요소 | 설명 |
|---|---|---|
| ① | Rubric 선택 / 새 rubric 이름 / 저장 | 현재 화면의 편집 상태를 **새 이름으로** 저장 = 커스텀 rubric 생성 |
| ② | Rename / Delete | 커스텀 rubric에만 노출. 기본 rubric은 이름 변경·삭제 불가 |
| ③ | Lookback days / 위험 구간 임계값 | 아래 §5 참고 |
| ④ | Scoring method | Stepwise(ChurnZero 동일) 또는 Linear |
| ⑤ | Factor 테이블 | 각 열의 의미는 헤더 옆 **ⓘ 아이콘**에 툴팁으로도 들어 있음 |
| ⑥ | Version history | 과거 버전을 골라 **새 버전으로 복원** |
| ⑦ | 저장 / 재계산 | 저장 후 **Recompute now**를 눌러야 점수가 생성됨 |

---

## 3. 권한 모델 (누가 무엇을 할 수 있나)

권한은 **Lightdash 기본 역할(CASL ability)** 을 그대로 사용합니다. Churn 전용 역할이나 스코프는
따로 만들지 않았습니다(=별도 권한 신청 절차가 없는 이유).

### 3.1 판정 기준 2가지

| 판정 | 의미 | 해당 역할 |
|---|---|---|
| `view Project` | 프로젝트를 볼 수 있음 | **Viewer 이상 모든 프로젝트 멤버**, 조직 멤버 |
| `manage Project` / `manage Organization` | 프로젝트 관리자 | **Project Admin**, **Organization Admin** |

> `editor` / `developer` 역할은 `manage Project`가 **아닙니다**. 즉 developer도 기본 rubric은 못 고칩니다.
> (근거: `packages/common/src/authorization/projectMemberAbility.ts` — `can('manage','Project')`는 `admin()`에만 존재)

### 3.2 작업별 권한표

| 작업 | Viewer / Interactive Viewer / Editor / Developer | Project Admin · Org Admin |
|---|---|---|
| Rubric 화면 열람 | ✅ | ✅ |
| 기본 rubric(`Default Churn Score`) 조회 | ✅ | ✅ |
| **기본 rubric 저장(새 버전)** | ❌ | ✅ |
| **기본 rubric 버전 복원 / 재계산** | ❌ | ✅ |
| 기본 rubric 이름변경·삭제 | ❌ (누구도 불가) | ❌ (누구도 불가) |
| **커스텀 rubric 생성** (공개 범위 선택 포함) | ✅ | ✅ |
| 내가 만든 커스텀 rubric 조회·수정·복원·이름변경·삭제·재계산·공개전환 | ✅ | ✅ |
| **남이 만든 public rubric 조회** | ✅ | ✅ |
| **남이 만든 public rubric 수정·삭제·재계산** | ❌ (읽기 전용) | ✅ |
| **남이 만든 private rubric 조회/수정** | ❌ | ✅ (모두 보임) |
| 점수(Scores) 조회 | 볼 수 있는 rubric에 한해 ✅ | ✅ |

**공개 범위(visibility)** — 커스텀 rubric은 생성 시 둘 중 하나를 고릅니다. 언제든 전환 가능합니다.

| 값 | 화면 표기 | 조회 가능한 사람 |
|---|---|---|
| `public` (**기본값**) | 👥 Shared with project | 프로젝트 멤버 전원 |
| `private` | 🔒 Private to you | 만든 사람 + Project/Org Admin |

핵심: **공개해도 편집권은 넘어가지 않습니다.** public rubric도 수정·삭제·재계산은 만든 사람과
관리자만 가능하며, 남이 열면 저장 버튼이 비활성되고 안내 배너가 뜹니다. 값을 바꿔보고
`Save edits as custom rubric`으로 **자기 사본**을 만드는 것은 자유롭게 됩니다.
`Default Churn Score`는 항상 전원 공개이며 비공개로 바꿀 수 없습니다.

### 3.3 "영향 없음"이 보장되는 지점

| 격리 축 | 보장 방식 |
|---|---|
| 기준 데이터 | 커스텀 rubric은 **별도 `config_uuid`** 를 가진 새 행. 기본 rubric 행을 건드리지 않음 |
| 점수 데이터 | `protopie_churn_score` 유니크 키에 `config_uuid` 포함 → 덮어쓰기 구조적으로 불가 |
| 화면 | Scores 페이지의 **Rubric 드롭다운**으로 rubric별 점수를 따로 조회 |
| 가시성 | `listActiveConfigs()`가 `canViewChurnScoreConfig()` 정책으로 필터링 — private rubric은 소유자·관리자에게만 |
| 편집권 | 공개 여부와 무관하게 `requireConfigEdit`는 소유자·관리자만 통과 |
| 이름 충돌 | `Default Churn Score` 이름으로는 커스텀 rubric 생성 불가(예약어) |

점수 조회 API는 **전부** rubric 가시성을 함께 검사합니다 — `GET /scores/latest`,
`/scores/filter-options`, `/scores/account/details`는 대상 rubric에 `requireConfigView`를
적용하고, `GET /scores/{accountKey}`(계정 이력)는 여러 rubric의 행이 섞이므로 **읽을 수 없는
rubric의 행을 결과에서 제거**합니다. 즉 남의 private rubric의 `configUuid`를 알아도 점수를
읽을 수 없습니다.

> 참고: 그래도 별도 프로젝트만큼 강한 격리는 아닙니다. Project/Org Admin은 모든 private
> rubric과 그 점수를 볼 수 있습니다. 관리자에게조차 보이면 안 되는 실험이라면 별도 프로젝트를
> 쓰세요.

---

## 4. 커스텀 rubric 만들기 (단계별)

### 4.1 기본 흐름 — "기존 것을 복제해서 고치기"

1. **Churn → Rubric** 화면을 엽니다.
2. `Rubric` 드롭다운에서 **출발점이 될 rubric**을 고릅니다 (보통 `Default Churn Score`).
   화면의 모든 값이 그 rubric으로 채워집니다.
3. 원하는 대로 **편집**합니다 — weight 조정, factor 추가/삭제, 이벤트 변경 등.
   (이 시점의 편집은 아직 저장되지 않았고, 기본 rubric에도 영향이 없습니다.)
4. **`New custom rubric`** 입력칸에 새 이름을 씁니다. 예: `EMEA renewal rubric`, `Sol - no AI test`
5. **`Who can see it`** 에서 공개 범위를 고릅니다 — `Everyone in the project`(기본값) 또는 `Only me`.
   나중에 언제든 바꿀 수 있습니다.
6. **`Save edits as custom rubric`** 버튼을 누릅니다.
   → 새 rubric이 **v1**으로 생성되고, 화면의 Rubric 선택이 자동으로 그 rubric으로 바뀝니다.
7. **`Recompute now`** 를 눌러 점수를 생성합니다. (누르지 않으면 다음 날 야간 배치까지 점수가 비어 있습니다.)
8. **Scores** 탭 → `Rubric` 드롭다운에서 새 rubric을 선택해 결과를 확인합니다.

> 📷 **[스크린샷 3]** ①영역 — Rubric 선택 / New custom rubric 입력 / 저장 버튼
> `![Create custom rubric](./images/03-create-custom-rubric.png)`

> 📷 **[스크린샷 4]** Recompute 실행 후 나타나는 `Run completed — N accounts scored` 알림
> `![Recompute result](./images/04-recompute-run-alert.png)`

> 📷 **[스크린샷 5]** Scores 탭의 Rubric 드롭다운(기본 vs 커스텀 비교)
> `![Scores rubric selector](./images/05-scores-rubric-selector.png)`

### 4.2 이름 규칙

- `Default Churn Score` 는 사용 불가(예약어)
- 프로젝트 내에서 **이미 보이는 rubric 이름과 중복 불가** → 중복 시 `Name already exists` 에러
- 소프트 삭제된 rubric의 이름도 계속 점유됩니다(이름 변경 시 충돌 가드가 있음). 재사용하려면 다른 이름을 쓰세요.
- 팀 운영 팁: 개인 실험용은 `<이름> - <목적>` 형태를 권장 (예: `Link - APAC weights v2`)

### 4.3 자주 하는 실수

| 증상 | 원인 | 해결 |
|---|---|---|
| 저장 버튼이 비활성 | weight 합이 100이 아님 / low ≤ medium | 상단 `Max points` 배지와 임계값 확인 |
| 기본 rubric에서 저장 버튼 비활성 + 파란 안내 배너 | 관리자가 아님 | 커스텀 rubric으로 저장 (§4.1) |
| Scores 화면에 커스텀 rubric 점수가 안 보임 | 재계산을 안 함 | Rubric 화면에서 `Recompute now` |
| 이름 저장 후 화면이 그대로인 것 같음 | 실제로는 새 rubric으로 전환됨 | 상단 배지가 `v1`인지 확인 |

---

## 5. 편집 항목의 의미와 검증 규칙

### 5.1 rubric 단위 설정

| 항목 | 의미 | 검증 |
|---|---|---|
| **Lookback days** | 한 번의 재계산에 포함할 제품 이벤트 기간(일). 기본 90 | 양의 정수 |
| **Low risk threshold** | `scorePercent`(획득점수/만점, 0~1)가 이 값 이상이면 🟢 Low risk. 기본 0.75 | 유한수, **low > medium** |
| **Medium risk threshold** | low 미만이면서 이 값 이상이면 🟡 Medium, 미만이면 🔴 High. 기본 0.50 | 유한수 |
| **Scoring method** | `Stepwise (ChurnZero)` / `Linear` | 둘 중 하나 |

> 위험 구간은 **건강 점수 기준**입니다. 점수가 높을수록 안전(= ChurnZero의 ChurnScore와 방향이 반대).
> 자세한 내용은 [churn-sales-guide.md §2](./churn-sales-guide.md) 참고.

### 5.2 factor 단위 설정

| 열 | 의미 | 비고 |
|---|---|---|
| **Factor** | 화면에 표시되는 라벨 | 비어 있으면 저장 실패 |
| **Weight** | 이 factor의 최대 점수 | **전체 합 = 100 (필수)**, 0 이상 |
| **Goal** | 만점 기준값 | 0 이상 |
| **Unit** | Goal 읽는 법 — Fraction(0~1) / Count / Count per user / Days | 표시용 |
| **Aggregation** | 실제값 계산 방법 (아래) | |
| **Events** | 포함할 이벤트 이름들. **OR 결합** | `Active days`는 이 목록을 무시 |
| **Actions** | factor 삭제 | 마지막 1개는 삭제 불가 |

**Aggregation 4종**

| 값 | 실제값(actual) 계산 | 비고 |
|---|---|---|
| `% users with event` | 선택 이벤트를 발생시킨 유니크 유저 수 ÷ 계정 총 유저 수 | 버킷 비교 시 ×100(%) 단위 |
| `Event count` | 선택 이벤트의 총 발생 수 | |
| `Events per user` | 총 발생 수 ÷ 계정 총 유저 수 | |
| `Active days` | 이벤트 종류 무관, 활동한 **서로 다른 날짜 수** | Events 입력칸 비활성화 |

> 분모(계정 총 유저 수)는 dbt 마트 `protopie_account_user_counts.distinct_user_count`입니다
> (Salesforce 계정 로스터 기준). 이벤트가 하나도 없는 계정도 로스터에 있으면 0점으로 채점됩니다.

### 5.3 저장 시 백엔드 검증 (`validateChurnScoreConfigInput`)

- `lookbackDays` 양의 정수
- `scoreFunction` ∈ {linear, stepwise}
- `riskBandThresholds.low > .medium`, 둘 다 유한수
- factor ≥ 1개, `factorKey` 중복 불가, `factorKey`는 `^[A-Za-z_][A-Za-z0-9_]*$`
- `label` 필수, `maxPoints`/`goalValue` ≥ 0
- `windowDays`는 양의 정수 또는 null
- stepwise면 `stepThresholds.ranges` 필수, 각 구간 `0 ≤ points ≤ maxPoints`, `top ≥ bottom` 또는 null
- **weight 합계 = 100 (허용 오차 1e-6)** → 아니면 `Churn score factor weights must total 100.`
- 이벤트 이름: 255자 이하, 제어문자 불가

### 5.4 UI에 노출되지 않는 필드 (알아둘 것)

| 필드 | 동작 |
|---|---|
| `windowDays` (factor별 조회 기간) | 화면에 편집 UI가 **없습니다**. 기존 factor는 값이 그대로 보존되고(예: `% activated`는 120일), **새로 추가한 factor는 `null` → rubric의 Lookback days를 따릅니다** |
| `stepThresholds` (점수 버킷) | stepwise로 저장할 때 **weight/aggregation으로부터 자동 재생성**됩니다. 화면에서 직접 편집 불가. Weight 칸 아래 회색 숫자(`5 · 4 · 2 · 0`)가 생성될 버킷 미리보기입니다 |
| `factorKey` | 새 factor는 `custom_factor_1`, `custom_factor_2` … 로 자동 부여 |

---

## 6. 점수 환산 방식 (요약)

### Stepwise (ChurnZero 동일) — 기본값

실제값이 속한 **구간의 정수 점수**를 그대로 부여합니다. 구간은 weight로부터 자동 생성:

| Aggregation | 버킷 (bottom → points) |
|---|---|
| `% users with event` (일반) | 51%+ → 100%, 26–50% → 66%, 1–25% → 33%, 0 → 0 |
| `% activated / logged-in` (특수) | 51%+ → 100%, 1–50% → 50%, 0 → 0 |
| `Events per user` | 21+ → 100%, 11–20 → 66%, 1–10 → 33%, 0 → 0 |
| `Active days` | 11+ → 100%, 6–10 → 66%, 1–5 → 33%, 0 → 0 |
| `Event count` | goal 이상 → 100%, 1 ~ goal-1 → 50%, 0 → 0 |

- 백분율은 **올림(ceil)**: 10점 factor의 66% = 6.6 → **7점** (ChurnZero 화면과 일치)
- 구간 판정은 **버림(truncate)**: `bottom ≤ 실제값`을 만족하는 구간 중 가장 큰 bottom을 채택.
  예) 유저당 0.88건은 bottom 1 미만이므로 **0점**

### Linear

`points = min(actual / goal, 1) × weight` — 부분 점수를 비례 배분합니다. 실험/비교용.

> 계산 상세와 불변식은 [18-churn-backend-logic-guide.md §2](./18-churn-backend-logic-guide.md) 참고.

---

## 7. 기본 rubric의 10개 factor (참고 기준선)

| # | Factor | Weight | Goal | Aggregation | 조회기간 |
|---|---|---:|---|---|---:|
| 1 | % users with starting action | 5 | 0.5 | % users | 90d |
| 2 | # starting actions per user | 5 | 20 | per user | 90d |
| 3 | % activated / logged-in users | 10 | 0.5 | % users | **120d** |
| 4 | # pie creation / save actions per user | 10 | 20 | per user | 90d |
| 5 | % users with pie creation / save action | 10 | 0.5 | % users | 90d |
| 6 | % users with AI feature usage | 10 | 0.5 | % users | 90d |
| 7 | % users with Trigger or Response action | 15 | 0.5 | % users | 90d |
| 8 | # trigger/response actions per user | 15 | 20 | per user | 90d |
| 9 | Number of Messages Received | 10 | 5 | event count | 90d |
| 10 | Active days | 10 | 10 | active days | 90d |
| | **합계** | **100** | | | |

> ⚠️ **#9 `Number of Messages Received`는 항상 0점**입니다. ChurnZero의 인앱 메시지에 대응하는
> Amplitude 이벤트 소스가 없어 이벤트 목록이 비어 있으며, ChurnZero도 동일하게 0/10을 주므로
> **의도적으로 분모 100에 남겨둔** 것입니다. 커스텀 rubric에서 이 10점을 다른 factor로
> 재분배하는 것은 정당한 실험이지만, 그 순간 **ChurnZero 대비 동일성(parity)은 깨집니다.**

정의 위치: [`packages/common/src/protopie/churnScore/constants.ts`](../../packages/common/src/protopie/churnScore/constants.ts)

---

## 8. 버전 관리 · 이름 변경 · 삭제

### 8.1 버전 (Save as new version)

- 저장할 때마다 `version` +1, 기존 활성 버전은 `archived`
- 프로젝트+이름 조합당 **활성 버전은 항상 1개** (DB 부분 유니크 인덱스)
- 과거 점수는 계산 당시 `config_uuid`를 유지 → **소급 변경 없음**
- 새 기준으로 과거를 다시 채우려면(backfill) 별도 관리자 작업이 필요합니다(자동 아님)

### 8.2 버전 복원 (Restore as new version)

`Version history`에서 과거 버전을 선택하고 `Restore as new version`을 누르면, 그 버전의 내용이
**새 버전으로 복제**되어 활성화됩니다(과거 버전을 되살리는 게 아니라 복사본을 만듦).

### 8.3 이름 변경 (Rename)

- 커스텀 rubric만 가능. 라벨만 바뀌며 `config_uuid`는 그대로 → **점수는 하나도 안 움직입니다**
- 모든 버전의 이름이 함께 바뀝니다
- 삭제된 rubric이 점유한 이름으로는 변경 불가

### 8.4 공개 범위 전환 (Share with project / Make private)

- 커스텀 rubric만 가능. `Rename`/`Delete` 버튼 옆에 있습니다
- **모든 버전에 함께 적용**됩니다. 버전마다 공개 여부가 다른 상태는 만들 수 없습니다
- `config_uuid`는 그대로이므로 **점수는 하나도 움직이지 않습니다** — 이미 계산된 점수의
  조회 권한만 즉시 바뀝니다
- 새 버전을 저장하거나 과거 버전을 복원해도 **현재 활성 버전의 공개 범위를 승계**합니다.
  (과거 버전을 복원했다고 옛 공개 설정이 되살아나지 않습니다)
- `Default Churn Score`는 항상 전원 공개이며 전환이 거부됩니다

### 8.5 삭제 (Delete)

- 커스텀 rubric만 가능 (기본 rubric은 서버가 거부)
- **소프트 삭제**입니다: `status='deleted'`로 표시되어 편집기/목록에서 사라지지만,
  이미 계산된 점수 행과 설정 행은 감사·이력 목적으로 **보존**됩니다
- 삭제 후 Rubric 선택이 자동으로 기본 rubric으로 돌아갑니다

---

## 9. 재계산: 언제 점수가 생기나

### 9.1 수동 (`Recompute now`)

1. 버튼 클릭 → `POST .../churn/recompute?configUuid=…` → **202 Accepted + `runUuid`**
2. Graphile Worker(백엔드 컨테이너 내부)가 비동기로 실행
3. 화면이 run 상태를 폴링해 `Run completed — N accounts scored` / `Run failed`를 표시

> 권한: 기본 rubric 재계산은 관리자만. 커스텀 rubric은 소유자가 가능.

### 9.2 야간 자동 (Airflow DAG `protopie_churn_score`)

```
dbt_models DAG  ──(marts.dbt_warehouse_churn 성공)──▶ ExternalTaskSensor
                                                          │
                                              list_active_configs  (GET /churn/configs)
                                                          │  fan-out (dynamic task mapping)
                                              recompute_config[*]  (POST /recompute + 상태 폴링)
                                                          │
                                                    Slack 알림 (#data-pipeline)
```

- 스케줄: `0 6 * * *` (UTC), `dbt_models`와 동일 논리 날짜. 실제 시작은 **센서가 마트 완료를 확인한 뒤**
- **활성 rubric을 런타임에 조회해 전부 재계산**합니다 → **커스텀 rubric도 다음 날부터 자동으로 점수가 쌓입니다**
- 재계산은 `(account_key, scored_for_date, lookback_days, config_uuid)` 기준 upsert이므로 재시도 안전
- `accountsScored = 0`이면 그 rubric의 태스크만 실패 처리(다른 rubric은 진행)
- 위치: `/Users/sol/Desktop/XID/airflow/airflow/dags/protopie_churn_score/`

> ⚠️ **운영 주의 1 — DAG가 쓰는 PAT는 관리자 계정이어야 합니다.** `list_active_configs`는 PAT
> 사용자에게 보이는 rubric만 반환합니다. PAT가 비관리자면 **다른 사람의 커스텀 rubric은 야간
> 재계산에서 누락**됩니다.
>
> ⚠️ **운영 주의 2 — 활성 rubric 수 = 야간 Redshift 쿼리 수.** rubric 하나당 전체 계정 집계
> 쿼리가 한 번씩 돕니다. 다 쓴 실험용 rubric은 삭제해 주세요.

### 9.3 신선도 게이트 (freshness gate)

마트의 최신 `event_date`가 **2일 이상** 지났으면 재계산을 `skipped`로 종료하고 Slack 알림만
보냅니다. dbt 실패 시 **기존 점수를 빈 값으로 덮어쓰는 사고를 막기 위한 안전장치**입니다.

---

## 10. 데이터가 어디서 오는가 (구조)

```
Amplitude / Salesforce / App DB
        │
        ▼  (Airflow: dbt_models DAG)
dbt (data-modeling repo) — models/marts/warehouse/churn/daily/
   ├── protopie_account_event_usage_enterprise_cloud.sql   엔터프라이즈/전용 클라우드 이벤트
   ├── protopie_account_event_usage_proplus.sql            Pro-Plus 이벤트
   ├── protopie_account_event_usage_enterprise_all.sql     ▲ 둘의 UNION  ← 분자
   ├── protopie_account_user_counts.sql                    계정 로스터 + 유저 수 ← 분모
   └── protopie_account_contacts.sql
        │
        ▼  Redshift (warehouse_dev / warehouse_prod)
Lightdash 백엔드 ChurnScoreService.executeRecompute()
   ├── buildAggregationQuery()  factor별 window로 계정×지표 집계 (WarehouseClient 경유)
   ├── scoreAccount()           weight/버킷 적용 → totalPoints, normalizedScore, churnScore, riskBand
   └── upsert → Postgres protopie_churn_score
        │
        ▼
Lightdash 화면 (Scores / 계정 상세) + REST API
```

**Postgres 테이블 (Lightdash DB)**

| 테이블 | 역할 | 핵심 제약 |
|---|---|---|
| `protopie_churn_score_configs` | rubric 1버전 = 1행 | `unique(project_uuid, name, version)`, 활성은 이름당 1개 |
| `protopie_churn_score_factors` | factor | `unique(config_uuid, factor_key)` |
| `protopie_churn_score` | 계정×날짜×rubric 점수 | `unique(account_key, scored_for_date, lookback_days, config_uuid)` |
| `protopie_churn_score_runs` | 재계산 실행 이력 | status: queued/running/completed/failed/skipped |

**점수 계산은 반드시 백엔드에서만** 이뤄집니다. dbt에 점수 모델을 만들면 대시보드와 값이
조용히 갈라지므로 금지되어 있습니다.

**주요 파일**

| 위치 | 내용 |
|---|---|
| `packages/frontend/src/protopie/ProtopieChurnScoreRubricPage.tsx` | Rubric 편집 화면 |
| `packages/frontend/src/protopie/ProtopieChurnScoresPage.tsx` | 점수 목록 화면 |
| `packages/backend/src/protopie/controllers/ChurnScoreController.ts` | REST 엔드포인트 |
| `packages/backend/src/protopie/services/ChurnScoreService.ts` | 권한 판정 + 재계산 오케스트레이션 |
| `packages/backend/src/protopie/services/churnScore/scoreAccount.ts` | 점수 환산 |
| `packages/backend/src/protopie/services/churnScore/buildAggregationQuery.ts` | 마트 집계 SQL |
| `packages/common/src/protopie/churnScore/constants.ts` | 기본 10 factor · 버킷 정의 |

---

## 11. API 레퍼런스

베이스: `/api/v1/projects/{projectUuid}/protopie/churn`
인증: 세션 쿠키 또는 PAT (`Authorization: ApiKey <token>`)

| 메서드 | 경로 | 설명 | 권한 |
|---|---|---|---|
| GET | `/config?name=` | 활성 rubric + factor 조회 | view (+본인/관리자) |
| GET | `/configs` | 보이는 활성 rubric 목록 | view |
| GET | `/config/versions?name=` | 버전 이력 | view (+본인/관리자) |
| PUT | `/config` | 새 버전 저장 (**이름을 새로 주면 커스텀 rubric 생성**) | 기본=admin / 커스텀=본인 |
| POST | `/config/versions/{configUuid}/restore` | 버전 복원 | 위와 동일 |
| PUT | `/config/rename` | 이름 변경 | 커스텀 소유자/관리자 |
| PUT | `/config/visibility` | 공개 범위 전환 (`{name, visibility}`) | 커스텀 소유자/관리자 |
| DELETE | `/config?name=` | 소프트 삭제 | 커스텀 소유자/관리자 |
| POST | `/recompute?configUuid=` | 재계산 큐잉 → 202 `{runUuid}` | 기본=admin / 커스텀=본인 |
| GET | `/runs`, `/runs/{runUuid}` | 실행 이력/상태 | view |
| GET | `/events?search=&limit=` | 선택 가능한 이벤트 이름 목록 | view |
| GET | `/scores/latest?configUuid=&riskBand=&…` | 최신 점수 목록 | view |
| GET | `/scores/filter-options` | 필터 드롭다운 값 | view |
| GET | `/scores/account/details?accountKey=` | 계정 상세 + 이벤트 사용량 | view |
| GET | `/scores/{accountKey}` | 계정 점수 이력 | view |

예시 — 커스텀 rubric 생성(요약):

```bash
curl -X PUT "$SITE_URL/api/v1/projects/$PROJECT_UUID/protopie/churn/config" \
  -H "Authorization: ApiKey $LDPAT" -H "Content-Type: application/json" \
  -d '{
    "name": "EMEA renewal rubric",
    "lookbackDays": 90,
    "scoreFunction": "stepwise",
    "riskBandThresholds": { "low": 0.75, "medium": 0.5 },
    "factors": [ /* weight 합계 100 */ ]
  }'
```

---

## 12. FAQ

**Q. 커스텀 rubric을 만들면 기존 점수가 바뀌나요?**
아니요. 점수는 `config_uuid`별로 저장되며, 기존 rubric의 행은 건드리지 않습니다.

**Q. 내 rubric을 다른 사람도 볼 수 있나요?**
기본값(`Everyone in the project`)이면 프로젝트 멤버 전원이 봅니다. `Only me`로 만들거나
전환하면 본인과 프로젝트/조직 관리자만 봅니다. 어느 쪽이든 **편집은 본인과 관리자만** 가능합니다.

**Q. 동료의 rubric을 내 것으로 가져오고 싶습니다.**
그 rubric을 선택해 값을 확인·수정하고, `New custom rubric`에 내 이름을 붙여
`Save edits as custom rubric`으로 저장하면 내 소유의 사본이 됩니다. 원본은 그대로입니다.

**Q. 만들면 매일 자동으로 계산되나요?**
네. 야간 Airflow DAG가 활성 rubric 전체를 재계산합니다(§9.2 주의사항 참고).

**Q. 기본 rubric을 바꾸고 싶습니다.**
프로젝트 admin 또는 조직 admin에게 요청하세요. 다만 **먼저 커스텀 rubric으로 검증한 뒤**
동일한 값을 기본에 반영하는 순서를 권장합니다.

**Q. weight 합을 100이 아닌 값으로 두고 싶습니다.**
불가합니다. 정규화(0~100 점수)와 ChurnZero 동일성 유지를 위한 강제 규칙입니다.

**Q. 특정 factor의 조회 기간만 바꾸고 싶습니다.**
현재 UI에 없습니다. API(`windowDays`)로는 가능하며, 화면에서 새로 추가한 factor는 rubric의
Lookback days를 따릅니다.

**Q. 실험이 끝났습니다. 어떻게 정리하나요?**
`Delete rubric`으로 삭제하세요. 점수 이력은 남고 야간 재계산 대상에서 빠집니다.

---

## 13. 스크린샷 캡처 체크리스트

> 이 문서의 이미지 슬롯은 아직 **비어 있습니다**. 아래 순서대로 캡처해
> `docs/protopie-docs/images/` 에 같은 파일명으로 저장하면 본문 링크가 바로 연결됩니다.
> 캡처 시 **고객사 실명·MRR이 보이는 영역은 마스킹**해 주세요.

| 파일명 | 화면 | 캡처 대상 |
|---|---|---|
| `01-nav-churn-button.png` | 아무 프로젝트 페이지 | 상단 네비게이션의 `Churn` 버튼 (하이라이트) |
| `02-rubric-page-full.png` | `/protopie/churn/rubric` | 기본 rubric 선택 상태의 전체 화면 (배지 `Admin-managed default`, `v8`, `Max points 100.00` 포함) |
| `03-create-custom-rubric.png` | 동 | `Rubric` / `New custom rubric` / `Save edits as custom rubric` 3요소가 보이는 상단 영역 |
| `04-recompute-run-alert.png` | 동 | `Recompute now` 실행 후 `Run completed — N accounts scored` 알림 |
| `05-scores-rubric-selector.png` | `/protopie/churn/scores` | `Rubric` 드롭다운을 펼쳐 기본 + 커스텀 rubric이 함께 보이는 상태 |
| `06-permission-banner.png` | `/protopie/churn/rubric` (비소유자 계정) | 남의 public rubric 선택 시 나오는 파란 배너 `This rubric belongs to someone else` + 비활성 저장 버튼 |
| `10-visibility-control.png` | `/protopie/churn/rubric` | `Who can see it` 드롭다운을 펼친 상태 + 상단 `👥 Shared with project` / `🔒 Private to you` 배지 |
| `11-visibility-toggle.png` | 동 (내가 만든 rubric 선택) | `Make private` / `Share with project` 버튼이 `Rename`·`Delete` 옆에 있는 영역 |
| `07-factor-table.png` | 동 | Factor 테이블 1~2행 + Weight 칸 아래 stepwise 버킷 미리보기(`5 · 4 · 2 · 0`) |
| `08-version-history.png` | 동 | `Version history` 영역 (이전 버전 드롭다운 + Restore 버튼) |
| `09-account-details.png` | `/protopie/churn/scores/{accountKey}` | `Factor results` 표 (Actual / Goal / Achievement / Weight / Points) |

캡처 후 본문의 `> 📷 [스크린샷 N]` 블록에서 인용부호(`>` 와 백틱)를 제거해 이미지 문법을 활성화하세요.

---

## 부록 — 관련 문서

| 문서 | 내용 |
|---|---|
| [18-churn-backend-logic-guide.md](./18-churn-backend-logic-guide.md) | 점수 계산 내부 로직 (엔지니어용) |
| [19-churn-recompute-airflow-dag.md](./19-churn-recompute-airflow-dag.md) | 야간 재계산 DAG 설계 |
| [churn-sales-guide.md](./churn-sales-guide.md) | 영업/CS용 점수 읽는 법 |
| [17-churn-score-implementation-plan.ko.md](./17-churn-score-implementation-plan.ko.md) | rubric 스키마 설계 원안 |
| [11-dbt-integration.md](./11-dbt-integration.md) | dbt 마트 연동 |
