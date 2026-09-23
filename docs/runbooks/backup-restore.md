# Runbook: Backup restore

**When to use:** genuine data loss/corruption requiring a restore from
backup (not a transient outage — see `database-failure.md` for that
first; only escalate here if the database itself needs its data restored,
not just reconnected to).

**Read `docs/DISASTER-RECOVERY.md` first** — it has the authoritative
RPO/RTO reasoning and the honest status of this exact procedure: **no live
restore drill has ever been executed in this project.** `pg-restore.sh`
(`deploy/backup/pg-restore.sh`) is a real, reviewed script — checksum
verification → decrypt → `pg_restore --clean --if-exists` into a scratch
database, never the live one directly — but it is unverified end-to-end.
Treat this runbook as the best current procedure, not a proven one.

## Symptoms

Confirmed data corruption or loss (not a connectivity issue); a decision
to restore to a point in time before a bad migration or a confirmed
security incident.

## Diagnosis

1. Confirm this really needs a restore, not a targeted correction — a
   narrow, well-understood corruption is often better fixed with a
   reviewed SQL correction script than a full restore, which rolls back
   *every* legitimate write since the backup too
   (`docs/DISASTER-RECOVERY.md` scenario 5).
2. Identify the target restore point: the managed Postgres provider's
   continuous point-in-time recovery (seconds-to-minutes granularity) vs.
   the portable `pg-backup.sh` dump (whatever interval it runs on).

## Commands / tools

```bash
# Restore into a NEW, scratch database — never overwrite the live one directly.
./deploy/backup/pg-restore.sh <backup-file> <scratch-db-connection-string>
```

Then: verify the restored schema and data look correct in the scratch
database *before* repointing anything at it.

## Mitigation / recovery procedure

1. Provision or identify a scratch Postgres instance.
2. Run `pg-restore.sh` against it with the chosen backup.
3. Verify: run `prisma migrate status` (or equivalent) against the
   restored database to confirm migration history is intact; spot-check
   a few known rows/tables for sanity.
4. Repoint `DATABASE_URL`/`DIRECT_URL` at the restored database (or
   restore *into* the original instance via the provider's own PITR
   feature if using that path instead of the portable dump).
5. Redeploy `web` and `worker` against the restored database.

## Verification

- `/api/health` database check is `ok`.
- A real sign-in works.
- Spot-check that no *newer*, legitimate data was lost beyond the known,
  documented RPO window.

## Escalation

SEV-1 — a restore is always a significant event. Involve whoever owns
the decision to accept the RPO's data-loss window before proceeding.

## Post-incident

**Run this procedure for real, once, in a non-production environment,
before ever needing it for real** — this is the single most important
open item in `docs/DISASTER-RECOVERY.md`'s risk register (`RISK-DR-1`).
Record the actual elapsed time; it turns the RTO estimate in
`docs/DEPLOYMENT.md` §18 from a guess into a measurement.
