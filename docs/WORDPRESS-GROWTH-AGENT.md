# WORDPRESS-GROWTH-AGENT.md

Status: **implemented (operator's "Phase 9")**. Code:
`packages/services/src/wordpress/{capability-matrix,hash,diff,
content-refresh,seo-bridge}.ts`, `packages/services/src/seo/issue-resolution.ts`,
`packages/services/src/agent/wordpress-tools.ts`,
`apps/web/app/(app)/app/wordpress/{page,content/page,seo/page}.tsx`,
`apps/web/src/server/wordpress-actions.ts`.

This phase extends the existing WordPress connector (Application Password
auth over core `wp/v2`, AES-256-GCM-sealed credential, SSRF-safe pinned
HTTP, capability detection, post/page mirror, draft creation, and
approval-gated update/publish via the generic Phase 1 approval queue — all
documented in `docs/WORDPRESS-INTEGRATION.md`) with: a named capability
matrix, a content-refresh engine, a real SEO→WordPress execution bridge,
an SEO-issue verification/resolution mechanism, a dedicated WordPress
agent-tool surface wired through the Phase 5 Tool Executor, and a
`wordpress-growth` orchestrator capability — mirroring the YouTube/TikTok
content-strategy-layer pattern (Phases 6-7) where it fits, and diverging
where WordPress's own shape genuinely differs.

No new write/publish infrastructure was built. WordPress already had a
real, approval-gated write/publish path via the generic
`approvals/index.ts` (`wordpress.create_draft` / `wordpress.update_post` /
`wordpress.publish`) — **more mature than YouTube or TikTok were before
their own extension phases**. This phase's job was narrower and more
surgical: connect that existing write path to SEO findings, add
verification, and expose it through the agent tool surface.

---

## 1. Audit findings

Before writing code, the existing WordPress surface was read in full
(`connect.ts`, `actions.ts`, `read.ts`, `sync.ts`, `client.ts`,
`integrations/contract.ts`'s `WORDPRESS` block, `approvals/index.ts`).
Findings:

- Real OAuth-equivalent auth (Application Password), real SSRF-safe HTTP,
  real capability detection from the connected WordPress user's own
  granted capabilities (never assumed from a role name), real content
  sync, and a **real approval-gated write/publish flow already wired into
  the generic `IntegrationActionRequest` queue** — unlike TikTok's bespoke
  separate publish state machine (ADR-0017), WordPress reuses the same
  queue every other write-capable integration uses.
- The brief's claimed prerequisite **"Phase 8 — SEO Growth Agent" does not
  exist as such**. What exists under "SEO" is the earlier **AI SEO
  Agent** (crawler + ~38-rule auditor + recommendation engine + 9
  read-only agent tools + Search Console correlation) — a different,
  earlier system with no opportunities/experiments/calendar
  content-strategy layer of its own. This phase treats the AI SEO Agent's
  `CrawlIssue` rows as the real SEO evidence to bridge into WordPress,
  rather than assuming a nonexistent system.
- No content-refresh detection, no SEO↔WordPress bridge, no dedicated
  WordPress agent-tool surface, and no `wordpress-growth` orchestrator
  capability existed. These became this phase's real targets.

---

## 2. The capability matrix

`getWordPressCapabilityMatrix(organizationId)` (`capability-matrix.ts`)
reports **18** named capabilities every time, each with a `level`
(READ_ONLY / WRITE / PUBLISH / DELETE) and an availability
(AVAILABLE / REQUIRES_PERMISSION / NOT_AVAILABLE):

| Capability             | Level     | Availability                                                                          |
| ----------------------- | --------- | -------------------------------------------------------------------------------------- |
| `SITE_READ`             | READ_ONLY | From the Connection Center (`wordpress.get_site`)                                      |
| `POST_READ`/`PAGE_READ` | READ_ONLY | From the Connection Center                                                              |
| `POST_CREATE`/`PAGE_CREATE` | WRITE | AVAILABLE once `edit_posts`/`edit_pages` is granted (drafts are safe, run directly)     |
| `POST_UPDATE`/`PAGE_UPDATE` | WRITE | `REQUIRES_PERMISSION` once the scope is granted — approval is **always** required (hard rule 4), never promoted straight to AVAILABLE |
| `POST_PUBLISH`/`PAGE_PUBLISH` | PUBLISH | `REQUIRES_PERMISSION` once `publish_posts`/`publish_pages` is granted |
| `POST_DELETE`/`PAGE_DELETE` | DELETE | **Always `NOT_AVAILABLE`** — this deployment's client has no delete implementation (a real product absence, not a permission gap) |
| `MEDIA_READ`/`MEDIA_UPLOAD` | READ_ONLY/WRITE | **Always `NOT_AVAILABLE`** — no media endpoint implemented |
| `CATEGORY_READ`/`TAG_READ` | READ_ONLY | **Always `NOT_AVAILABLE`** — no taxonomy endpoint implemented |
| `COMMENT_READ`          | READ_ONLY | **Always `NOT_AVAILABLE`** — no comment endpoint implemented |
| `SEO_METADATA_READ`/`SEO_METADATA_UPDATE` | READ_ONLY/WRITE | **Always `NOT_AVAILABLE`** — this deployment assumes no particular SEO plugin and never writes to arbitrary WordPress tables (§23) |

Two documented, honest reason strings (`NO_API_REASON`, `NO_PLUGIN_REASON`)
distinguish "no WordPress-side scope granted" from "this deployment's
client code has no implementation for this operation at all" — mirroring
the YouTube/TikTok capability-matrix precedent (never conflate a
permission gap with a genuine product/API absence). Unlike
`tiktok.publish`'s baseline (`REQUIRES_PROVIDER_APPROVAL`, which never
promotes to `AVAILABLE` even with the scope granted — Phase 7's
documented gotcha), WordPress's `wordpress.publish` contract descriptor
uses a plain `AVAILABLE` baseline, so no analogous workaround was needed
here; `approvalGatedAvailability()` handles the "approval is always
required regardless" rule explicitly instead. 6 tests.

---

## 3. Content diffing — a real performance bug caught before it shipped

`diff.ts` is a hand-rolled, dependency-free word-level LCS diff for the
content-editor "Original → Proposed → Highlighted changes" view (§18). The
first version capped both inputs at 20,000 tokens before running an O(n·m)
table; a test feeding two identical 50,000-word-tokenized strings (capped
to 20,000×20,000 = 400 million cells) took **82.8 seconds** — a genuine
algorithmic-complexity bug caught by this phase's own test before it could
ship. Fixed with a three-tier fallback: word-level LCS below 1,500 tokens
per side; otherwise paragraph-level LCS (also capped at 1,500); otherwise
(both tiers exceeded) a trivial single delete+insert pair. 12 tests,
including three boundary tests for each tier — this is a reusable pattern
for any future hand-rolled diff/comparison utility in this codebase.

`hash.ts`'s `contentHash({title, excerpt, content})` is a plain SHA-256
used for two purposes: dedupe (mirroring TikTok's `contentHash`
convention) and the version-safety concurrent-edit guard below.

---

## 4. Version safety — a concurrent-edit guard on WordPress updates

`wordpress/actions.ts`'s `UpdatePostPayload` gained an optional
`expectedContentHash`. When present, `executeUpdatePost` re-fetches the
live post immediately before writing and refuses (`AppError.conflict`)
if its current `contentHash` no longer matches — the content changed on
WordPress since the fix was proposed. This satisfies §30's "record
original/proposed content hash… if an update fails, do not mark the
action successful" without a new schema: the hash travels inside the
existing `IntegrationActionRequest.payload` JSON, computed once at
proposal time (`seo-bridge.ts`) and re-checked once at execution time.

---

## 5. Content-refresh engine

`findRefreshCandidates(organizationId, {siteId, limit})`
(`content-refresh.ts`) — deterministic, evidence-based, never a fabricated
traffic or ranking signal (hard rule 1). Joins synced `WordPressContent`
with the org's matching `Website` (by registrable hostname) → its latest
completed `Crawl` → that crawl's `CrawlPage`s (word count) and
`CrawlIssue`s (counts by severity), matched by normalized URL. A
documented, fixed three-factor weighted score (`age 0.25 · issues 0.45 ·
thinContent 0.30`, sum to 1 — a model never chooses these): age saturates
at 365 days, thin content is `<300` words, short is `<600`. Every
candidate carries a plain-English `evidence: string[]` built only from
real fields, and a `confidence` (`HIGH`/`MEDIUM`/`LOW`) that is honest
about whether a crawl match was actually found — content with no matching
website/crawl is still scored on age alone, disclosed via `confidence:
LOW`, never silently dropped or guessed. 5 tests (using a hand-rolled
mock db — see §11 on test-infrastructure limits).

---

## 6. SEO→WordPress execution bridge — "a critical architectural requirement"

`seo-bridge.ts` is how "WordPress becomes an execution layer for the AI
SEO Agent's findings" (§22) without building a second SEO engine. Given
one `CrawlIssue` id, `proposeContentFixForIssue` matches it to a synced
`WordPressContent` row by normalized URL, derives a proposed fix, and
files it through the **existing** approval queue
(`approvals.requestIntegrationAction`, capability `wordpress.update_post`)
— it never writes to WordPress itself.

Only two issue-code families are actionable, because only
`title`/`excerpt`/`content`/`slug` are writable at all:

- `MISSING_TITLE` / `TITLE_LENGTH` → propose a `title` change.
- `MISSING_META_DESCRIPTION` / `META_DESCRIPTION_LENGTH` → propose an
  `excerpt` change (many WordPress themes/setups fall back to the excerpt
  as the meta description when no SEO plugin overrides it — disclosed as
  an approximation in the proposal's own `rationale`, never claimed as a
  guaranteed fix).

`buildFixProposal` is **pure and never fabricates**: it only
truncates/reuses text already present on the post (title, excerpt, or a
plain-text extract of the body), and returns `null` — refusing to
propose anything — when there is no existing source text to derive from,
or when the derived value would be a no-op. A dedicated test asserts the
proposed text is always a substring/derivation of the real source text,
never new content. Every other issue code is refused with an honest
explanation naming the real limitation, not a generic "not supported."
8 tests for `buildFixProposal`; the full `proposeContentFixForIssue` I/O
path is exercised indirectly through the agent-tool and server-action
layers (see §11).

`listActionableSeoIssuesForSite` (added while building the `/app/wordpress
/seo` UI) is the read side: open `CrawlIssue` rows on the website matching
a WordPress site's hostname, restricted to the same two actionable code
families, each flagged with whether a synced WordPress post/page actually
matches its URL — so the UI never offers a "Propose fix" button for an
issue that cannot be matched.

---

## 7. SEO issue verification — closing the loop

`seo/issue-resolution.ts`'s `verifyAndResolveIssue({organizationId,
issueId, actorId})` re-fetches the live page (`seo/fetch.ts`), re-extracts
it (`seo/html.ts`), and re-checks whether the issue's condition still
holds, via a closed map of 8 verifiable codes
(`MISSING_META_DESCRIPTION`, `META_DESCRIPTION_LENGTH`, `MISSING_TITLE`,
`TITLE_LENGTH`, `MISSING_IMAGE_ALT`, `NO_VIEWPORT_META`, `HEADING_ORDER`,
`NO_SEMANTIC_LANDMARKS`) — each a pure boolean check over one already
-extracted page, verifiable from a single fetch. Any other code (most
multi-page-context issues like `ORPHAN_PAGE`, `REDIRECT_CHAIN`) is
answered honestly: "this needs a full site re-crawl to verify," never
guessed. On a supported code: no longer reproducing → `CrawlIssue.status
= 'FIXED'` (audit `seo.issue.resolved`); still reproducing and the prior
status was `FIXED` → `'REGRESSED'` (audit `seo.issue.regressed`);
otherwise untouched.

`tryVerifyAndResolveIssue` is a best-effort, non-throwing wrapper, wired
directly inside `approvals/index.ts`'s `decideActionRequest` — after a
WordPress update executes successfully and its request carries a
`sourceCrawlIssueId` (a new field added to `IntegrationActionRequest`,
populated by `proposeContentFixForIssue`), the issue is automatically
re-checked. This is a **deliberate scope simplification**: synchronous
inline verification right after execution satisfies §22's example flow
("update WordPress → crawl page → verify change → mark SEO issue
resolved") without adding a new worker queue, unlike the brief's §37
suggestion of a separate `wordpress.action.verify` background job. 7 tests.

---

## 8. Agent tools — the tool-platform integration target

`agent/wordpress-tools.ts` — **9** tools, dispatched through the existing
`executeAgentTool` (Phase 5), mirroring `youtube-tools.ts`/
`tiktok-tools.ts`'s exact shape:

| Tool                                   | Kind    | Approval?                       |
| --------------------------------------- | ------- | -------------------------------- |
| `wordpress.site.get`                    | READ    | none                              |
| `wordpress.post.list` / `page.list`     | READ    | none                              |
| `wordpress.content.draft`               | CREATE  | none — a draft is safe and reversible |
| `wordpress.content.update.propose`      | ACTION  | **files a pending approval only** |
| `wordpress.content.publish.propose`     | ACTION  | **files a pending approval only** |
| `wordpress.content.refresh.analyze`     | ANALYZE | none (read-only analysis)         |
| `wordpress.seo.issue.fix.propose`       | ACTION  | **files a pending approval only** |
| `wordpress.content.verify`              | ANALYZE | none (read-only re-check)         |

Every WRITE/PUBLISH-shaped tool **only ever calls
`requestIntegrationAction`** — never `executeUpdatePost`/
`executePublishPost` directly. The AI can propose; only a human approval
executes anything on WordPress (hard rule 4, §19 "never silently
publish"). `tool-executor.ts` gained a `'wordpress'` kind alongside
`'youtube'`/`'tiktok'`; the rate limiting, `TOOL_CALLS` usage metering,
and `AgentRunEvent` timeline are the existing, unmodified logic applied
uniformly. `tool-registry.ts`'s static catalogue gained the 9 tools'
metadata (5 `LOW` risk read/analysis + the draft tool; 3 `MEDIUM` risk
`ACTION` tools with `requiresApproval: true`).

**Deliberately not built as separate tools** (mirroring §5/§20's "only
register what actually exists"): `wordpress.media.*` /
`wordpress.category.*` / `wordpress.tag.*` / `wordpress.comment.*` — no
underlying capability exists (§2); `wordpress.seo.metadata.get` /
`.propose` — this deployment does not assume any SEO plugin and does not
write to arbitrary database tables; `wordpress.seo.issue.fix.propose` is
the real, bounded equivalent.

---

## 9. Orchestrator wiring

A new `wordpress-growth` capability (`agent/capabilities.ts`) dispatches
through `executeAgentTool` exactly like `youtube-growth`/`tiktok-growth` —
it calls `wordpress.content.refresh.analyze` and turns the ranked
candidates into evidence + recommendations for the AI Copilot, degrading
to `needs_prerequisite` when WordPress is not connected or the tool call
fails. `OrgContext` (`agent/context.ts`) gained a `wordpress: {connected,
siteUrl, lastSyncedAt}` field, populated from `WordPressSite` +
`IntegrationSyncRun`, surfaced in both `org-context`'s evidence and the
model-planning prompt's `CONNECTED:` summary. The deterministic keyword
router (`planner.ts`) gained a matching pattern set (wordpress / wp post
or page / blog post / refresh my content / stale content / thin content)
routing to `wordpress-growth`, plus a fallback-routing entry when nothing
else matched but WordPress is connected.

---

## 10. Reports and automation

`reports/facts.ts`'s `gatherGrowth` (the cross-surface `GROWTH` report
type) gained WordPress as a fourth connected surface (`"N of 4"`,
previously `"N of 3"`) and, when connected, a "WordPress pages worth
refreshing" metric + opportunity derived from `findRefreshCandidates` —
additive, no new report type. `automation/dispatch.ts` gained a
`WORDPRESS_CONTENT_REFRESH` task type (new `AutomationTaskType` enum
value): resolves the org's WordPress site, runs `findRefreshCandidates`,
and opens a `Task` (domain `WORDPRESS`) when a genuine top candidate
exists, with priority derived from the same score thresholds the
orchestrator capability uses.

---

## 11. Database

One additive migration, `20260927120000_wordpress_growth_agent` — the
smallest of any content-strategy-layer phase (0 new tables, vs. 3 each for
YouTube/TikTok), because the write/publish infrastructure this phase
needed already existed:

- `RecommendationDomain` gains `WORDPRESS`.
- `AutomationTaskType` gains `WORDPRESS_CONTENT_REFRESH`.
- `IntegrationActionRequest` gains a nullable `sourceCrawlIssueId` (FK to
  `CrawlIssue`, `onDelete: SetNull`) — the cross-reference that lets a
  post-execution hook find and verify the originating SEO issue.

Per the brief's §7 "at minimum" model list, several named models were
deliberately **not** created (hard rule 9):

- `WordPressSyncRun` / `WordPressApiEvent` — the existing generic
  `IntegrationSyncRun` (shared across all providers, ADR unchanged) and
  `IntegrationHealth` already cover this; a WordPress-specific duplicate
  would fragment observability rather than add anything.
- `WordPressCategory` / `WordPressTag` — no taxonomy endpoint is
  implemented (§2); a table with no real data source would be schema
  noise or an invitation to fabricate.
- A separate `WordPressAction` audit table — the existing `AuditLog` +
  `IntegrationActionRequest` lifecycle already record every write action's
  actor, capability, payload, approval, and result.

---

## 12. UI

New `/app/wordpress` workspace (Overview / Content / SEO), reusing the
Phase 3 design system exactly — no new visual language. Deliberately
**not** built this phase, disclosed rather than silently dropped: separate
Pages/Drafts/Calendar/Media/Activity/Settings sub-sections (the brief's
full 10-section list). Approvals are **not** duplicated — the existing
`/app/integrations/approvals` page (Phase 1) already lists every pending
WordPress request, per the brief's own §46 instruction to reuse rather
than rebuild.

- **Overview** — site status + the full 18-capability matrix.
- **Content** — ranked refresh candidates with their real evidence
  strings, confidence, and score.
- **SEO** — open, actionable SEO issues matched to synced WordPress
  content, with a "Propose fix" button
  (`apps/web/src/server/wordpress-actions.ts`'s
  `proposeWordPressSeoFixAction`) that only ever files a pending approval.

The existing `/app/integrations/wordpress` page (connect/sync/disconnect,
the posts/pages table, draft creation, per-item change requests) is
unchanged and remains where connection management lives; the main
sidebar's "WordPress" entry now points at the new `/app/wordpress`
workspace instead.

---

## 13. What was actually tested vs. not

Every new pure function (`buildFixProposal`, `diffText`,
`getWordPressCapabilityMatrix`'s resolution logic, `findRefreshCandidates`'s
scoring, `verifyAndResolveIssue`'s code-mapping) was unit-tested against
hand-built fixtures. The tool dispatcher's capability-gating was tested
against the real `assertCapabilityUsable` using an in-memory database. Two
disclosed, pre-existing test-infrastructure gaps constrained depth rather
than being fixed here (out of this phase's scope): the shared
`memory-db.ts` harness has no `crawl`/`crawlPage`/`crawlIssue` models
(`content-refresh.test.ts` uses a hand-rolled mock db instead), and the
`fake-wordpress.ts` harness's `FakePost` fixture has no `content` field
(`seo-bridge.test.ts` tests only the pure `buildFixProposal` function, not
the full `proposeContentFixForIssue` I/O path against a live fake
server). No live WordPress site or SEO crawl was exercised against real
external data in this sandbox — no such credentials exist here, the same
disclosed limitation as every WordPress-touching phase since the original
integration.
