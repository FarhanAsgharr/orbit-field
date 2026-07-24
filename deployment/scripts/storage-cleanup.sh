#!/usr/bin/env bash
#
# Object storage housekeeping.
#
# Removes abandoned upload chunks. Only touches the .chunks prefix — final
# attachment objects are referenced by database rows and must never be swept by
# a script that cannot see those rows.
set -euo pipefail

STORAGE_PATH="${STORAGE_LOCAL_PATH:-/var/lib/orbit/storage}"
AGE_HOURS="${CHUNK_MAX_AGE_HOURS:-72}"

CHUNKS="${STORAGE_PATH}/.chunks"
[ -d "${CHUNKS}" ] || { echo "[cleanup] no chunk directory at ${CHUNKS}"; exit 0; }

BEFORE=$(du -sh "${CHUNKS}" 2>/dev/null | cut -f1 || echo "0")
echo "[cleanup] chunk directory is ${BEFORE} before cleanup"

# Matches UPLOAD_SESSION_TTL_HOURS: anything older cannot belong to a session
# the server would still accept chunks for.
find "${CHUNKS}" -type f -name '*.part' -mmin "+$((AGE_HOURS * 60))" -delete
find "${CHUNKS}" -type d -empty -delete

AFTER=$(du -sh "${CHUNKS}" 2>/dev/null | cut -f1 || echo "0")
echo "[cleanup] chunk directory is ${AFTER} after cleanup"
