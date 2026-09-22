# PHASE 9 COMPLETE — WordPress Growth Agent

Full detail is in `docs/WORDPRESS-GROWTH-AGENT.md` and ADR-0058
(`docs/DECISIONS.md`). This report follows the brief's own §53 template.

## Status by area

| Area                   | Status  | Notes                                                                                                                                                                     |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WordPress connection    | PASS    | Already existed (pre-Phase-9); unchanged this phase. Application Password auth, SSRF-safe pinned HTTP, standardized `ConnectionState`s via the Connection Center.        |
| Authentication          | PASS    | Already existed; unchanged. AES-256-GCM-sealed credential, never sent to the browser, never logged.                                                                       |
| Capability detection    | PASS    | New: 18-capability named matrix (`capability-matrix.ts`), distinguishing "no scope granted" from "no implementation exists."                                              |
| Content sync            | PASS    | Already existed; unchanged. Incremental, paginated, retried.                                                                                                              |
| Content intelligence    | PASS    | New: content-refresh engine (age/issues/thin-content, real signals only, no fabricated traffic/ranking data).                                                            |
| Draft generation        | PASS    | Already existed (`createDraft`); a new `wordpress.content.draft` agent tool wraps it (DRAFT-level, runs directly, no approval needed).                                    |
| Editor                  | PARTIAL | A hand-rolled diff engine (`diff.ts`) is built and unit-tested (12 tests, including the performance-boundary fix); no dedicated visual content-editor UI page was built this phase (see Known issues). |
| Approval system         | PASS    | Reused entirely — no new approval infrastructure. Every new WRITE/PUBLISH-shaped surface only files a pending `IntegrationActionRequest`.                                 |
| WordPress updates       | PASS    | Already existed (`executeUpdatePost`); this phase adds a version-safety concurrent-edit guard (`expectedContentHash`).                                                    |
| Publishing              | PASS    | Already existed (`executePublishPost`); a new `wordpress.content.publish.propose` agent tool only ever files an approval, never publishes directly.                       |
| Verification            | PASS    | New: `seo/issue-resolution.ts` re-fetches the live page and re-checks 8 verifiable issue codes; wired as a post-execution hook.                                            |
| Rollback                | PARTIAL | Not built this phase — no rollback mechanism exists for a WordPress content change beyond WordPress's own revision history. Disclosed as a real gap (see Known issues).   |
| SEO integration         | PASS    | New: `seo-bridge.ts` — the real SEO→WordPress execution bridge, filed through the existing approval queue.                                                                |
| Background jobs         | PARTIAL | No new worker queue was added — verification runs synchronously inline instead (a deliberate scope simplification, ADR-0058). The brief's suggested `wordpress.action.verify`/`wordpress.publish.verify` job names were not built as separate jobs. |
| Security                | PASS    | RBAC + capability + tenant scoping re-checked at every new call site; rate-limited server actions; no new secret exposure; untrusted WordPress content already fenced (Phase 22/25). |
| Testing                 | PASS    | 38 new unit tests across 6 new test files, all passing; full monorepo gates green (lint/typecheck/634+ services tests).                                                   |
| Documentation           | PASS    | `docs/WORDPRESS-GROWTH-AGENT.md` (new), `docs/WORDPRESS-INTEGRATION.md` (§7 pointer added), `CLAUDE.md` updated, ADR-0058.                                                 |

## Files changed

New:
- `packages/services/src/wordpress/{capability-matrix,capability-matrix.test,hash,diff,diff.test,content-refresh,content-refresh.test,seo-bridge,seo-bridge.test}.ts`
- `packages/services/src/seo/{issue-resolution,issue-resolution.test}.ts`
- `packages/services/src/agent/wordpress-tools.ts`
- `packages/db/prisma/migrations/20260927120000_wordpress_growth_agent/migration.sql`
- `apps/web/app/(app)/app/wordpress/{layout,page,content/page,seo/page}.tsx`
- `apps/web/src/components/app/wordpress/{wordpress-tabs,wordpress-empty,propose-fix-button}.tsx`
- `apps/web/src/lib/wordpress-state.ts`
- `apps/web/src/server/wordpress-actions.ts`
- `docs/WORDPRESS-GROWTH-AGENT.md`, `docs/PHASE-9-REPORT.md`

Modified:
- `packages/db/prisma/schema.prisma` (2 enum additions, 1 nullable FK column)
- `packages/services/src/wordpress/{actions,index}.ts` (version-safety guard, new barrel exports)
- `packages/services/src/seo/index.ts` (barrel export)
- `packages/services/src/approvals/index.ts` (`sourceCrawlIssueId` field + post-execution verification hook)
- `packages/services/src/agent/{capabilities,context,index,planner,schemas,tool-executor,tool-registry}.ts` (`wordpress-growth` capability, `OrgContext.wordpress`, tool wiring)
- `packages/services/src/agent/{capabilities.test,planner.test,tool-registry.test}.ts`, `packages/services/src/agent/orchestrator.test.ts`, `packages/services/src/agents/ai-red-team.test.ts` (new fixture fields)
- `packages/services/src/automation/{dispatch,schemas}.ts` (`WORDPRESS_CONTENT_REFRESH` task type)
- `packages/services/src/reports/facts.ts` (`gatherGrowth` WordPress surface)
- `apps/web/src/components/app/nav.tsx` (WordPress nav target)
- `docs/WORDPRESS-INTEGRATION.md`, `CLAUDE.md`, `docs/DECISIONS.md` (ADR-0058)

## Database changes

One additive migration, `20260927120000_wordpress_growth_agent`:
- `RecommendationDomain` gains `WORDPRESS`.
- `AutomationTaskType` gains `WORDPRESS_CONTENT_REFRESH`.
- `IntegrationActionRequest` gains nullable `sourceCrawlIssueId` (FK → `CrawlIssue`, `onDelete: SetNull`) + an index.

No new tables. Verified statement-for-statement equivalent to
`prisma migrate diff`'s own generated SQL; `prisma validate` clean.

## API integrations

None new. This phase builds entirely on the existing WordPress REST API
client (`wordpress/client.ts`) and the existing AI SEO Agent's crawl data
— no new external API surface.

## New tools (agent)

9 tools in `agent/wordpress-tools.ts`: `wordpress.site.get`,
`wordpress.post.list`, `wordpress.page.list`, `wordpress.content.draft`,
`wordpress.content.update.propose`, `wordpress.content.publish.propose`,
`wordpress.content.refresh.analyze`, `wordpress.seo.issue.fix.propose`,
`wordpress.content.verify`.

## New worker jobs

None. Verification runs inline inside the existing approval-execution
path rather than a new BullMQ job (ADR-0058, Decision 4) — a disclosed,
deliberate scope simplification, not an oversight.

## Environment variables

None new. This phase adds no configuration surface.

## Security changes

- Every new WRITE/PUBLISH-shaped surface (agent tools, the SEO-fix server
  action) re-derives RBAC/tenant scope at call time via the existing
  `assertCapabilityUsable`/`requirePermission` — no new trust assumption.
- A new rate limit (`wp-seo-fix:{org}:{user}`, 20/hour) on the SEO-fix
  proposal server action, matching the existing WordPress action
  rate-limit convention.
- The version-safety `expectedContentHash` guard prevents a stale proposal
  from silently overwriting a concurrent edit.
- No new secret-handling surface; the existing AES-256-GCM credential seal
  and pino redaction are untouched.

## WordPress limitations (disclosed, not fabricated)

- Only `title`/`excerpt`/`content`/`slug` are writable on a post/page —
  media, categories, tags, comments, and custom post types have no
  implementation in this deployment's client at all (capability matrix
  reports these `NOT_AVAILABLE` with an explicit reason, never silently).
- No SEO-plugin metadata (Yoast, Rank Math, etc.) is read or written; this
  deployment assumes no particular plugin and never writes to arbitrary
  WordPress database tables. The excerpt-as-meta-description approximation
  in the SEO bridge is explicitly disclosed as an approximation in every
  proposal's rationale text, never claimed as a guaranteed fix.
- Only 2 of the many possible SEO issue codes are actionable through a
  WordPress update (title, meta description); every other code is refused
  with a specific, honest explanation.
- Only 8 issue codes are re-verifiable from a single page fetch;
  multi-page-context issues (orphan pages, redirect chains, etc.) report
  "needs a full site re-crawl to verify" rather than guessing.

## SEO-plugin compatibility

Not assessed or assumed. No plugin-specific detection was built (per the
brief's own instruction not to assume a particular plugin); the SEO
bridge operates entirely on core WordPress fields.

## Production deployment requirements

None beyond what `docs/WORDPRESS-INTEGRATION.md` already documents (a
site with Application Passwords enabled, `ENCRYPTION_KEY` set). No new
environment variable, service, or infrastructure dependency.

## Known issues

- **No dedicated content-editor UI page.** The diff engine exists and is
  tested, but no `/app/wordpress` page renders an Original/Proposed/
  Highlighted view yet — approvals are reviewed via the existing
  `/app/integrations/approvals` page's generic payload display, not a
  purpose-built diff UI.
- **No rollback mechanism.** A published/updated WordPress change has no
  in-app rollback beyond WordPress's own native revision history — the
  brief's §31 rollback requirement is not implemented.
- **No background verification job.** Verification only runs
  synchronously right after an approval executes; there is no scheduled
  re-verification of previously-fixed issues independent of a new write
  (ADR-0058, Decision 4).
- **UI scope is Overview/Content/SEO only** — Pages, Drafts, Calendar,
  Media, and Activity sub-sections from the brief's full 10-section list
  were not built this phase.
- **Test-infrastructure gaps** (pre-existing, not introduced this phase):
  the shared `memory-db.ts` harness lacks `crawl`/`crawlPage`/`crawlIssue`
  models; the `fake-wordpress.ts` `FakePost` fixture lacks a `content`
  field. Both constrained test depth for `content-refresh.ts` and
  `seo-bridge.ts`'s full I/O path.
- **No live verification.** No live WordPress site or SEO crawl was
  exercised against real external data in this sandbox — no such
  credentials exist here.

## Recommended Phase 10

Per the brief's explicit stop condition, no next phase is started
automatically. If continued, the highest-value next steps disclosed above
are: a dedicated content-editor diff UI, a real rollback mechanism, and
extending the AI SEO Agent itself through the Tool Executor/Policy Engine
(the one remaining domain not yet wired that way, per `CLAUDE.md`'s
"Still outstanding" list).

---

**STOP.** Per the brief's §54 stop condition: do not automatically begin
Phase 10, implement autonomous missions, or expand into unrelated
integrations. Waiting for explicit instructions.
