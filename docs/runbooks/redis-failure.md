# Runbook: Redis failure

**Symptoms:** `/api/health`'s `redis` check reports `down` or `degraded`;
rate limits silently stop enforcing (the limiter fails **open** by design,
`packages/services/src/security/rate-limit.ts`) — except the two
credential-guessing surfaces (password login, password-reset request) that
Phase 12 made **fail closed**, which will refuse those specific requests
while Redis is down; BullMQ jobs stop being picked up (they queue in
Postgres-backed... no — BullMQ itself requires Redis, so new jobs cannot be
enqueued or processed at all while Redis is down); the crawl frontier and
idempotency keys are unavailable.

## Diagnosis

1. `curl -sf https://<domain>/api/health | jq '.checks[] | select(.name=="redis")'`.
2. Check the managed Redis provider's status page (Upstash or equivalent).
3. `docker compose logs --tail=200 worker` for repeated `ECONNREFUSED`/
   `ETIMEDOUT` against `REDIS_URL`.

## Commands / tools

```bash
curl -sf https://<domain>/api/health | jq
redis-cli -u "$REDIS_URL" ping   # from a host that can reach it
```

## Mitigation

- Provider outage: no action possible beyond waiting; per
  `docs/DISASTER-RECOVERY.md` scenario 3, this self-heals automatically —
  BullMQ jobs queue up in memory in the *producer* only for as long as that
  process is alive (a web request that tried to enqueue a job during the
  outage will have surfaced an error to the user, not silently lost it —
  confirm this holds for the specific action if investigating a report of
  "my job never ran").
- Credential rotated: update `REDIS_URL` (must be `rediss://` with a
  password in production strict mode — `scripts/check-env.mjs`), redeploy.

## Recovery

No explicit restart needed once Redis is reachable again — `ioredis`
reconnects automatically; confirm via `/api/health`.

## Verification

- `/api/health` redis check is `ok`.
- A rate-limited action (e.g. a repeated wrong-password login) is actually
  throttled again, confirming the limiter is live, not fail-open by
  accident.
- `docker compose logs worker` shows jobs being picked up again.

## Escalation

SEV-2 unless combined with another failure (e.g. Redis down *and* the
fail-closed password-login path blocking real users — escalate as SEV-1 if
so, since legitimate users cannot sign in during that window).

## Post-incident

None of this app's rate limits or job queues have ever been tested under a
real Redis outage in this project's history — this runbook's mitigation
steps are derived from the code's documented failure-mode design
(`docs/SECURITY.md` §8, `docs/DISASTER-RECOVERY.md` scenario 3), not from
an observed real incident. Treat the first real occurrence as a chance to
verify this runbook, not just follow it.
