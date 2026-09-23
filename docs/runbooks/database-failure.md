# Runbook: Database failure

**Symptoms:** `/api/health`'s `database` check reports `down`; the app
returns 500s on any page that reads the database (effectively everything);
worker jobs fail immediately on their first query.

## Diagnosis

1. `curl -sf https://<domain>/api/health | jq '.checks[] | select(.name=="database")'`.
2. Check the managed Postgres provider's own status page first — most
   "database failures" in this architecture are a provider-side outage,
   not a bug in this app (Postgres/Redis are externally managed;
   `docker-compose.production.yml`'s own header comment states this).
3. If self-hosting Postgres: `docker compose logs --tail=200 postgres` (or
   the provider's console) for OOM, disk-full, or connection-limit errors.
4. Check `DATABASE_URL`/`DIRECT_URL` are still valid (a rotated credential
   — see `docs/INCIDENT-RESPONSE.md` §3 if this was a deliberate rotation
   during a security incident, not an outage).

## Commands / tools

```bash
curl -sf https://<domain>/api/health | jq
psql "$DATABASE_URL" -c 'select 1;'   # from a host that can reach it
```

## Mitigation

- Provider outage: wait for provider recovery; no action possible from
  this app's side beyond confirming `/api/health` self-heals once the
  provider recovers (no restart needed — Prisma reconnects automatically).
- Credential rotated/invalid: update `DATABASE_URL`/`DIRECT_URL` in the
  platform secret store, redeploy `web` and `worker`.
- Genuine data loss/corruption: see `backup-restore.md` — do **not**
  attempt an ad hoc repair; restore from the latest verified backup.

## Recovery

`docker compose -f docker-compose.production.yml up -d --force-recreate web
worker` after the underlying database is reachable again, then confirm
`/api/health`'s `database` check is `ok`.

## Verification

- `/api/health` database check is `ok`.
- A real sign-in and a dashboard page load work end to end.
- `docker compose logs worker` shows jobs resuming (no repeated connection
  -refused errors).

## Escalation

SEV-1 (`docs/INCIDENT-RESPONSE.md`). If a restore was required, follow
`docs/DISASTER-RECOVERY.md`'s RPO/RTO documentation for what to tell
affected customers about the data-loss window.

## Post-incident

If this was a capacity issue (connection limit, disk), document the actual
limit hit and whether `DATABASE_URL`'s connection-pool parameters
(`docs/DATABASE.md`) need adjusting.
