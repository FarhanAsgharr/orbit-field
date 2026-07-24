/**
 * On-device SQLite schema.
 *
 * Three principles:
 *
 *  1. The device is a full replica, not a cache. Every screen reads from SQLite
 *     and never from the network, so the app behaves identically at full signal
 *     and at zero. There is no "offline mode" to fall into — offline is the
 *     only mode, and sync is a background reconciliation process.
 *
 *  2. Server state and local intent are separated. `base_snapshot` holds the
 *     last acknowledged server truth for a row; the row's own columns hold what
 *     the user currently sees. That separation is what makes a three-way merge
 *     possible after a conflict, and what lets a failed push be retried without
 *     re-deriving what the user changed.
 *
 *  3. The outbox is the source of truth for *intent*. Nothing is removed from it
 *     until the server acknowledges the operation, so a crash, a force-quit, or
 *     a battery pull at any instant loses no work.
 */

export const SCHEMA_VERSION = 1;

/**
 * Each migration is applied exactly once, in order, inside a transaction.
 * Never edit a shipped migration — append a new one. A device that installed
 * three versions ago must be able to walk the same path forward.
 */
export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/** Columns every replicated table carries, mirroring the server's SyncableRecord. */
const SYNC_COLUMNS = `
  version      INTEGER NOT NULL DEFAULT 1,
  sync_cursor  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT,
  -- Last server-acknowledged snapshot, as JSON. The three-way merge ancestor.
  base_snapshot TEXT,
  -- 1 while the row has local edits the server has not yet acknowledged.
  is_dirty     INTEGER NOT NULL DEFAULT 0,
  -- 1 while the row is blocked awaiting conflict resolution.
  has_conflict INTEGER NOT NULL DEFAULT 0
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
         key   TEXT PRIMARY KEY NOT NULL,
         value TEXT
       );`,

      // --- replicated reference data -------------------------------------
      `CREATE TABLE IF NOT EXISTS organizations (
         id       TEXT PRIMARY KEY NOT NULL,
         name     TEXT NOT NULL,
         slug     TEXT NOT NULL,
         logo_url TEXT,
         timezone TEXT NOT NULL DEFAULT 'UTC',
         locale   TEXT NOT NULL DEFAULT 'en',
         currency TEXT NOT NULL DEFAULT 'USD',
         settings TEXT NOT NULL DEFAULT '{}',
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS users (
         id         TEXT PRIMARY KEY NOT NULL,
         org_id     TEXT NOT NULL,
         email      TEXT NOT NULL,
         first_name TEXT NOT NULL,
         last_name  TEXT NOT NULL,
         avatar_url TEXT,
         role       TEXT NOT NULL,
         department TEXT,
         job_title  TEXT,
         status     TEXT NOT NULL DEFAULT 'ACTIVE',
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS clients (
         id            TEXT PRIMARY KEY NOT NULL,
         org_id        TEXT NOT NULL,
         name          TEXT NOT NULL,
         code          TEXT,
         contact_name  TEXT,
         contact_email TEXT,
         contact_phone TEXT,
         address       TEXT,
         logo_url      TEXT,
         is_active     INTEGER NOT NULL DEFAULT 1,
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS projects (
         id          TEXT PRIMARY KEY NOT NULL,
         org_id      TEXT NOT NULL,
         client_id   TEXT,
         name        TEXT NOT NULL,
         code        TEXT NOT NULL,
         description TEXT,
         manager_id  TEXT,
         is_active   INTEGER NOT NULL DEFAULT 1,
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS sites (
         id           TEXT PRIMARY KEY NOT NULL,
         org_id       TEXT NOT NULL,
         project_id   TEXT,
         client_id    TEXT,
         name         TEXT NOT NULL,
         code         TEXT,
         address      TEXT,
         latitude     REAL,
         longitude    REAL,
         geofence_radius_meters INTEGER,
         contact_name  TEXT,
         contact_phone TEXT,
         is_active    INTEGER NOT NULL DEFAULT 1,
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS assets (
         id              TEXT PRIMARY KEY NOT NULL,
         org_id          TEXT NOT NULL,
         site_id         TEXT,
         parent_asset_id TEXT,
         name            TEXT NOT NULL,
         tag             TEXT NOT NULL,
         category        TEXT,
         manufacturer    TEXT,
         model           TEXT,
         serial_number   TEXT,
         installed_at    TEXT,
         latitude        REAL,
         longitude       REAL,
         metadata        TEXT NOT NULL DEFAULT '{}',
         is_active       INTEGER NOT NULL DEFAULT 1,
         ${SYNC_COLUMNS}
       );`,

      // Templates are stored whole: the section/field tree is one JSON blob,
      // read and written atomically, exactly as the server ships it.
      `CREATE TABLE IF NOT EXISTS template_versions (
         id           TEXT PRIMARY KEY NOT NULL,
         org_id       TEXT NOT NULL,
         template_id  TEXT NOT NULL,
         name         TEXT NOT NULL,
         description  TEXT,
         category     TEXT,
         discipline   TEXT,
         version      INTEGER NOT NULL,
         definition   TEXT NOT NULL,
         scoring      TEXT NOT NULL DEFAULT '{}',
         required_signatures TEXT NOT NULL DEFAULT '[]',
         published_at TEXT,
         sync_cursor  INTEGER NOT NULL DEFAULT 0,
         created_at   TEXT NOT NULL,
         updated_at   TEXT NOT NULL,
         deleted_at   TEXT
       );`,

      // --- inspection data -----------------------------------------------
      `CREATE TABLE IF NOT EXISTS inspections (
         id                  TEXT PRIMARY KEY NOT NULL,
         org_id              TEXT NOT NULL,
         number              TEXT NOT NULL,
         template_id         TEXT NOT NULL,
         template_version_id TEXT NOT NULL,
         project_id          TEXT,
         client_id           TEXT,
         site_id             TEXT,
         asset_id            TEXT,
         title               TEXT NOT NULL,
         status              TEXT NOT NULL DEFAULT 'DRAFT',
         outcome             TEXT NOT NULL DEFAULT 'PENDING',
         priority            TEXT NOT NULL DEFAULT 'NORMAL',
         category            TEXT,
         department          TEXT,
         assigned_to_id      TEXT,
         created_by_id       TEXT,
         started_at          TEXT,
         scheduled_for       TEXT,
         due_at              TEXT,
         completed_at        TEXT,
         submitted_at        TEXT,
         start_location      TEXT,
         end_location        TEXT,
         distance_from_site_meters REAL,
         notes               TEXT,
         tags                TEXT NOT NULL DEFAULT '[]',
         score               REAL,
         total_fields        INTEGER NOT NULL DEFAULT 0,
         answered_fields     INTEGER NOT NULL DEFAULT 0,
         failed_fields       INTEGER NOT NULL DEFAULT 0,
         critical_failures   INTEGER NOT NULL DEFAULT 0,
         is_archived         INTEGER NOT NULL DEFAULT 0,
         -- 1 until the server assigns the real, human-facing number.
         is_provisional_number INTEGER NOT NULL DEFAULT 0,
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS inspection_responses (
         id            TEXT PRIMARY KEY NOT NULL,
         org_id        TEXT NOT NULL,
         inspection_id TEXT NOT NULL,
         section_id    TEXT NOT NULL,
         field_id      TEXT NOT NULL,
         repeat_index  INTEGER NOT NULL DEFAULT 0,
         value         TEXT,
         comment       TEXT,
         score         REAL,
         is_failure    INTEGER NOT NULL DEFAULT 0,
         is_not_applicable INTEGER NOT NULL DEFAULT 0,
         location      TEXT,
         answered_at   TEXT,
         answered_by_id TEXT,
         ${SYNC_COLUMNS},
         FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE
       );`,

      // The unique key mirrors the server's, so an upsert on either side lands
      // on the same row and a replayed operation is naturally idempotent.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_response_unique
         ON inspection_responses(inspection_id, field_id, repeat_index);`,

      `CREATE TABLE IF NOT EXISTS attachments (
         id            TEXT PRIMARY KEY NOT NULL,
         org_id        TEXT NOT NULL,
         inspection_id TEXT,
         response_id   TEXT,
         kind          TEXT NOT NULL,
         state         TEXT NOT NULL DEFAULT 'LOCAL_ONLY',
         file_name     TEXT NOT NULL,
         mime_type     TEXT NOT NULL,
         size_bytes    INTEGER NOT NULL DEFAULT 0,
         checksum      TEXT NOT NULL,
         width         INTEGER,
         height        INTEGER,
         duration_ms   INTEGER,
         -- Absolute path on the device. Null once evicted under storage pressure.
         local_uri     TEXT,
         thumbnail_uri TEXT,
         storage_key   TEXT,
         location      TEXT,
         captured_at   TEXT,
         caption       TEXT,
         pair_tag      TEXT,
         annotations   TEXT,
         uploaded_at   TEXT,
         upload_attempts INTEGER NOT NULL DEFAULT 0,
         -- Resume point: bytes the server has durably confirmed.
         uploaded_bytes  INTEGER NOT NULL DEFAULT 0,
         upload_id       TEXT,
         received_chunks TEXT NOT NULL DEFAULT '[]',
         last_upload_error TEXT,
         ${SYNC_COLUMNS}
       );`,

      `CREATE TABLE IF NOT EXISTS signatures (
         id            TEXT PRIMARY KEY NOT NULL,
         org_id        TEXT NOT NULL,
         inspection_id TEXT NOT NULL,
         role          TEXT NOT NULL,
         signer_name   TEXT NOT NULL,
         signer_title  TEXT,
         signer_email  TEXT,
         attachment_id TEXT,
         strokes       TEXT,
         signed_at     TEXT NOT NULL,
         location      TEXT,
         declaration   TEXT,
         ${SYNC_COLUMNS},
         FOREIGN KEY (inspection_id) REFERENCES inspections(id) ON DELETE CASCADE
       );`,

      // --- sync machinery --------------------------------------------------
      `CREATE TABLE IF NOT EXISTS outbox (
         id              TEXT PRIMARY KEY NOT NULL,
         entity          TEXT NOT NULL,
         operation       TEXT NOT NULL,
         entity_id       TEXT NOT NULL,
         patch           TEXT NOT NULL,
         base_version    INTEGER,
         depends_on      TEXT NOT NULL DEFAULT '[]',
         client_timestamp TEXT NOT NULL,
         lamport         INTEGER NOT NULL,
         device_id       TEXT NOT NULL,
         user_id         TEXT NOT NULL,
         state           TEXT NOT NULL DEFAULT 'PENDING',
         attempts        INTEGER NOT NULL DEFAULT 0,
         next_attempt_at INTEGER,
         last_error      TEXT,
         last_error_code TEXT,
         created_at      TEXT NOT NULL,
         updated_at      TEXT NOT NULL
       );`,

      // The drain query: pending work whose backoff has elapsed, in causal order.
      `CREATE INDEX IF NOT EXISTS idx_outbox_drain
         ON outbox(state, next_attempt_at, lamport);`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_entity ON outbox(entity_id);`,

      `CREATE TABLE IF NOT EXISTS conflicts (
         operation_id   TEXT PRIMARY KEY NOT NULL,
         entity         TEXT NOT NULL,
         entity_id      TEXT NOT NULL,
         base_version   INTEGER,
         server_version INTEGER NOT NULL,
         local_record   TEXT NOT NULL,
         server_record  TEXT NOT NULL,
         diffs          TEXT NOT NULL,
         is_auto_resolvable INTEGER NOT NULL DEFAULT 0,
         server_updated_at  TEXT,
         server_updated_by  TEXT,
         detected_at    TEXT NOT NULL,
         resolved_at    TEXT,
         resolution     TEXT
       );`,

      `CREATE TABLE IF NOT EXISTS sync_log (
         id          TEXT PRIMARY KEY NOT NULL,
         started_at  TEXT NOT NULL,
         finished_at TEXT,
         trigger     TEXT NOT NULL,
         pushed_count   INTEGER NOT NULL DEFAULT 0,
         pulled_count   INTEGER NOT NULL DEFAULT 0,
         conflict_count INTEGER NOT NULL DEFAULT 0,
         uploaded_count INTEGER NOT NULL DEFAULT 0,
         bytes_up    INTEGER NOT NULL DEFAULT 0,
         bytes_down  INTEGER NOT NULL DEFAULT 0,
         duration_ms INTEGER,
         outcome     TEXT,
         error       TEXT
       );`,

      `CREATE TABLE IF NOT EXISTS notifications (
         id        TEXT PRIMARY KEY NOT NULL,
         org_id    TEXT NOT NULL,
         user_id   TEXT NOT NULL,
         topic     TEXT NOT NULL,
         title     TEXT NOT NULL,
         body      TEXT NOT NULL,
         data      TEXT NOT NULL DEFAULT '{}',
         deep_link TEXT,
         read_at   TEXT,
         created_at TEXT NOT NULL,
         sync_cursor INTEGER NOT NULL DEFAULT 0
       );`,

      // --- read-path indexes ------------------------------------------------
      // Mirrors the dominant list query: my open work, most recent first.
      `CREATE INDEX IF NOT EXISTS idx_inspections_assignee
         ON inspections(assigned_to_id, status, updated_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_inspections_status
         ON inspections(status, due_at);`,
      `CREATE INDEX IF NOT EXISTS idx_inspections_dirty
         ON inspections(is_dirty) WHERE is_dirty = 1;`,
      `CREATE INDEX IF NOT EXISTS idx_responses_inspection
         ON inspection_responses(inspection_id);`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_inspection
         ON attachments(inspection_id);`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_pending
         ON attachments(state) WHERE state IN ('QUEUED','UPLOADING','FAILED');`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_unread
         ON notifications(user_id, read_at, created_at DESC);`,
    ],
  },
];

/** Pragmas applied on every connection open, not inside a migration. */
export const CONNECTION_PRAGMAS: string[] = [
  // WAL lets the UI keep reading while the sync engine writes — without it,
  // a large delta pull visibly freezes the inspection list.
  'PRAGMA journal_mode = WAL;',
  // NORMAL under WAL: a power loss can cost the last transaction but never
  // corrupts the file. The outbox makes a lost transaction re-derivable.
  'PRAGMA synchronous = NORMAL;',
  'PRAGMA foreign_keys = ON;',
  'PRAGMA busy_timeout = 5000;',
  'PRAGMA temp_store = MEMORY;',
  'PRAGMA cache_size = -8000;',
];

export const META_KEYS = {
  SCHEMA_VERSION: 'schema_version',
  SYNC_CURSOR: 'sync_cursor',
  LAMPORT: 'lamport',
  DEVICE_ID: 'device_id',
  USER_ID: 'user_id',
  ORG_ID: 'org_id',
  LAST_SYNC_AT: 'last_sync_at',
  LAST_FULL_RESYNC_AT: 'last_full_resync_at',
} as const;
