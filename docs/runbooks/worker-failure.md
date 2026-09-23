# Runbook: Worker failure

**Symptoms:** `/api/health`'s `worker` check reports `down`/`degraded`
(stale `WorkerHeartbeat` row — the worker upserts one every ~15s,
`packages/services/src/observability/worker-heartbeat.ts`); queued jobs
(crawls, syncs, agent runs, missions, billing reconcile) stop completing;
`docker compose ps` shows the `worker` container restarting or exited.

## Diagnosis

1. `docker compose -f docker-compose.production.yml logs --tail=300 worker`
   — look for the actual exception, not just the restart.
2. `curl -sf https://<domain>/api/health | jq '.checks[] | select(.name=="worker")'`.
3. Check `/admin` (platform staff) queue-depth views
   (`observability/queues.ts`) for a specific queue backing up —
   `seo-crawl`, `agent-run`, `billing`, etc. — to narrow down which job
   type is failing.
4. If the crash is specific to `seo-crawl` and headless rendering: check
   for a Playwright/Chromium crash (`apps/worker/src/seo/
playwright-renderer.ts`) — Chromium is memory-hungry; check for an OOM
   kill (`docker compose logs worker | grep -i "oom\|killed"`).

## Commands / tools

```bash
docker compose -f docker-compose.production.yml logs --tail=300 worker
docker compose -f docker-compose.production.yml ps worker
```

## Mitigation

- Transient crash: `docker compose -f docker-compose.production.yml up -d
  --force-recreate worker` — every queue has `defaultJobOptions` with
  exponential-backoff retries (Phase 12), so an in-flight job that failed
  because the worker died gets retried automatically, up to its `attempts`
  cap; it does not need to be manually re-queued.
- Repeated OOM on the crawl queue: the worker's Docker resource limit
  (`docker-compose.production.yml`, `deploy.resources.limits.memory`) may
  need raising, or `CRAWLER_HALT=1` temporarily while investigating a
  specific pathological page/site.
- A single stuck job holding a queue's concurrency slots: identify it via
  `/admin`'s queue view and consider `CRAWLER_HALT_ORG_IDS=<id>` (or the
  equivalent `MISSIONS_HALT_ORG_IDS`) for that one organization while
  investigating, rather than halting everyone.

## Recovery

Restart the worker container; confirm the `WorkerHeartbeat` row is fresh
again (`/api/health`'s `worker` check `ok`) and that queue depth is
draining, not still growing.

## Verification

- `/api/health` worker check is `ok`.
- A new crawl/agent-run/mission tick actually completes end to end.
- `/admin`'s queue views show depth decreasing.

## Escalation

SEV-2, or SEV-1 if it has caused missed billing reconciliation or a stuck
mission with an open approval a customer is waiting on.

## Post-incident

If the root cause was a specific job payload (a pathological crawl target,
a runaway mission), add the missing guard (a page/time/step cap) rather
than just restarting and moving on — this project's own convention is to
fix the underlying cause, not just clear the symptom.
