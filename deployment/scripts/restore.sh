#!/usr/bin/env bash
#
# PostgreSQL restore.
#
# Destructive by nature, so it refuses to run without an explicit confirmation
# and prints exactly what it is about to overwrite. A restore script that runs
# on a typo is worse than no restore script.
#
# Usage: restore.sh <archive> [--force]
set -euo pipefail

ARCHIVE="${1:?Usage: restore.sh <archive> [--force]}"
FORCE="${2:-}"

: "${DATABASE_URL:?DATABASE_URL must be set}"

[ -f "${ARCHIVE}" ] || { echo "Archive not found: ${ARCHIVE}" >&2; exit 1; }

echo "[restore] verifying archive"
pg_restore --list "${ARCHIVE}" > /dev/null || { echo "Archive is unreadable" >&2; exit 1; }

TABLES=$(pg_restore --list "${ARCHIVE}" | grep -c 'TABLE DATA' || true)
TARGET=$(echo "${DATABASE_URL}" | sed -E 's#.*/([^?]+).*#\1#')

echo ""
echo "  Archive : ${ARCHIVE}"
echo "  Tables  : ${TABLES}"
echo "  Target  : ${TARGET}"
echo ""
echo "  This REPLACES all data in the target database."
echo ""

if [ "${FORCE}" != "--force" ]; then
  read -r -p "Type the database name to confirm: " CONFIRM
  [ "${CONFIRM}" = "${TARGET}" ] || { echo "Aborted."; exit 1; }
fi

echo "[restore] restoring"
# --clean --if-exists drops objects first so a restore over a populated database
# does not fail on every constraint. Single transaction: a partial restore is
# worse than none, because nobody can tell which half is missing.
pg_restore --dbname="${DATABASE_URL}" \
           --clean --if-exists \
           --no-owner --no-privileges \
           --single-transaction \
           --exit-on-error \
           "${ARCHIVE}"

echo "[restore] complete. Run migrations to bring the schema forward:"
echo "  npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma"
