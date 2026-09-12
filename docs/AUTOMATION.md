# AUTOMATION.md

Status: **implemented (operator's "Phase 12")**. Code:
`packages/services/src/automation`, `apps/worker/src/processors/automation.ts`,
`apps/web/app/(app)/app/automations`, `apps/web/src/server/automation-actions.ts`.
Design decision: ADR-0027.

Scheduled, retrying, idempotent background automations. A member configures a
rule ("Analyze my YouTube channel every Monday"); a worker sweep runs it on
schedule under **that member's permissions**, and every execution is logged.

---

## 1. What you can automate

| Task type             | Runs                                                                              | Required permission   | Config                                         |
| --------------------- | --------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------- |
| `YOUTUBE_ANALYSIS`    | YouTube Analyst on the primary channel                                            | `agent:run`           | —                                              |
| `TIKTOK_ANALYSIS`     | TikTok Analyst on the primary account                                             | `agent:run`           | —                                              |
| `WEBSITE_CRAWL`       | `seo.startCrawl` on a verified website                                            | `crawl:run`           | `{ websiteId? }`                               |
| `SEO_ISSUE_ALERT`     | checks the latest crawl; opens a `Task` when a new critical/high issue is present | `crawl:run`           | `{ websiteId?, severity: 'critical'\|'high' }` |
| `MONETIZATION_SCAN`   | re-runs the monetization opportunity scan                                         | `monetization:manage` | —                                              |
| `GROWTH_REPORT`       | `reports.generateReportJob`                                                       | `report:generate`     | `{ reportType, websiteId? }`                   |
| `CONTENT_OPPORTUNITY` | one Growth Agent turn → opens a `Task` from the top recommendation                | `agent:run`           | —                                              |

**No task type performs an external publish** — `TASK_TYPE_META` carries
`externalPublish: false` for every entry and `assertNoExternalPublish()` is a
unit-tested invariant. TikTok / YouTube publishing stays behind its own explicit
approval flow.

---

## 2. Schedules

`cadence` = `DAILY` / `WEEKLY` / `MONTHLY` (with `hour`, `minute`, `weekday`,
`monthday` knobs) → a derived 5-field cron; or `CUSTOM` with a raw cron
expression.

`automation/cron.ts` is a ~150-line hand-rolled parser (no dependency):
`*`, `a`, `a-b`, `a,b`, `*/n`, `a-b/n`, day-of-week `0-6` (`7` = Sunday), and the
standard "if both day-of-month and day-of-week are restricted, either match
fires" rule. `nextRunAfter(expr, from)` scans minute-by-minute up to ~400 days,
then errors (a schedule that never fires is a config error).

**Schedules are evaluated in UTC.** `AutomationRule.timezone` is stored for a
future timezone-aware pass (documented limitation).

---

## 3. Execution model

1. The worker registers two **repeatable** jobs on the `automation` queue on
   start: `sweep` (every 60s) and `retry-sweep` (every 30s).
2. `runAutomationSweepJob` calls `dueAutomations(now)` — rules with
   `status ∈ {ACTIVE, FAILING}` whose `nextRunAt ≤ now`.
3. For each, `claimRun({ ruleId, scheduledFor })` creates an `AutomationRun`.
   `scheduledFor` is snapped to the rule's `nextRunAt`, and the row has
   `@@unique([automationRuleId, scheduledFor])` — a second sweep, a worker
   restart mid-tick, or a duplicated job all get "already claimed → skip"
   (**idempotency**).
4. `executeAutomationRun({ runId })`:
   - loads the rule; if it is `PAUSED` / `DISABLED` the run is `CANCELLED`.
   - **re-checks the owner's RBAC**: resolves `ownerId`'s current membership +
     role and `authorize()`s the task's `requiredAction`. Owner lost the role or
     left the org → run `SKIPPED`, rule `PAUSED`, audit
     `automation.run.skipped`.
   - marks the run `RUNNING`, dispatches via `dispatch.ts`, then on success
     writes `output`, marks `SUCCEEDED`, resets `failureCount`, lifts `FAILING`,
     and sets the rule's `nextRunAt` to the next cron match.
5. Manual **"Run now"** (`runAutomationNowJob`) claims a one-off run
   (`triggeredBy: 'manual'`, a distinct `scheduledFor`) and executes it inline.

Runs execute **inline in the sweep** (bounded — one analyst / crawl / report
call), per ADR-0013. A per-run `execute` job type exists for a future hand-off.

---

## 4. Retry, backoff, escalation

- A failed execution with `attempt < maxRetries` → `RETRY_SCHEDULED`,
  `nextAttemptAt = now + 60s · 2^(attempt-1)` capped at **1 hour**. The
  retry-sweep picks it up.
- After `maxRetries` the tick is `FAILED`; the rule's **consecutive**
  `failureCount` increments.
- `failureCount` reaches **5** → rule `FAILING` (still scheduled, surfaced in
  the UI). Reaches **10** → rule `DISABLED` (the sweep skips it until the user
  resumes it). Any success resets `failureCount` to 0.
- **Cancellation**: `cancelRun` marks a `PENDING` / `RETRY_SCHEDULED` /
  `RUNNING` run `CANCELLED`. Pausing a rule stops future ticks and clears
  `nextRunAt`; resuming reschedules from now and clears `failureCount`.

---

## 5. The row (what "every automation must contain")

`AutomationRule`: `id`, `organizationId`, **`ownerId`** (runs use their
permissions), `taskType`, `name`, `cadence` + `cronExpression`, `config`,
`status` (`ACTIVE` / `PAUSED` / `FAILING` / `DISABLED`), `lastRunAt` +
`lastRunStatus`, `nextRunAt`, `failureCount`, `totalRuns`, `maxRetries`,
`lastError`.

`AutomationRun` (the execution log): `scheduledFor`, `status`, `attempt`,
`triggeredBy`, `startedAt` / `finishedAt` / `durationMs`, `output` (compact
summary), `error`, `nextAttemptAt`.

---

## 6. RBAC

`automation:manage` (**MEMBER+**) gates create / update / pause / resume /
delete / run-now. The **owner's** permission for the task's `requiredAction` is
re-checked on every run (§3) — an automation can never do something its owner
currently cannot.

---

## 7. Documented limitations (do not fake)

- **UTC only.** No per-user timezone yet; `timezone` is stored, unused.
- **No notification channel.** `SEO_ISSUE_ALERT` opens a `Task`; there is no
  email/in-app notification system yet (roadmap "Phase 10").
- **Runs execute inline in the sweep.** A pathologically slow underlying job
  makes one sweep tick long; it is bounded by the single analyst / crawl /
  report call and the crawl's own page cap.
- **Primary subject is auto-picked** for `*_ANALYSIS` (highest-subscriber
  channel / highest-follower account) and for website tasks (a configured
  `websiteId`, else the first verified site).
