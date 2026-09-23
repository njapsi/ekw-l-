# Runbook: Deployment rollback

See `docs/DEPLOYMENT.md` §17 for the canonical rollback procedure; this
runbook restates it in the standard runbook shape with the triggering
symptoms made explicit.

## Symptoms

A deployment introduced a regression: elevated error rate, a broken
critical flow (sign-in, billing, a core dashboard), or a failed health
check that a `worker-failure.md`/`application-down.md` diagnosis traces
back to "started right after the last deploy."

## Diagnosis

1. Confirm the timing correlation — did errors start right at/after the
   last `docker compose up -d` for `web`/`worker`?
2. Check `docker compose -f docker-compose.production.yml logs --tail=200
   web` for a startup-time error distinct from a runtime one.
3. Decide: is this an application-code regression (roll back the image),
   or a bad migration (a different, more careful procedure — see below)?

## Commands / tools

```bash
# App code rollback — both are stateless; JWT sessions survive.
docker compose -f docker-compose.production.yml up -d --force-recreate web
docker compose -f docker-compose.production.yml up -d --force-recreate worker
# (pointed at the PREVIOUS image tag)
```

## Mitigation / recovery procedure

1. **App code only, no migration involved:** redeploy the previous image
   tag for `web`, then `worker`. Because this project's migrations are
   additive/expand-contract by convention, the previous app version runs
   fine against the current (newer) schema — a code rollback needs **no**
   schema rollback.
2. **A bad migration:** do **not** hand-edit the live schema under
   pressure. Restore from the pre-migration backup into a new database
   (`backup-restore.md`), repoint `DATABASE_URL`/`DIRECT_URL`, redeploy.
   This project keeps no down-migrations by convention.
3. **Partial mitigation without a full rollback:** the relevant kill
   switch (`CRAWLER_HALT=1`, `MISSIONS_HALT=1`, `AI_DISABLED=1`, or
   pausing a specific BullMQ queue from `/admin`) can buy time to
   investigate without a full redeploy.

## Verification

- `/api/health` returns 200 with every check `ok`.
- The specific broken flow now works.
- Error rate returns to baseline.

## Escalation

SEV-1 if the regression is customer-facing and severe (broken sign-in,
broken billing); SEV-2 for a contained, lower-impact regression.

## Post-incident

Write up within 5 business days (`docs/SECURITY.md` §15 convention); add
the regression test that would have caught this before it shipped, and
confirm CI's own gate sequence (`.github/workflows/ci.yml`) actually
covers the path that broke — if it does and this still shipped, that's
itself worth investigating.
