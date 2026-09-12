# MONETIZATION.md

Status: **implemented (operator's "Phase 9")**. Code:
`packages/services/src/monetization`, `apps/web/app/(app)/app/monetization`,
`apps/web/src/server/monetization-actions.ts`.

Turns connected creator data (YouTube, TikTok, SEO) plus a user-provided
business profile into a **ranked, explainable list of monetization channels**,
and tracks user-entered revenue over time. Every difficulty / potential /
audience-fit value is a **labelled estimate**, never a currency figure. The
engine **never invents revenue** and **never claims** a creator qualifies for a
platform monetization program.

---

## 1. Inputs (signals)

`gatherMonetizationSignals(orgId)` builds a deterministic snapshot — nothing is
inferred from a third party without the user's input:

| Group      | Fields                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `youtube`  | connected, channel title, subscribers, video/view count, `hasAnalytics`, and the careful `assessMonetization` result (`estimate.metThresholds / unmetThresholds / unverified`)                                                                            |
| `tiktok`   | connected, display name, follower count, `hasStats`                                                                                                                                                                                                       |
| `seo`      | website count, verified count, whether a crawl has completed                                                                                                                                                                                              |
| `business` | the user's `BusinessProfile`: niche, audience description, offerings, goals, email-list size, and activity flags (`hasWebsite`, `sellsProducts`, `doesSponsorships`, `doesAffiliates`, `doesConsulting`, `hasMembership`, `hasCourse`) + YPP attestations |
| `revenue`  | entry count, channels with revenue, last-12-months total by currency (read-only — a signal, never written here)                                                                                                                                           |
| —          | `largestAudience` — the biggest connected audience, used for the estimate bands                                                                                                                                                                           |

Audience bands: `nascent (<1k) · small (<10k) · mid (<100k) · large (<1M) ·
major (≥1M) · unknown` (no connected audience).

---

## 2. The opportunity engine (deterministic)

`buildOpportunities(signals)` emits one `OpportunityDraft` per applicable
channel. **11 channels:** `PLATFORM_MONETIZATION`, `SPONSORSHIP`, `AFFILIATE`,
`DIGITAL_PRODUCT`, `SERVICE`, `MEMBERSHIP`, `SUBSCRIPTION`, `LEAD_GENERATION`,
`CONSULTING`, `COURSE`, `BRAND_PARTNERSHIP`.

Each draft carries the **seven required fields** (master instruction, "OPPORTUNITY
ENGINE") plus a priority score:

| Field                    | How it is produced                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Opportunity**          | `title` + `description` from the channel's `ChannelSpec`                                                          |
| **Evidence**             | `{ statement, kind }[]`, `kind ∈ fact · calculated_metric · assumption` — audience facts + channel-specific notes |
| **Audience fit**         | `strong · moderate · weak · unknown`, from the audience band and whether a niche is stated                        |
| **Estimated difficulty** | `low · medium · high`, the channel baseline minus one level if it is already active                               |
| **Estimated potential**  | label `Low · Moderate · High` — `min(channel ceiling, 0.5·band + 0.5·fit)` mapped to a label. **Never a number.** |
| **Required action**      | an ordered `requiredActions[]` from the `ChannelSpec`                                                             |
| **Confidence**           | `0..1`, higher when the channel is active, evidence is non-assumption, and audience fit is strong                 |

`potentialBasis` is always attached and states: _"Estimate only. Formed from your
audience band (…) and audience fit (…) … It is a relative label, not a revenue
figure."_ `isEstimate` defaults `true`.

### Priority score

```
priorityScore = round(100 × (
  0.28 · audienceFit
+ 0.22 · potential
+ 0.20 · ease            (1 − (difficultyLevel−1)/2)
+ 0.15 · confidence
+ 0.08 · already-active
+ 0.07 · matches-a-stated-goal))
```

It ranks _which opportunity to pursue first_ — it is **not** an income estimate
(`PRIORITY_MODEL_NOTE`). Drafts are returned sorted by descending score.

### PLATFORM_MONETIZATION — the qualification rule

The master instruction: _"Do not claim that a creator qualifies for a platform
monetization program unless the necessary official criteria/data are available."_

This is enforced structurally:

- `applicable` only when YouTube is connected.
- `active` / `readiness` derive **entirely** from `assessMonetization`'s
  `estimate.unmetThresholds` and `unverified` — "current" only when both are
  empty, i.e. every criterion we can actually check is met.
- The description is hard-coded to defer the decision: _"This does not confirm
  you qualify — apply in YouTube Studio and YouTube will make the decision."_
- Evidence always includes: _"Eligibility for the YouTube Partner Program is
  decided by YouTube, not this tool. The API never exposes the review decision."_
- Actions point at YouTube Studio → Earn and name each open / unverifiable item.

---

## 3. The model layer (prose only, grounded)

`runMonetizationScan` optionally runs one `generateObject` pass
(`MonetizationAnalysis`: `overview` + per-channel `description` / `requiredActions`

- `disclaimers`). It **cannot** choose channels or produce numbers. Output is
  flattened and checked with `checkGroundingFields` against a fact sheet built from
  the signals (`s1..sN`); one repair attempt, then on any grounding issue the model
  output is **dropped** and the deterministic `overview` + spec text stand. With no
  AI provider the scan is fully deterministic.

The analyst is persisted as an `AgentRun` (`agent: "monetization-analyst"`,
tokens, cost) and every scan writes a `monetization.scan.completed` audit row.

---

## 4. Persistence + lifecycle

`MonetizationOpportunity` is **deduped on `(organizationId, channel)`**. A
re-scan refreshes evidence + estimates but keeps a status the user has advanced.

`OpportunityStatus`: `SUGGESTED → IN_PROGRESS / ACTIVE → COMPLETED`, or
`DISMISSED` (with a reason).

| Transition       | Function                   | Notes                                                                                                                                          |
| ---------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| any → any        | `updateOpportunityStatus`  | records `dismissedReason` / `completedNote`; audits `monetization.opportunity.status_changed`                                                  |
| → `Task`         | `promoteOpportunityToTask` | reuses the Phase 7 task system; SUGGESTED → IN_PROGRESS; the task never targets an external system; audits `monetization.opportunity.promoted` |
| upsert from scan | `runMonetizationScan`      | new drafts land `ACTIVE` (readiness "current") or `SUGGESTED`                                                                                  |

---

## 5. Monetization dashboard

`getMonetizationDashboard(orgId)` returns, for `/app/monetization`:

- **Current opportunities** — status `ACTIVE` or `IN_PROGRESS`.
- **Potential opportunities** — status `SUGGESTED`.
- **Recommended actions** — the first required action of the top ≤6
  suggested / in-progress opportunities.
- **Completed opportunities** (and dismissed, shown separately).
- **Revenue tracking** — see below.
- `profileComplete`, `lastScanAt`, `lastScanOverview`.

The page opens with an explainer banner: estimates are relative labels not dollar
amounts; platform-monetization readiness is not a qualification claim; revenue is
user-entered only.

---

## 6. Revenue tracking — user-entered only

The master instruction: _"Do not invent revenue. Allow users to manually enter
revenue sources. Create historical tracking."_

- `RevenueEntry.createdById` is **required** (no default). The engine only ever
  _reads_ revenue as a signal — nothing in `packages/services/src/monetization`
  writes a `RevenueEntry` except the explicit user actions.
- `addRevenueEntry` / `updateRevenueEntry` validate: amount ≥ 0 and ≤ 1e9,
  valid dates, `periodEnd ≥ periodStart`, 3-letter ISO currency.
- **Delete is soft** (`deletedAt`) so history survives a correction.
- `getRevenueSummary` derives, from the user's rows only: totals by currency,
  by channel, and **`byMonth[]` keyed `YYYY-MM`** (the historical series), plus
  an approximate recurring monthly figure (recurring entries spread across the
  months they cover).
- Audit: `monetization.revenue.{added,updated,deleted}`.

---

## 7. RBAC

New action `monetization:manage` — **MEMBER and above** (VIEWER cannot).
All seven Server Actions in `monetization-actions.ts` call
`requirePermission('monetization:manage')`.

---

## 8. Documented limitations (do not fake)

- **No platform-qualification claim, ever.** The tool reports which criteria it
  can and cannot verify; YouTube (or any platform) makes the eligibility
  decision when the user applies. `assessMonetization` is deliberately
  conservative and several YPP criteria are not API-visible at all.
- **No revenue is pulled from platform APIs.** AdSense / TikTok earnings
  integration is out of scope for this phase; all revenue is user-entered.
- **Potential is a label, not a projection.** There is no dollar-value estimate
  anywhere — that would be a fabricated projection.
- **The scan runs inline** in the Server Action (bounded: a few reads + one
  optional model call). `runMonetizationScanJob` is wired for a future
  scheduled re-scan but no worker queue was added (ADR-0013 pattern).
