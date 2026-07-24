#!/usr/bin/env bash
#
# PostgreSQL backup.
#
# Custom format (-Fc), not plain SQL: it compresses, restores selectively, and
# `pg_restore -l` can list contents without extracting — which is how you verify
# a backup is real rather than a zero-byte file that has been "succeeding"
# nightly for six months.
#
# Usage: backup.sh [destination-dir]
set -euo pipefail

DEST="${1:-${BACKUP_DIR:-/var/backups/orbit}}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${DEST}/orbit-${STAMP}.dump"

: "${DATABASE_URL:?DATABASE_URL must be set}"

mkdir -p "${DEST}"

echo "[backup] dumping to ${ARCHIVE}"
pg_dump --dbname="${DATABASE_URL}" \
        --format=custom \
        --compress=9 \
        --no-owner \
        --no-privileges \
        --file="${ARCHIVE}"

# A dump that cannot be listed is not a backup. Verified before anything is
# pruned, so a corrupt run never causes a good backup to be deleted.
echo "[backup] verifying archive"
if ! pg_restore --list "${ARCHIVE}" > /dev/null 2>&1; then
  echo "[backup] ERROR: archive failed verification, removing" >&2
  rm -f "${ARCHIVE}"
  exit 1
fi

TABLES=$(pg_restore --list "${ARCHIVE}" | grep -c 'TABLE DATA' || true)
SIZE=$(du -h "${ARCHIVE}" | cut -f1)
echo "[backup] verified: ${TABLES} tables, ${SIZE}"

if [ "${TABLES}" -lt 10 ]; then
  echo "[backup] ERROR: only ${TABLES} tables captured — expected at least 10" >&2
  exit 1
fi

# Optional off-host copy. A backup on the same disk as the database protects
# against nothing that actually happens.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup] uploading to s3://${BACKUP_S3_BUCKET}/"
  aws s3 cp "${ARCHIVE}" "s3://${BACKUP_S3_BUCKET}/$(basename "${ARCHIVE}")" --only-show-errors
fi

echo "[backup] pruning archives older than ${RETENTION_DAYS} days"
find "${DEST}" -name 'orbit-*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete

echo "[backup] complete: ${ARCHIVE}"
