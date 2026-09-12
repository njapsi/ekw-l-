#!/usr/bin/env bash
###############################################################################
# Growth Agent — PostgreSQL logical backup → object storage.
#
# Run from cron (or a k8s CronJob) on a host with `pg_dump` (v16), `gzip`, and
# an S3 client (`aws` or MinIO `mc`). Managed Postgres providers (Neon, RDS,
# Cloud SQL) ALSO take their own automated snapshots + PITR — this is a
# portable, provider-independent second copy you can restore anywhere.
#
#   env: DIRECT_URL            unpooled connection string (required)
#        BACKUP_S3_BUCKET       e.g. s3://growth-agent-backups   (required)
#        BACKUP_S3_ENDPOINT     optional (R2 / MinIO)
#        BACKUP_RETENTION_DAYS  default 30
#        BACKUP_GPG_RECIPIENT   required — encrypts the dump with this key.
#                                A database dump is the full tenant dataset
#                                (PII, OAuth-token ciphertext, everything) —
#                                it does not leave this host unencrypted
#                                (docs/SECURITY.md's "backups encrypted"
#                                claim is enforced here, not just documented).
#
#   0 */6 * * *  /opt/growth-agent/deploy/backup/pg-backup.sh   # every 6h
###############################################################################
set -euo pipefail

: "${DIRECT_URL:?DIRECT_URL is required}"
: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required, e.g. s3://growth-agent-backups}"
: "${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT is required — backups are never uploaded unencrypted}"
RETENTION="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

FILE="$WORKDIR/growth-agent-${STAMP}.dump"

echo "[backup] pg_dump → ${FILE}"
# Custom format (-Fc) so pg_restore can do selective / parallel restores.
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$DIRECT_URL"

echo "[backup] encrypting for ${BACKUP_GPG_RECIPIENT}"
gpg --yes --batch --encrypt --recipient "$BACKUP_GPG_RECIPIENT" "$FILE"
FILE="${FILE}.gpg"

SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"
echo "$SHA  $(basename "$FILE")" > "${FILE}.sha256"

s3() {
  if command -v aws >/dev/null; then
    aws s3 "$@" ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
  else
    mc "$@"
  fi
}

DEST="${BACKUP_S3_BUCKET%/}/postgres/$(date -u +%Y/%m)/"
echo "[backup] uploading to ${DEST}"
s3 cp "$FILE" "$DEST"
s3 cp "${FILE}.sha256" "$DEST"

# Retention: delete objects older than RETENTION days under postgres/. Both
# branches must actually prune — this previously only ran for the `aws` CLI,
# silently never pruning anything on a MinIO (`mc`) host.
if command -v aws >/dev/null; then
  CUTOFF="$(date -u -d "-${RETENTION} days" +%s 2>/dev/null || date -u -v-"${RETENTION}"d +%s)"
  aws s3 ls "${BACKUP_S3_BUCKET%/}/postgres/" --recursive \
    ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} \
  | while read -r d t _ key; do
      ts="$(date -u -d "$d $t" +%s 2>/dev/null || echo 0)"
      if [[ "$ts" -gt 0 && "$ts" -lt "$CUTOFF" ]]; then
        echo "[backup] pruning $key"
        aws s3 rm "${BACKUP_S3_BUCKET%/}/$key" \
          ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} || true
      fi
    done
else
  echo "[backup] pruning objects older than ${RETENTION}d via mc"
  mc rm --recursive --force --older-than "${RETENTION}d" "${BACKUP_S3_BUCKET%/}/postgres/" || true
fi

echo "[backup] done: ${DEST}$(basename "$FILE")  sha256=${SHA}"
