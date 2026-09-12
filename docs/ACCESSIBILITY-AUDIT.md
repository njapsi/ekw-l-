# ACCESSIBILITY-AUDIT.md — Phase 29: UI/UX Accessibility Audit

**Question asked:** does the app work across desktop/tablet/mobile, with
keyboard navigation, screen readers, ARIA, color contrast, and semantic
HTML — and does it stay usable when data is missing, an API fails, a page
has thousands of records, AI takes several seconds, or a crawl is running?
**Brief was explicit: do not redesign the product, improve usability only
where necessary.**

**Headline answer:** the app's structural foundation (Radix primitives,
real `<table>` markup, correctly-labeled forms in every sample checked, a
working retry-on-error boundary) was already sound. This audit found and
fixed a bounded set of concrete gaps — most of them one shared component
or CSS rule away from fixing many call sites at once — rather than a
systemic problem. No visual redesign was made; every fix is either
non-visual (an ARIA attribute) or visually identical (a `<div>` → `<h3>`
swap driven entirely by existing `className`).

---

## Methodology

No accessibility tooling (axe-core, jest-axe) or documentation existed
before this phase. Three parallel research passes covered the shared
component library (`packages/ui`), page-level states and forms across
`apps/web`, and resilience under load (thousands of records, slow AI, an
in-progress crawl) — cross-checked against each other where they
overlapped. Alongside that: hand-computed WCAG contrast ratios for every
design-token color pairing, a heading-nesting check across every page using
`CardTitle`, and direct reading of the agent-chat SSE streaming loop and
the crawl-issues pagination code path. Findings were filtered hard against
the brief's "only where necessary" instruction — a large share of
initially-flagged items (see "Documented, not fixed" below) were judged
out of proportion for a fix pass and left for a future, explicitly-scoped
phase.

**Verification limit, same as Phases 27-28:** this machine's Docker
Desktop cannot start (virtualization disabled in firmware), so there is no
live Postgres/Redis/worker. Every fix touching an authenticated surface —
settings, the TikTok publish dialog, the crawl-issues pagination UI, the
notification bell, the agent chat — was verified by type-checking against
Prisma's/React's generated types, the existing DB-less Playwright suite,
and (for the public, unauthenticated surfaces) direct live inspection in a
browser, including fetching the compiled CSS to confirm the reduced-motion
and contrast fixes made it into the production bundle correctly. It was
not possible to click through the authenticated app live in this
environment, exactly as disclosed in the last two phases.

---

## Fixes made

### Color contrast

Hand-computed the WCAG relative-luminance contrast ratio for every color
pairing in `packages/ui/src/styles.css` (light and dark). Every pairing
was comfortably clear of the 4.5:1 AA floor for normal text **except**
light-mode `--muted-foreground` on `--background`/`--card`, which came out
to ~4.70:1 — technically passing, but with almost no margin for
anti-aliasing or sub-pixel rendering. Darkened from 47% to 40% lightness
(same hue/saturation, so it reads as the same gray, just slightly deeper),
giving ~6.1:1. Confirmed live: fetched the compiled production CSS and
verified `--muted-foreground:215 16% 40%` is present in the shipped
bundle.

### Reduced motion

Confirmed by two independent research passes: **zero** occurrences of
`prefers-reduced-motion` anywhere in the repo, despite 14+ files using
`animate-spin`/`animate-pulse`/`animate-in`/`animate-out`/`transition-*`
(the loading skeletons, the spinner, Dialog/DropdownMenu enter-exit, the
agent chat's inline spinner, Tabs/Button transitions). Added one guard to
`packages/ui/src/styles.css`:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Collapsing durations to near-zero (rather than `animation: none`) was
deliberate: Radix's `Presence` primitive, which drives `Dialog`/
`DropdownMenu` unmounting on close, listens for a real
`animationend`/`transitionend` event before removing content from the DOM
— `none` would suppress that event and could leave a closed dialog's
content stuck in the tree. This is the standard, widely-documented
reduced-motion pattern for exactly this reason. Confirmed live: fetched
the compiled CSS and verified the exact rule is present in the shipped
bundle.

### Semantic headings

`CardTitle` (`packages/ui/src/components/card.tsx`) rendered a `<div>`,
not a heading, despite being visually a section title in all 153 usages
across `apps/web` — meaning every Card-based section in the app was
invisible to a screen reader's heading-navigation feature. Changed to
`<h3>`; `className` drives 100% of its visual appearance, so this is a
zero-visual-change fix (confirmed live in the browser and via the
accessibility tree — the landing page's feature cards, which use
`CardTitle`, now expose real `heading` roles). Companion fix: `Badge`'s
root moved from `<div>` to `<span>` (several `CardTitle`s wrap a `Badge`,
and a `<div>` nested in a heading is invalid HTML5; `Badge` was already
`inline-flex` visually, so no visual change here either). The one page
where a `CardTitle` and a bare sibling `<h3>` coexisted — the crawl-issues
page's per-severity groupings — had that sibling bumped to `<h4>` to keep
the nesting correct now that `CardTitle` is a real heading.

### Loading states

`Skeleton` (`packages/ui/src/components/skeleton.tsx`) was purely visual
— a screen reader got no signal a section was loading. Rather than give
every `Skeleton` its own announcement (both loading views that use it
render 4-8 at once, which would announce "Loading" that many times),
`Skeleton` is now `aria-hidden="true"` by default (it's a decorative
placeholder), and each loading view
(`apps/web/app/(app)/app/loading.tsx`, `(admin)/admin/loading.tsx`) wraps
its whole group in one `role="status" aria-label="Loading page content"`
container. Two new `loading.tsx` files were added for `(auth)/`
(login/signup) and `onboarding/`, which had no loading state at all
— confirmed by a full route-file survey, no shared one existed further up
either tree.

`EmptyState` (`packages/ui/src/components/empty-state.tsx`) gained
`role="status"` so an async loading→empty transition is announced.
Three ad-hoc "no data" blocks (YouTube and TikTok's video lists, and the
notifications view) were swapped for the shared `EmptyState` component
instead of their own bespoke markup — a substitution for consistency, not
new UI.

### Form and action error/success messages

The single largest finding: a full-repo grep for the app's error-styling
class turned up **zero** occurrences of `aria-describedby`, `aria-invalid`,
`role="alert"`, or `aria-live` anywhere in `apps/web` — confirmed
independently by two research passes. Every transient form/Server-Action
result (onboarding, the login/signup form, every settings action, SEO
website/crawl actions, YouTube/TikTok connect/sync/disconnect, content
generation, monetization scans, automation/report creation, the agent
chat's error state) was a plain colored `<p>`/`<span>` with no ARIA
linkage — a screen reader user got no notification when a submit
succeeded or failed.

**Not every red-colored piece of text got this treatment.** A repo-wide
grep for the error-styling class returned ~85 hits; roughly two-thirds
were admin-table cells, persisted `lastError`/`failureReason` fields
displayed from a fetched record, or destructive-button styling — static
content already present at page load, not a fresh result of the user's
action. Applying `role="alert"` there would be a misuse (an assertive
interruption firing on every ordinary render), so those were deliberately
left alone. The ~30 genuine transient-result sites — always a local
`useState`/`useActionState`/`useTransition`-backed variable, never a field
read off a list item — each got `role="alert"` (error) or `role="status"`
(success), including the shared local `Status` helper functions reused
across `apps/web/src/components/app/seo/seo-actions.tsx` (5 forms),
`tiktok/tiktok-actions.tsx`, and `content/project-actions.tsx`.
The agent chat's status line ("Planning…", "Running SEO Agent…") also
gained `role="status" aria-live="polite"` so its progress is announced as
it changes, not just shown visually.

### Labels

One unlabeled control found: the per-member role `<select>` in
`apps/web/src/components/app/settings/settings-tabs.tsx` had no
`Label`/`aria-label` (only adjacent visible name/email text for sighted
users). Added `aria-label={\`Change role for ${name}\`}`. Every other
form sampled across onboarding, settings, the SEO add-website form, and
the auth form already correctly paired `<Label htmlFor>`with a matching
input`id`.

### Tables

Real `<table>`/`<thead>`/`<tbody>` markup (not div-grids) was already used
everywhere tabular data appears, and every one was already wrapped in
`overflow-x-auto` for mobile — both confirmed structurally sound. The one
gap: zero occurrences of `scope=` anywhere in the repo. Added
`scope="col"` to every `<th>` in the three real table implementations
(`apps/web/src/components/admin/data-table.tsx` — the single generic
component every admin page's table uses, `search-console-dashboard.tsx`,
`revenue-tracker.tsx`).

### Thousands of records

`packages/services/src/seo/read.ts`'s `listCrawlIssues` already computed
and discarded a `nextCursor`; the crawl-detail page called it with a fixed
`{ limit: 100 }`, so a crawl with thousands of real issues could only ever
show the first 100 with no way to reach the rest. Fixed by reusing the
exact cursor-pagination pattern already proven for YouTube/TikTok's video
lists in this codebase: the page now accepts `?cursor=` and renders a
"Load more issues" link when more remain. `listCrawlIssues` also now
returns an exact `total` (a parallel `count()` query, not an approximation
summed from category counts — an approximation would risk the "never
fabricate a calculated_metric" hard rule), so the heading reads "Issues
(2,000) — showing 100" instead of conflating the visible count with the
true total. The existing Phase 27 e2e test that seeds 2,000 issues was
updated to assert this new heading text and that the "Load more" link
actually advances to the next page — its old assertion (`Issues (2000)`)
could never have passed against either the pre-existing 100-item cap or
the new pagination.

### AI takes several seconds

The agent chat's progress indicator ("Planning…", "Running SEO Agent…")
was purely visual with no live-region announcement — fixed (see "Form and
action error/success messages" above). Everything else checked out:
explicit fetch failures and non-OK responses already surface a visible,
readable error and remove the stuck placeholder bubble, matching the
existing Phase 27 e2e coverage for that path.

### Notification bell

The bell's unread-count badge had no `aria-hidden`, while the parent
button already carries a full `aria-label` including the count — a screen
reader could double-announce the number. Added `aria-hidden="true"` to
the badge span (the accessible name already comes from the parent).

---

## Documented, not fixed (rationale)

- **Toast/snackbar system.** No such primitive exists in this app. Every
  mutation already surfaces success/failure inline, and that inline
  feedback is now screen-reader-announced (see above) without adding a new
  shared component or wiring every mutation site to it — building one
  would be a new feature, not a fix, and out of proportion for this phase.
- **Missing `Select`/`Checkbox`/`Radio`/`Tooltip` shared primitives.**
  Native elements already in use are accessible on their own once labeled
  (the one gap found is fixed above); adding new library primitives is
  scope creep beyond a targeted fix pass.
- **No dedicated `error.tsx` for the `(admin)`/`(auth)` route groups.**
  The root `error.tsx` already covers them with a working retry button —
  a dedicated one would only preserve page chrome/styling, a polish item,
  not a functional accessibility gap.
- **Crawl-status live polling / a progress bar.** Adds new real-time
  client behavior (interval polling, more state) beyond an accessibility
  fix. The current pause/resume/cancel + manual-refresh flow is functional
  and doesn't block the rest of the page. Also can't be verified against a
  real running crawl in this environment — no live DB/Redis/worker, same
  constraint as Phases 27-28.
- **Agent-chat cancel button + stream stall-timeout.** A genuine new
  feature/failure-mode addition, not a fix for something broken in normal
  operation — a clean fetch failure or non-OK response is already handled
  correctly. A "safe" stall-timeout threshold can't be validated without
  live AI provider traffic (no AI key configured in this environment), and
  shipping an unvalidated one risks a new false-positive bug.
- **`DialogTitle` not type-enforced.** Only one real `<Dialog>` call site
  exists in the whole app (`tiktok/publish-form.tsx`) and it already
  supplies a title correctly — enforcing this for a single correct usage
  isn't worth the churn.
- **Duplicate empty-state markup beyond the three swapped.** A broader
  sweep might find more small inconsistencies in ad-hoc "no data" text;
  the three found and fixed were the ones flagged by the research passes
  as genuinely inconsistent with the established `EmptyState` pattern.

---

## Verification

- `pnpm format:check && pnpm lint && pnpm typecheck` — 14/14 clean.
- `pnpm --filter @growth-agent/services test` — 681/681 passing, unchanged
  (no service test asserted the exact shape `listCrawlIssues` gained a
  field on).
- `pnpm test:scripts`, `node scripts/check-tenant-scope.mjs`,
  `node scripts/audit-allow.mjs` — all clean.
- `pnpm --filter @growth-agent/web build` — successful production build,
  every route rendered.
- `pnpm --filter @growth-agent/web test:e2e` (DB-less) — matched Phase
  27's exact 61/88 baseline on a clean run; two transient failures on an
  earlier pass (worker contention under full-suite parallelism) were
  confirmed passing both in isolation and on re-run — not a regression.
  `failures.spec.ts`'s 2,000-issue test updated for the new pagination UI.
- Live browser verification (public pages only, per the disclosed DB
  limitation): landing page, login, signup, pricing rendered correctly
  with full styling; the accessibility tree confirmed `CardTitle`s render
  as real `heading` roles; fetched the compiled production CSS and
  confirmed both the `prefers-reduced-motion` rule and the darkened
  `--muted-foreground` token are present in the shipped bundle exactly as
  written.

---

## Residual risks

- Every fix touching an authenticated surface (settings, the TikTok
  publish dialog, the crawl-issues pagination UI, the notification bell,
  the agent chat's live-region addition) is verified only by
  type-checking and the DB-less e2e suite, not by driving the actual
  authenticated UI live — same disclosed limitation as Phases 27 and 28.
  The next phase with a working Docker/WSL environment (or a CI run)
  should click through these surfaces directly, ideally with a screen
  reader, to confirm the ARIA additions read the way they're intended to.
- No automated accessibility scanning tool (axe-core, Lighthouse a11y)
  was added this phase — findings came from manual code reading and
  targeted live checks, not an automated audit. A future phase could add
  `@axe-core/playwright` to the existing e2e suite to catch regressions
  going forward; deferred here since introducing a new testing dependency
  wasn't asked for and the existing manual audit already found and fixed
  the issues present.
- The `role="alert"`/`role="status"` sweep was scoped to the ~85 sites a
  single grep pattern (`text-destructive`) surfaced; a differently
  -styled error message (if any exists) elsewhere in the app would not
  have been caught by this pass.
