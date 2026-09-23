# DISASTER-RECOVERY.md

Expands `docs/DEPLOYMENT.md` §18 (added Phase 31) into a dedicated document
per Phase 12's brief. That section's content is accurate and is **not**
duplicated here wholesale — read it first for the accepted single-host
architecture, the RTO/RPO reasoning, and the three scenario runbooks it
already has (VPS loss, managed Postgres outage, managed Redis outage). This
document adds the scenarios that section didn't cover, and states plainly
what verification has and has not actually happened.

Incident response (a **security** event — a leaked key, a tenant-isolation
bug) is `docs/INCIDENT-RESPONSE.md`. This document is about **infrastructure
and data loss** with no malicious actor implied, though the containment step
for several scenarios below overlaps with that document's kill switches.

---

## Restore verification status — stated honestly, not fabricated

**No live restore drill has been executed in this project, in this session or
any prior one.** `deploy/backup/pg-restore.sh` is a real script (checksum
verification → decrypt → `pg_restore --clean --if-exists` into a scratch
database, never the live one) reviewed by eye against the backup script it
pairs with, but:

- This sandbox has no live Postgres instance with production-representative
  data volume to restore into, and no permission model that would make it
  safe to attempt a destructive restore against the real staging database
  from an autonomous session.
- No CI job runs `pg-backup.sh` → `pg-restore.sh` end-to-end today.
- No dated log of a completed drill exists anywhere in this repo's history.

The brief that produced this document asked for "a real restore test in a
non-production environment, documented." That could not honestly be
performed here without either (a) provisioning new infrastructure and
credentials this session doesn't have standing authorization to create
autonomously, or (b) running it against the live staging database, which is
a real, shared, user-provisioned system — the "risky action" guidance this
project's own tooling operates under says to ask before that, not assume it.
**This is disclosed as an open item, not silently skipped**: see the risk
register in `docs/SECURITY_POSTURE.md` (`RISK-DR-1`). The next concrete step,
recommended but not taken: provision a throwaway Postgres instance (a second
free-tier Supabase project, or a local `docker compose` Postgres), run
`pg-backup.sh` against a copy of real backup data, then `pg-restore.sh`
against the throwaway instance, and record the actual elapsed time and any
failure encountered — that recorded number is what turns the RTO estimate in
`docs/DEPLOYMENT.md` §18 from a guess into a measurement.

---

## Additional scenarios (beyond `docs/DEPLOYMENT.md` §18's three)

### 4. A bad migration corrupts data (not a hardware/provider failure)

This project's migrations are additive/expand-contract by convention (every
phase's migration note in `CLAUDE.md` says "additive," "0 DROP") specifically
so a bad migration is rare, but the runbook still needs to exist:

1. **Detect.** `prisma migrate deploy` fails mid-run (the `migrate` one-shot
   service exits non-zero — `docker compose run --rm migrate` in
   `docs/DEPLOYMENT.md`), or it succeeds but the app immediately errors on
   the new schema shape.
2. **Contain.** Do **not** run `web`/`worker` against the half-migrated
   database — leave the previous image tag running if the migrate step
   hasn't completed, since Compose's `depends_on` with a healthy `migrate`
   exit code gates the app services starting.
3. **Investigate.** Prisma's migration history table (`_prisma_migrations`)
   records exactly which migration failed and its checksum; compare against
   the migration file in `packages/db/prisma/migrations/`.
4. **Mitigate / Recover.** If the migration is provably safe to re-run
   (idempotent failure, e.g. a transient connection drop mid-apply), re-run
   `migrate`. If the migration itself is the bug, restore from the
   pre-migration backup into a new database (exactly `docs/DEPLOYMENT.md`
   §17's rollback step 3) rather than attempting to hand-write a
   down-migration under pressure — this project keeps no down-migrations by
   convention.
5. **Postmortem.** Every migration should be reviewed against
   `docs/DATABASE.md`'s migration checklist before it ships; a failure here
   means that checklist missed something the review should close.

### 5. Application-level data corruption (a real bug writes wrong data, no infrastructure event at all)

E.g., a bug in a sync job double-counts a metric, or a bad deploy overwrites
a field incorrectly for a window of time — no hardware or provider failure,
just wrong data now sitting in an otherwise-healthy database.

1. **Detect.** A user report of implausible numbers, or a data-accuracy test
   (`docs/DATA-ACCURACY.md`'s own convention of hand-verified exact-value
   tests) that would have caught it if it existed for that code path.
2. **Contain.** Ship the code fix first — restoring old data while the bug
   is still live just gets corrupted again.
3. **Investigate.** Scope the blast radius: which rows, which orgs, what
   time window (most tables carry `createdAt`/`updatedAt`, and several —
   `AgentRun`, `Crawl`, sync runs — record enough metadata to bound this
   precisely).
4. **Mitigate.** For a narrow, well-understood corruption (e.g., a specific
   derived-metric column), a targeted SQL correction script reviewed like a
   migration is usually safer and faster than a full point-in-time restore,
   which would also roll back every legitimate write since the incident.
5. **Recover.** For a corruption too broad or entangled to correct with a
   script, a point-in-time restore (the managed Postgres provider's
   continuous PITR, not the periodic `pg-backup.sh` dump) to just before the
   bad deploy is the cleaner option — this is the main practical advantage
   continuous PITR has over interval backups for this exact scenario, worth
   naming since `docs/DEPLOYMENT.md` §18 mostly discusses PITR for its RPO
   number rather than this use case.
6. **Postmortem / preventive action.** Add the specific regression test that
   would have caught this before it shipped, matching every prior phase's
   own "write the failing test first" convention (Phase 26's
   `docs/DATA-ACCURACY.md` is the precedent).

### 6. TLS certificate renewal failure (Caddy auto-TLS)

1. **Detect.** `/api/health` or any page starts failing with a certificate
   error at the edge, or Caddy's own logs show a failed ACME renewal.
2. **Contain.** Nothing to "stop" — the app itself is unaffected;
   `docs/DEPLOYMENT.md`'s Caddy config auto-renews via Let's Encrypt, so
   this scenario is almost always a DNS or rate-limit issue at the ACME
   layer, not an app bug.
3. **Investigate.** Confirm the domain's DNS still points at the host (a
   changed IP after a VPS migration — see scenario 1 in §18 — is the most
   common real cause) and check Let's Encrypt's own rate limits if
   certificates were issued/reissued repeatedly in a short window.
4. **Mitigate / Recover.** Fix DNS if that's the cause; restart the `caddy`
   service to force a renewal attempt once the underlying issue is
   resolved.
5. **Preventive action.** Monitor certificate expiry explicitly (not yet
   wired into this project's Prometheus alerts — `deploy/alerts.yml` — a
   real, disclosed gap).

### 7. DNS failure or hijack

1. **Detect.** The domain resolves to the wrong IP, or stops resolving.
2. **Contain.** This is entirely outside the application's control surface —
   contain at the registrar/DNS provider (lock the domain, verify account
   access hasn't itself been compromised — if it has, this becomes a
   credential-compromise incident per `docs/INCIDENT-RESPONSE.md` rather
   than a pure infrastructure event).
3. **Recover.** Restore the correct DNS records once account access is
   confirmed secure.
4. **Preventive action.** Registrar-level 2FA and registry lock, which are
   account-security controls outside this codebase's scope to enforce.

---

## Summary: RTO/RPO by scenario

| Scenario | RPO | RTO (estimated — not drill-measured) |
|---|---|---|
| VPS/compute loss | 0 (stateless compute) | Minutes-to-an-hour (provision + redeploy) |
| Managed Postgres outage | Seconds-minutes (PITR) or the backup cron interval | Provider-dependent; a restore-to-new-instance adds the untested `pg-restore.sh` runtime |
| Managed Redis outage | 0 (queues stall, no data loss; rate limiter fails open/closed per Phase 12 §34) | Automatic on provider recovery |
| Bad migration | 0 if caught before app traffic resumes | Minutes (re-run or restore pre-migration backup) |
| Application data corruption | Depends on detection lag, not infra RPO | Hours (scope + fix + targeted correction or PITR) |
| TLS/DNS issues | N/A (no data loss) | Provider-dependent, usually minutes once the root cause is fixed |

Every "RTO" above is an estimate, not a measurement — see the restore
-verification status at the top of this document.
