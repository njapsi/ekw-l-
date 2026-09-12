# REPORTING.md

Status: **implemented (operator's "Phase 11")**. Code:
`packages/services/src/reports`, `apps/web/app/(app)/app/reports`,
`apps/web/app/r/[token]`, `apps/web/src/server/report-actions.ts`, and the
`report-generation` worker queue. Design decision: ADR-0026.

A professional reporting engine. One report per analysis area, all with the same
seven sections, viewable as a dashboard and exportable to PDF / CSV / JSON, with
optional public share links that expose **no private account information**.

---

## 1. Report types

`ReportType` (`packages/core` `schemas/report.ts`):

| Type                 | What it covers                                                     | Data source                             |
| -------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `YOUTUBE`            | Channel + video performance, cadence, open recommendations         | `youtube.getChannelOverview` + recs     |
| `TIKTOK`             | Account performance, cadence, themes, recommendations              | `tiktok.getAccountOverview` + recs      |
| `SEO`                | The AI SEO Agent view — ranked fixes, quick wins, top issues       | `seo.listRankedSeoRecommendations` etc. |
| `WEBSITE_HEALTH`     | Technical-crawl health: score + grade, issues by severity, summary | `seo.getCrawlOverview`                  |
| `AI_RECOMMENDATIONS` | Every open recommendation across all surfaces, prioritized         | `Recommendation` rows                   |
| `GROWTH`             | Cross-surface summary: connected surfaces, audience, opportunities | all of the above + monetization         |
| `MONETIZATION`       | Opportunities, readiness, user-entered revenue                     | `monetization.getMonetizationDashboard` |

A per-type gatherer (`reports/facts.ts`) reads from the existing module
functions, tolerates missing data (returns `connected: false` + `dataGaps`), and
**never invents a number**.

---

## 2. The seven sections (every report)

`ReportSnapshot` (in `@growth-agent/core`):

1. **Executive Summary** — `{ headline, paragraphs[], grounded }`. Deterministic
   assembly by default; an optional grounded model pass replaces the prose and
   is dropped on any grounding failure. Never guarantees an outcome.
2. **Key Metrics** — `{ label, value, raw, unit?, delta?, note? }[]`. `delta` is
   computed against the previous report's metric of the same label:
   `{ previous, changePct, direction }`.
3. **Problems** — `{ id, title, detail, severity, evidence[] }[]`, sorted
   critical → info.
4. **Opportunities** — `{ id, title, detail, potential?, effort? }[]`.
5. **Recommendations** — `{ id, title, why, actions[], priority, effort,
confidence, expectedImpact }[]`, sorted by priority.
6. **Priority Actions** — the top ~5 recommendations as `{ rank, title,
rationale, effort }`.
7. **Historical Changes** — `{ comparedTo, changes[], notes[] }`. `changes` are
   the metrics whose value moved since the previous report of the same type;
   the first report of a type has an empty list and a "nothing to compare yet"
   note.

Plus `meta` (type, title, subject label, org name, `generatedAt`,
`dataThrough`, `isPublic`), `disclaimers[]` and `dataGaps[]`.

---

## 3. Immutable snapshots (ADR-0026)

`generateReport`:

1. `usage.enforceUsage({ meter: 'REPORTS' })` — server-side.
2. Find the previous `READY` report of the same type → its snapshot is the diff
   baseline.
3. Create a `Report` row (`status = BUILDING`).
4. `buildReportSnapshot` → gather facts → `assembleSections` (+ the diff) →
   `buildExecutiveSummary`.
5. Store the whole `ReportSnapshot` on the row, `status = READY`,
   `previousReportId` set, `finishedAt` stamped. **The row is never mutated
   again.** `usage.recordUsage` (idempotent on the report id) + an audit entry.
6. On any error: `status = FAILED` + `error`, audit `report.failed`.

Regenerating a report is a **new row**. The dashboard view and every export
render from the stored `snapshot`, so a shared or downloaded report can never
change after the fact.

---

## 4. Exports (rendered on demand)

`reports.renderExport(snapshot, format)` — nothing is stored; the snapshot is
the durable artifact.

| Format | How                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF    | `reports/pdf/` — a ~200-line hand-rolled writer, base-14 Helvetica (no embedded font), text wrapping from an embedded width table, headings / key-value rows / tables / auto page-breaks / footer. Deterministic. **Text only — no charts (v1).** |
| CSV    | `reports/export/csv.ts` — one file, a labelled `# Section` block per section, RFC-4180 escaping. Pure.                                                                                                                                            |
| JSON   | the snapshot, pretty-printed.                                                                                                                                                                                                                     |

- **Dashboard**: `/app/reports/[id]` renders `ReportSnapshotView`.
- **Authenticated export**: `GET /app/reports/[id]/export?format=pdf|csv|json`
  (`report:read`, org-scoped).

---

## 5. Share links — public, redacted

- `report:share` (**ADMIN+**) → `createShareLink` sets `Report.shareToken`
  (32 random bytes, base64url, `@unique`), optional `shareExpiresAt`.
  `revokeShareLink` sets `shareRevokedAt`.
- `GET /r/<token>` and `GET /r/<token>/export` are **public** (the token is the
  only credential) and serve `redactSnapshotForPublic(snapshot)` **only**:
  - subject label → a generic phrase ("a YouTube channel"); org name → "Shared
    report"; `meta.isPublic = true`;
  - every free-text field scrubbed of emails, `https?://…` URLs, `@handles` and
    20+ char ids;
  - raw monetary amounts hidden (`raw` nulled, value → "amount hidden on shared
    links"); aggregate counts, scores and relative deltas stay.
- An unknown / malformed / expired / revoked / non-`READY` token → **404**.
- Public pages + exports are `noindex`.

---

## 6. RBAC

| Action            | Role    | Covers                               |
| ----------------- | ------- | ------------------------------------ |
| `report:read`     | VIEWER+ | dashboard view, authenticated export |
| `report:generate` | MEMBER+ | generate, delete                     |
| `report:share`    | ADMIN+  | create / revoke a public share link  |

---

## 7. Documented limitations (do not fake)

- **No charts in the PDF** — it is a well-formatted text document. A charting
  pass is a follow-up.
- **Single-report generation is inline** in the Server Action (bounded — a few
  reads + one optional model call). The `report-generation` worker queue has a
  real processor for batches / re-runs (ADR-0013 pattern).
- **No object storage.** Exports are re-rendered from the snapshot each time.
- The report picks the primary subject automatically (newest connected channel /
  account, or a verified site with a completed crawl); a per-report subject
  picker in the UI is a follow-up (the service already accepts `params.websiteId`).
