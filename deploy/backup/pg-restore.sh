#!/usr/bin/env bash
###############################################################################
# Growth Agent — restore a logical backup produced by pg-backup.sh.
#
# TEST THIS QUARTERLY against a scratch database (docs/SECURITY.md §13).
#
#   RESTORE_URL=postgresql://…/growth_agent_restore \
#   ./deploy/backup/pg-restore.sh s3://growth-agent-backups/postgres/2026/09/growth-agent-20260908T120000Z.dump
#
# For a production recovery: provision a fresh empty database, restore into it,
# run `pnpm --filter @growth-agent/db migrate:deploy` to confirm the schema is
# at head, then repoint DATABASE_URL / DIRECT_URL and redeploy.
###############################################################################
set -euo pipefail

SRC="${1:?usage: pg-restore.sh <s3-uri-or-local-file>}"
: "${RESTORE_URL:?RESTORE_URL is required (never restore over a live DB)}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

FILE="$WORKDIR/$(basename "$SRC")"
if [[ "$SRC" == s3://* || "$SRC" == */* && ! -f "$SRC" ]]; then
  echo "[restore] downloading $SRC"
  if command -v aws >/dev/null; then
    aws s3 cp "$SRC" "$FILE" ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"}
    aws s3 cp "${SRC}.sha256" "${FILE}.sha256" ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} || true
  else
    mc cp "$SRC" "$FILE"
  fi
else
  cp "$SRC" "$FILE"
fi

if [[ -f "${FILE}.sha256" ]]; then
  echo "[restore] verifying checksum"
  (cd "$WORKDIR" && sha256sum -c "$(basename "$FILE").sha256")
fi

if [[ "$FILE" == *.gpg ]]; then
  echo "[restore] decrypting"
  gpg --yes --batch --decrypt "$FILE" > "${FILE%.gpg}"
  FILE="${FILE%.gpg}"
fi

echo "[restore] pg_restore → ${RESTORE_URL%%\?*}  (this may take a while)"
pg_restore --clean --if-exists --no-owner --no-privileges --jobs=4 \
  --dbname="$RESTORE_URL" "$FILE"

echo "[restore] done. Now run: pnpm --filter @growth-agent/db migrate:deploy"
