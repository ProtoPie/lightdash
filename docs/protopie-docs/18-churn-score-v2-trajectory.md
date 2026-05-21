# 18 — Churn Score v2 (Trajectory-Aware, Counting-Math Edition)

> **Status:** review draft. No backend code yet. This is the **v2** churn score spec — a trajectory-aware companion to the **v1** rubric in [17-churn-score-implementation-plan.md](./17-churn-score-implementation-plan.md). All math is SQL counts and ratios — no ML, no statistical models, no Python.

## The v1 / v2 split

We are shipping **two parallel churn-score versions** that coexist on the dashboard. **v1 is the contractual replacement for ChurnZero** (ships for the 2026-07-30 cutover). **v2 is the data-informed companion** (additive, post-cutover).

| | **v1 — Notion rubric** | **v2 — Trajectory (this doc)** |
|---|------------------------|--------------------------------|
| Origin | Sales-defined; mirrors ChurnZero's 10-factor weighting | Data-informed; derived from historical churn patterns |
| What it answers | "Are they meeting the bar **right now**, over the last 90 days?" | "Are they **falling off** the bar they used to meet?" |
| Inputs | 10 weighted factors across event usage, message count, and active days — point-in-time | Per-action retention, frequency slopes, days-since-last, returning-vs-churning users, concentration, onboarding velocity |
| Editable by sales | ✓ Weights, goals, event groups via the rubric editor | ✗ Calibration-only — sales sees suggested adjustments to v1 weights based on what v2 finds |
| Cutover dependency | ✓ Required for July 30 ChurnZero off-date | ✗ Additive, post-cutover work |
| Status | Implemented (see commit `c49297cc4b`) | Planned in this doc |

> **v2 is a separate score, not a blend.** Both scores coexist side-by-side on the dashboard — sales sees v1 prominently (the score they own) and v2 as a secondary, data-driven signal. **We do NOT compute `v2 = α·v1 + β·trajectory_health`.** Blending dilutes both: it's a worse v1 (mixed with novelty) and a worse v2 (mixed with point-in-time noise). The two are decision-support twins, not a single composite.

**Schema reuse.** Both versions live in the existing `protopie_churn_score` table, discriminated by `config_uuid`. The schema doesn't change. v1 and v2 each have their own `protopie_churn_score_configs.name` (e.g. `"Notion Rubric v1"` and `"Trajectory v2"`), independently versioned. The recompute scheduler runs once per config. Dashboards filter on `config.name` to pick which line to display.

## Why v2 exists

The v1 rubric scores each enterprise team using a **90-day snapshot**: how many users hit each event group, how many events per user, how many active days. It's a useful "right now" pulse, but it can't distinguish:

- An Account that's been quiet from day 1 (probably **never activated**) versus
- An Account that **used to be busy and is now quiet** (actively losing the customer)

Both score low on the point-in-time v1 rubric. Sales needs to treat them very differently. v2 adds a **trajectory** dimension — how usage has evolved over the Account's lifetime — without changing v1.

Enterprise has no "downgrade" path: customers either use the product or they don't. So churn is binary, and the most actionable signal is **decay over time**: which actions dropped, which actions stopped entirely, when each event last happened. v2 turns that decay into numbers.

---

## Churn label

Before any signal below is useful, lock down one definition of churn. Proposed:

```
A team is "churned" if any of:
  - dim_team_summary.deleted_at IS NOT NULL, OR
  - the team's license/contract ended and was not renewed within 30 days, OR
  - the team had zero events for ≥ 90 consecutive days AND no renewal followed
```

Stored as a new Postgres table, `protopie_churn_labels`:

```
team_id, namespace, churn_date, baseline_start, baseline_end, source, notes
```

Either populated by a dbt view over `dim_team_summary` + plan history, or sales-curated when reasons matter. **Without this table, none of the v2 calibration in §3 is meaningful.**

---

## 1. Signals (pure SQL, all counting)

Each signal is per-team, derived from `dim_product_all_events` + `dim_product_all_event_properties`. None requires more than `GROUP BY`, `COUNT`, `SUM`, `DATE_TRUNC`, and `MAX(event_time)`.

### 1.1 Action retention per user

Of the users who used to do action X, what fraction still do?

```
retained_users_pct(X) =
    COUNT(DISTINCT user who did X in BOTH baseline and last 30d)
    /
    COUNT(DISTINCT user who did X in baseline)
```

Computed per Account × action group. **Low number = bleeding active users on a core action.**

### 1.2 Action frequency trend

Is action X getting more or less frequent over time?

```
slope(X) = (last_3mo_avg_count - first_3mo_avg_count) / first_3mo_avg_count
```

Per Account × action group. `-1.0` means stopped entirely. `0.0` means flat. `+0.5` means 50% growth. **Just two averages.**

### 1.3 Days since last action

```
days_since_last(X) = DATE_DIFF(CURRENT_DATE, MAX(event_time WHERE event_name IN X), DAY)
```

The most actionable single metric. Sales reads "they haven't created a pie in 47 days" and acts immediately.

### 1.4 Active-user retention (returning vs churning users)

```
returning  = COUNT(DISTINCT user active in BOTH prior 30d AND last 30d)
churning   = COUNT(DISTINCT user active in prior 30d but NOT last 30d)
new        = COUNT(DISTINCT user active in last 30d but NOT prior 30d)
```

**If `churning > returning`, individual users are leaving** — even when total event count looks stable because new users replace them. The v1 rubric misses this entirely.

### 1.5 Concentration risk

```
top_3_user_share = SUM(events from top 3 users in last 90d) / SUM(all events in last 90d)
```

If 90%+ of activity comes from three users, the Account is one departure away from going silent.

### 1.6 Velocity to first value (onboarding-only)

For Accounts in their first 90 days:

```
days_to_first_pie_created    = DATE_DIFF(first_pie_create_event, team_created_at)
days_to_5_active_users        = DATE_DIFF(date_when_5th_user_active, team_created_at)
days_to_first_trigger_added   = DATE_DIFF(first_trigger_response_event, team_created_at)
```

Slow ramps correlate with eventual churn.

---

## 2. The v2 score formula (separate from v1, no blending)

`trajectory_health` is the v2 score. It is a 0–100 number computed from the §1 signals alone — **not** mixed with v1.

```
trajectory_health =
    25% * normalize(action_retention_avg)       -- §1.1 average over the 9 action groups
  + 20% * normalize(frequency_trend_avg)        -- §1.2 average slope, normalized so -1.0=0pts, 0.0=mid, +0.5=full
  + 20% * normalize(freshness_avg)              -- §1.3 inverse: fewer days since last = more points
  + 15% * normalize(active_user_retention)      -- §1.4 returning / (returning + churning)
  + 10% * normalize(concentration_health)       -- §1.5 inverse: lower top-3 share = more points
  + 10% * normalize(onboarding_velocity)        -- §1.6 only for Accounts < 180 days old; older Accounts get a fixed 100% on this dimension
```

Sub-weights inside `trajectory_health` (25 / 20 / 20 / 15 / 10 / 10) are **starting points**, not contractual. They should be recalibrated using §3 once `protopie_churn_labels` is populated.

The output is in the same 0–100 shape as v1 so the two display side-by-side without unit-conversion friction. Both are scored under "low / medium / high" risk bands with the same thresholds (75 / 50).

---

## 3. Using history to calibrate (still pure counting)

For each of the 9 action groups (the v1 factor set), compute the **drop rate gap** between churned customers and retained ones:

```
churners_dropped(F)  = COUNT(churned teams where slope(F) < -0.5) / total_churners
retainers_dropped(F) = COUNT(retained teams where slope(F) < -0.5) / total_retainers

predictiveness(F) = churners_dropped(F) - retainers_dropped(F)
```

Interpret:

- **Large positive** (e.g., 75% of churners dropped factor F vs 10% of retainers) → factor F is meaningful early-warning → consider **raising** its v1 weight AND its share inside v2 `trajectory_health`.
- **Near zero** → factor F drops at similar rates in both groups → noise → consider **lowering** its v1 weight.
- **Negative** → suspicious; investigate, don't act.

Surface as a side panel in the v1 rubric editor:

| Factor                       | Current v1 weight | Churner drop rate | Retainer drop rate | Δ predictiveness | Suggested |
|------------------------------|-------------------|--------------------|---------------------|-------------------|-----------|
| Pie creation                 | 10                | 75%                | 15%                 | **+60%**          | ⬆ raise   |
| Starting action              |  5                | 65%                | 50%                 | +15%              | ≈ keep    |
| AI feature usage             | 10                | 30%                | 25%                 |  +5%              | ⬇ lower   |
| Trigger / Response action    | 15                | 80%                | 20%                 | **+60%**          | ⬆ raise   |
| Active days                  | 10                | 85%                | 10%                 | **+75%**          | ⬆ raise   |

**This is not auto-tuning.** Sales still owns v1 weights. The data shows up alongside so they can argue from evidence instead of intuition.

---

## 4. Risk patterns (categorical, derived from §1 signals)

Beyond the continuous `trajectory_health`, classify each current Account into one of a few decay shapes seen in churned customers' histories:

```sql
risk_pattern = CASE
    WHEN slope(pie_creation) < -0.5
        AND slope(trigger_response) < -0.5
        AND slope(active_days) < -0.3
            THEN 'slow_fade'           -- gradual decline across the board

    WHEN days_since_last_event > 60
        AND mom_drop_last_month > 0.7
            THEN 'cliff_drop'          -- used to be active, fell off recently

    WHEN days_to_first_pie_created > 60
        AND age_days < 180
            THEN 'never_activated'     -- young team that never ramped

    WHEN top_3_user_share > 0.85
            THEN 'concentration_risk'  -- single-power-user dependency

    WHEN slope(pie_creation) < -0.7
        AND slope(starting_action) > -0.2
            THEN 'single_action_decay' -- core action dropped but logins fine

    ELSE 'healthy'
END
```

Patterns map to specific sales plays:

- **`slow_fade`** — exec check-in; usually a champion/team-direction issue.
- **`cliff_drop`** — call immediately; something acute happened.
- **`never_activated`** — onboarding intervention.
- **`concentration_risk`** — proactive: broaden adoption.
- **`single_action_decay`** — feature investigation; possible use-case mismatch.
- **`healthy`** — no action.

The pattern is **categorical and explainable**. Sales sees both the score (continuous) and the pattern (label).

---

## 5. Dashboard surface

Adds three things to the v1 Account 360 view:

- **Trajectory sparkline** — last 12 months of `events_per_user_per_week`. The shape itself is information.
- **Per-action retention table** — for each of the 9 factors, §1.1 retention-pct + §1.3 days-since-last. "Pie creation dropped 80% → 12%, last AI usage 73 days ago."
- **Risk pattern tag** — the §4 categorical label next to the score: `Score 42 · slow_fade`.

Portfolio dashboard:

- An extra column with the risk pattern; filterable. "Show me everyone with `cliff_drop` this month."

---

## 6. New dbt models + Postgres table

Three additive marts (pure SQL, no Python) + one Postgres table:

1. **`mart_account_event_history_monthly`** — one row per (`team_id`, `event_name`, `event_month`), with `events_total`, `users_active`. **The single biggest enabler.** Powers every slope, every sparkline, every active-user-retention calc. Without it, every signal needs a full event-table scan.

2. **`mart_account_signals_current`** — one row per `team_id`, denormalized. Columns: every signal from §1 + the §4 `risk_pattern`. Updated nightly. The dashboard reads from this directly.

3. **`mart_churn_signal_calibration`** — one row per (`action_group`, `signal_type`), with the §3 churner-vs-retainer drop-rate gap. Refreshed monthly or when `protopie_churn_labels` changes. Powers the rubric editor's suggested-weights panel.

Plus:

4. **`protopie_churn_labels`** (Postgres) — definitive list of (team_id, churn_date, baseline_window, source). dbt-driven sync or sales-curated.

---

## 7. Pitfalls

- **Survivor bias in the baseline.** "First 90 days of churned customers" may already be below par. Use a separate **healthy-baseline** from currently-retained Accounts of similar tenure for "what does healthy look like" references.
- **Seasonality.** A team that quiets down in December isn't churning. Slopes should be year-over-year for the same month once history allows; until then document the caveat.
- **Small sample.** With ~tens of historical churns, the §3 calibration table needs explicit minimums — show "n = 12 churners" next to each row so sales knows when to trust "+60% predictiveness" vs treat it as anecdote.
- **Label noise.** A team that "ended" might have been renewed under a different namespace. The label table needs occasional human review.
- **Event-ingestion lag.** "Days since last X" depends on warehouse freshness. Document the warehouse-lag SLO in the dashboard footer.

---

## 8. Phased rollout

The v1 (point-in-time rubric, July 30 cutover) stays as-is. v2 is additive:

| Phase | Goal | Output |
|-------|------|--------|
| v1.0 (now) | Hand-tuned v1 rubric ships, ChurnZero off by July 30 | Already in motion |
| v1.1 | Trajectory sparklines on Account 360 | `mart_account_event_history_monthly` |
| v1.2 | Per-action retention + days-since-last tiles | `mart_account_signals_current` |
| v1.3 | Churn label table + v2 score visible alongside v1 | `protopie_churn_labels`, new v2 config in `protopie_churn_score_configs` |
| v1.4 | Calibration panel in rubric editor | `mart_churn_signal_calibration` |
| v1.5 | Risk-pattern column on Portfolio + Account 360 | Extends `mart_account_signals_current` |

No model, no training, no Python — every step is dbt SQL + Lightdash explores over the new marts.

---

## 9. The trust contract

v1 stays sales-owned and human-set. v2 is **evidence and aid**, never replacement. The moment the dashboard hides v1 in favor of "the data says X," sales loses trust in the score they're supposed to defend to customers.

So the contract is:

- **v1 score = sales-owned rubric output.** Visible, defensible, editable.
- **v2 `trajectory_health` = data-driven signal.** Displayed alongside v1, never replacing it.
- **Risk pattern = a label.** Useful for routing the next call.
- **§3 calibration = evidence for tuning v1.** Sales decides whether to adopt the suggestion.

Same accountability shape v1 already has — just data-informed now.

---

## 10. Open questions

1. **Churn label source of truth.** Is `dim_team_summary.deleted_at` populated reliably for enterprise churns? Or do we need a sales-curated `protopie_churn_labels` from day 1?
2. **Baseline window definition.** First 90 days post-activation, OR the team's peak month? Peak-month is more honest; first-90-days is simpler.
3. **Refresh cadence.** Nightly aligned with v1 recompute, or monthly (since trajectories don't change much day-to-day)?
4. **What's a "matched control" for §3 churners-vs-retainers?** Same tenure bucket? Same plan tier? Both?
5. **Should the risk pattern feed back into the v2 score** (e.g., `slow_fade` adds a -5 point penalty)? Instinct: **no** — let it be a categorical aside.
6. **Backfill historical signals** when adding a new action group, or only forward? Backfill is heavier but lets sales tune against older data.
