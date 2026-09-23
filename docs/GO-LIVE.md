# GO-LIVE.md

The go-live procedure for a production deployment of Growth Agent. This is
the operational sequence to follow; `docs/PRODUCTION-RELEASE-CHECKLIST.md`
is the pre-conditions checklist, and `docs/PHASE-14-FINAL-CERTIFICATION.md`
is the honest readiness verdict as of this phase. Follow all three
together — this document alone is not a certification.

---

## Before deployment

1. **Backup.** Take a fresh database backup (or confirm the managed
   provider's continuous PITR is active) before touching anything.
2. **Migration verification.** `prisma validate` against the target
   schema; review the pending migration's SQL by eye (this project's own
   convention — no live DB in this development sandbox to run `prisma
   migrate dev` against, so every migration since Phase 24 has been
   hand-authored and reviewed, not machine-generated-and-tested).
3. **Environment verification.** `node scripts/check-env.mjs --target web`
   and `--target worker` against the real production `.env` — must report
   `✓ ready`, not `--allow-insecure`.
4. **Dependency verification.** `pnpm install --frozen-lockfile`;
   `node scripts/audit-allow.mjs` clean.
5. **Build verification.** `pnpm --filter @growth-agent/web build` (with
   `NEXT_OUTPUT_STANDALONE=1`) and the two Docker images
   (`docker build -f Dockerfile.web .`, `docker build -f Dockerfile.worker
.`) both succeed.
6. **Security verification.** `pnpm lint`, `pnpm typecheck`, the full test
   suite, `node scripts/check-tenant-scope.mjs` — all clean (this session's
   own fresh run: lint 14/14, typecheck 14/14, 1403/1403 tests, tenant
   -scope clean).

## Deployment

```bash
# On the production host, from the deployed checkout:
docker compose -f docker-compose.production.yml pull   # or build locally
docker compose -f docker-compose.production.yml run --rm migrate
docker compose -f docker-compose.production.yml up -d web worker caddy
```

1. **Deploy** the new images.
2. **Migrate** — the one-shot `migrate` service runs `prisma migrate
   deploy`, never at app boot (`docs/DEPLOYMENT.md` §12).
3. **Start web.**
4. **Start workers.**
5. **Verify health:** `curl -sf https://<domain>/api/health | jq` — every
   check `ok` (or `unconfigured` only where genuinely not configured yet,
   e.g. `ai_provider` if no key is set).
6. **Run smoke tests** — the 22-step sequence at the bottom of this
   document.

## After deployment

- **Monitor** the first 30-60 minutes closely: error rate, latency, queue
  depth (`/admin` or Prometheus if wired up).
- **Test authentication** — a real signup, a real magic-link/password
  login, a real logout.
- **Test integrations** — at minimum, one real OAuth connect (whichever
  integration the launching customer actually needs first).
- **Test AI** — one real AI Agent turn.
- **Test billing** — if launching with billing live, one real Stripe test
  -mode (or live-mode, deliberately) checkout.
- **Verify queues** — a real crawl/sync job completes.
- **Verify logs** — structured logs are flowing, no secrets appearing in
  them (spot-check).
- **Verify alerts** — confirm the alerting pipeline itself is live (not
  just configured) before trusting it to catch the next real problem.

## Rollback

See `docs/runbooks/deployment-rollback.md` for the full procedure. In
short: app-code-only regressions roll back by redeploying the previous
image tag (stateless, no schema rollback needed, since migrations are
additive/expand-contract by convention); a bad migration requires
restoring from the pre-migration backup into a new database — never a
hand-edited live schema under pressure.

---

## Condensed smoke-test sequence (§43 of the Phase 14 brief)

Run this after every deployment, not just the first:

1. Application loads (`GET /`).
2. `/api/health` returns 200, every check `ok`/expected.
3. Signup works.
4. Magic link works (or password login, whichever is configured).
5. Login works.
6. Organization creation/switching works.
7. RBAC: a VIEWER-role user cannot see an OWNER-only page/action.
8. Database: any page that reads real data loads without error.
9. Redis: a rate-limited action is actually throttled after its limit.
10. Worker: a real job (e.g. a crawl) completes.
11. YouTube connection flow reaches the real Google consent screen.
12. Website crawl starts and produces at least one result.
13. Search Console connection flow reaches the real Google consent screen.
14. WordPress connection flow succeeds against a real test site.
15. AI Agent responds to a simple question.
16. A tool-calling AI action correctly requires the expected approval.
17. A Growth Mission can be created and reaches its first task.
18. Billing page loads and shows the correct plan.
19. A Stripe webhook (a real or test event) processes to `PROCESSED`.
20. A notification is created and appears in the bell/`/app/notifications`.
21. Audit log records the actions taken above.
22. Logout works and the session is actually invalidated (a request with
    the old cookie is rejected).

This exact sequence has **not** been run end-to-end against a live
deployment from this session (no live infra) — it is the specified
procedure, not a claim that it has already been executed successfully.
