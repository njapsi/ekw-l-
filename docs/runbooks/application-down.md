# Runbook: Application down

**Symptoms:** `/api/health` (web) or `:$WORKER_HEALTH_PORT/healthz` (worker)
not responding, or responding with `status: "down"`; users report the site
is unreachable; Caddy/reverse-proxy returns 502/503/504.

## Diagnosis

1. `docker compose -f docker-compose.production.yml ps` — which container(s)
   are not `Up`/`healthy`?
2. `docker compose -f docker-compose.production.yml logs --tail=200 web` (or
   `worker`) — look for a crash, an uncaught exception at boot, or a config
   -validation failure (`packages/services/src/config/env.ts` throws at
   import time on a missing/invalid required env var in strict mode).
3. `curl -sf https://<domain>/api/health` — read the JSON body; each of
   `database`/`redis`/`ai_provider`/`external_integrations`/`worker` reports
   its own `ok`/`degraded`/`down`/`unconfigured` state independently. This
   tells you *which* dependency is actually the problem before you assume
   "the app" is broken.
4. Check the reverse proxy (Caddy) logs for a TLS/upstream error separate
   from the app itself: `docker compose logs --tail=100 caddy`.

## Commands / tools

```bash
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail=200 web
curl -sf https://<domain>/api/health | jq
```

## Mitigation

- If one container crashed but others are healthy: `docker compose -f
  docker-compose.production.yml up -d --force-recreate web` (or `worker`) —
  BullMQ jobs already queued in Redis are not lost.
- If the cause is a bad deploy: see `deployment-rollback.md`.
- If the cause is a dependency (DB/Redis) being down: see the matching
  runbook (`database-failure.md`/`redis-failure.md`) — the app itself may
  be fine and just can't reach what it depends on.
- If `/api/health` itself 500s (not just reports `down`): this is the
  specific regression Phase 27 found and fixed (a config failure poisoning
  the whole `@growth-agent/services` module import) — confirm
  `GROWTH_AGENT_ENV_STRICT` and every required env var are actually set;
  the route's own dynamic-import-inside-try design should prevent this,
  but verify the deployed image matches current `main`.

## Recovery

Restart the affected container(s); confirm `/api/health` returns 200 with
every check `ok` (or `degraded` only where genuinely expected, e.g.
`ai_provider: unconfigured` if no AI key is set).

## Verification

- `/api/health` returns 200.
- A real sign-in works end to end (see `docs/GO-LIVE.md`'s smoke test).
- `docker compose ps` shows all services `Up (healthy)`.

## Escalation

If the outage persists after a container restart and the dependency
runbooks don't resolve it, this is a SEV-1 per `docs/INCIDENT-RESPONSE.md`'s
severity table — escalate to whoever holds the on-call/ops role for this
deployment (no formal on-call rotation exists yet — a disclosed gap, see
`docs/PHASE-14-FINAL-CERTIFICATION.md`).

## Post-incident

Write up root cause within 5 business days (`docs/SECURITY.md` §15
convention); add a regression test or a health-check improvement if the
failure mode wasn't already covered.
