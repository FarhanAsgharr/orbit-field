/**
 * Server change → local row projection.
 *
 * The wire format is the server's camelCase row; SQLite uses snake_case. This
 * module owns that mapping in one place so a schema addition is a single edit
 * rather than a hunt through the engine.
 *
 * Writes are generated rather than hand-written per entity: a column list plus
 * a value coercion is enough, and hand-written upserts for eleven tables is
 * where drift and typos live.
 */

import { SyncEntity, type JsonValue } from '@orbit/types';
import type { Database, SqlValue } from '../db/database';

const TABLE_BY_ENTITY: Partial<Record<SyncEntity, string>> = {
  [SyncEntity.ORGANIZATION]: 'organizations',
  [SyncEntity.USER]: 'users',
  [SyncEntity.CLIENT]: 'clients',
  [SyncEntity.PROJECT]: 'projects',
  [SyncEntity.SITE]: 'sites',
  [SyncEntity.ASSET]: 'assets',
  [SyncEntity.TEMPLATE_VERSION]: 'template_versions',
  [SyncEntity.INSPECTION]: 'inspections',
  [SyncEntity.RESPONSE]: 'inspection_responses',
  [SyncEntity.ATTACHMENT]: 'attachments',
  [SyncEntity.SIGNATURE]: 'signatures',
  [SyncEntity.NOTIFICATION]: 'notifications',
};

/**
 * Columns each table accepts from the wire.
 *
 * An explicit allowlist, not "whatever the server sent": a new server column
 * would otherwise produce an `no such column` failure that aborts the entire
 * pull transaction and strands the device. Unknown keys are ignored instead,
 * so an older app keeps syncing against a newer server.
 */
const COLUMNS: Record<string, string[]> = {
  organizations: ['name', 'slug', 'logoUrl', 'timezone', 'locale', 'currency', 'settings'],
  users: ['orgId', 'email', 'firstName', 'lastName', 'avatarUrl', 'role', 'department', 'jobTitle', 'status'],
  clients: ['orgId', 'name', 'code', 'contactName', 'contactEmail', 'contactPhone', 'address', 'logoUrl', 'isActive'],
  projects: ['orgId', 'clientId', 'name', 'code', 'description', 'managerId', 'isActive'],
  sites: ['orgId', 'projectId', 'clientId', 'name', 'code', 'address', 'latitude', 'longitude', 'geofenceRadiusMeters', 'contactName', 'contactPhone', 'isActive'],
  assets: ['orgId', 'siteId', 'parentAssetId', 'name', 'tag', 'category', 'manufacturer', 'model', 'serialNumber', 'installedAt', 'latitude', 'longitude', 'metadata', 'isActive'],
  template_versions: ['orgId', 'templateId', 'name', 'description', 'category', 'discipline', 'version', 'definition', 'scoring', 'requiredSignatures', 'publishedAt'],
  inspections: [
    'orgId', 'number', 'templateId', 'templateVersionId', 'projectId', 'clientId', 'siteId', 'assetId',
    'title', 'status', 'outcome', 'priority', 'category', 'department', 'assignedToId', 'createdById',
    'startedAt', 'scheduledFor', 'dueAt', 'completedAt', 'submittedAt', 'startLocation', 'endLocation',
    'distanceFromSiteMeters', 'notes', 'tags', 'score', 'totalFields', 'answeredFields', 'failedFields',
    'criticalFailures', 'isArchived',
  ],
  inspection_responses: [
    'orgId', 'inspectionId', 'sectionId', 'fieldId', 'repeatIndex', 'value', 'comment',
    'score', 'isFailure', 'isNotApplicable', 'location', 'answeredAt', 'answeredById',
  ],
  attachments: [
    'orgId', 'inspectionId', 'responseId', 'kind', 'state', 'fileName', 'mimeType', 'sizeBytes',
    'checksum', 'width', 'height', 'durationMs', 'storageKey', 'location', 'capturedAt',
    'caption', 'pairTag', 'annotations', 'uploadedAt',
  ],
  signatures: ['orgId', 'inspectionId', 'role', 'signerName', 'signerTitle', 'signerEmail', 'attachmentId', 'strokes', 'signedAt', 'location', 'declaration'],
  notifications: ['orgId', 'userId', 'topic', 'title', 'body', 'data', 'deepLink', 'readAt'],
};

/** Columns that must never be taken from a pull, because the device owns them. */
const DEVICE_OWNED = new Set(['local_uri', 'thumbnail_uri', 'upload_id', 'received_chunks', 'uploaded_bytes', 'is_dirty', 'base_snapshot']);

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Coerce a JSON value into something SQLite can bind. */
function bind(value: JsonValue | undefined): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  // Objects and arrays (locations, tags, template definitions) are stored as
  // JSON text and parsed at the repository boundary.
  return JSON.stringify(value);
}

export const applyChange = {
  tableFor(entity: SyncEntity): string | null {
    return TABLE_BY_ENTITY[entity] ?? null;
  },

  /**
   * Insert or update a replicated row.
   *
   * `ON CONFLICT DO UPDATE` rather than delete-then-insert: the row may be
   * referenced by local foreign keys (responses → inspection), and a delete
   * would cascade them away before the reinsert.
   */
  upsert(
    db: Database,
    entity: SyncEntity,
    id: string,
    data: Record<string, JsonValue>,
    version: number,
    cursor: number,
  ): void {
    const table = TABLE_BY_ENTITY[entity];
    if (!table) return;

    const allowed = COLUMNS[table] ?? [];
    const columns: string[] = ['id'];
    const values: SqlValue[] = [id];

    for (const key of allowed) {
      if (!(key in data)) continue;
      const column = snake(key);
      if (DEVICE_OWNED.has(column)) continue;
      columns.push(column);
      values.push(bind(data[key]));
    }

    // Sync bookkeeping is always written, regardless of what the payload held.
    columns.push('version', 'sync_cursor', 'created_at', 'updated_at', 'deleted_at', 'is_dirty');
    values.push(
      version,
      cursor,
      bind(data.createdAt) ?? new Date().toISOString(),
      bind(data.updatedAt) ?? new Date().toISOString(),
      bind(data.deletedAt),
      0,
    );

    const placeholders = columns.map(() => '?').join(', ');
    const updates = columns
      .filter((c) => c !== 'id')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');

    db.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
      values,
    );
  },

  /**
   * Apply a tombstone.
   *
   * Soft delete, mirroring the server: a hard delete would cascade away local
   * attachments whose files may not have finished uploading.
   */
  remove(db: Database, entity: SyncEntity, id: string): void {
    const table = TABLE_BY_ENTITY[entity];
    if (!table) return;
    db.run(
      `UPDATE ${table} SET deleted_at = ?, is_dirty = 0 WHERE id = ? AND is_dirty = 0`,
      [new Date().toISOString(), id],
    );
  },
};

export { TABLE_BY_ENTITY };
