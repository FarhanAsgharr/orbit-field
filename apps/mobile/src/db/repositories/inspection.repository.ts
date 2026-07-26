/**
 * Inspection repository.
 *
 * The single rule this file exists to enforce: **a mutation writes the row and
 * the outbox entry in one transaction, or it does not happen at all.** Every
 * public method that changes data goes through `db.write`. If you add a method
 * here that touches a row without enqueuing intent, an inspector's work will
 * silently fail to reach the server.
 *
 * Reads never touch the network. The screens are built on the assumption that
 * this repository always answers, at full signal or none.
 */

import {
  type GeoPoint,
  type Inspection,
  type InspectionListItem,
  type InspectionOutcome,
  InspectionStatus,
  type JsonValue,
  type Priority,
  SyncEntity,
  SyncOperation,
} from '@orbit/types';
import { provisionalInspectionNumber, toDisplayString, ulid } from '@orbit/utils';

import type { Outbox } from '../../sync/outbox';
import type { Database, SqlValue } from '../database';

/** Raw SQLite row shape. snake_case, JSON columns still encoded. */
interface InspectionRow {
  id: string;
  org_id: string;
  number: string;
  template_id: string;
  template_version_id: string;
  project_id: string | null;
  client_id: string | null;
  site_id: string | null;
  asset_id: string | null;
  title: string;
  status: string;
  outcome: string;
  priority: string;
  category: string | null;
  department: string | null;
  assigned_to_id: string | null;
  created_by_id: string | null;
  started_at: string | null;
  scheduled_for: string | null;
  due_at: string | null;
  completed_at: string | null;
  submitted_at: string | null;
  start_location: string | null;
  end_location: string | null;
  distance_from_site_meters: number | null;
  notes: string | null;
  tags: string;
  score: number | null;
  total_fields: number;
  answered_fields: number;
  failed_fields: number;
  critical_failures: number;
  is_archived: number;
  is_provisional_number: number;
  version: number;
  sync_cursor: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  base_snapshot: string | null;
  is_dirty: number;
  has_conflict: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt JSON column must not crash the inspection list. Falling back
    // loses one field rather than the whole screen.
    return fallback;
  }
}

function toInspection(row: InspectionRow): Inspection {
  return {
    id: row.id as Inspection['id'],
    orgId: row.org_id as Inspection['orgId'],
    number: row.number,
    templateId: row.template_id as Inspection['templateId'],
    templateVersionId: row.template_version_id as Inspection['templateVersionId'],
    projectId: row.project_id as Inspection['projectId'],
    clientId: row.client_id as Inspection['clientId'],
    siteId: row.site_id as Inspection['siteId'],
    assetId: row.asset_id as Inspection['assetId'],
    title: row.title,
    status: row.status as InspectionStatus,
    outcome: row.outcome as InspectionOutcome,
    priority: row.priority as Priority,
    category: row.category,
    department: row.department,
    assignedToId: row.assigned_to_id as Inspection['assignedToId'],
    startedAt: row.started_at as Inspection['startedAt'],
    scheduledFor: row.scheduled_for as Inspection['scheduledFor'],
    dueAt: row.due_at as Inspection['dueAt'],
    completedAt: row.completed_at as Inspection['completedAt'],
    submittedAt: row.submitted_at as Inspection['submittedAt'],
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    startLocation: parseJson<GeoPoint | null>(row.start_location, null),
    endLocation: parseJson<GeoPoint | null>(row.end_location, null),
    distanceFromSiteMeters: row.distance_from_site_meters,
    notes: row.notes,
    tags: parseJson<string[]>(row.tags, []),
    score: row.score,
    totalFields: row.total_fields,
    answeredFields: row.answered_fields,
    failedFields: row.failed_fields,
    criticalFailures: row.critical_failures,
    isArchived: row.is_archived === 1,
    duplicatedFromId: null,
    version: row.version as Inspection['version'],
    syncCursor: row.sync_cursor as Inspection['syncCursor'],
    createdAt: row.created_at as Inspection['createdAt'],
    updatedAt: row.updated_at as Inspection['updatedAt'],
    deletedAt: row.deleted_at as Inspection['deletedAt'],
    lastWriterDeviceId: null,
    lastWriterUserId: null,
  };
}

export interface InspectionFilter {
  search?: string;
  status?: InspectionStatus[];
  priority?: Priority[];
  assignedToId?: string;
  siteId?: string;
  clientId?: string;
  projectId?: string;
  templateId?: string;
  tags?: string[];
  dueBefore?: string;
  dueAfter?: string;
  /** Only rows with unsynced local changes. */
  dirtyOnly?: boolean;
  conflictedOnly?: boolean;
  includeArchived?: boolean;
  sortBy?: 'updatedAt' | 'dueAt' | 'priority' | 'number' | 'createdAt';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CreateInspectionInput {
  templateId: string;
  templateVersionId: string;
  title: string;
  projectId?: string | null;
  clientId?: string | null;
  siteId?: string | null;
  assetId?: string | null;
  priority?: Priority;
  category?: string | null;
  department?: string | null;
  assignedToId?: string | null;
  scheduledFor?: string | null;
  dueAt?: string | null;
  notes?: string | null;
  tags?: string[];
  startLocation?: GeoPoint | null;
  status?: InspectionStatus;
}

/** Fields a user may edit. Mirrors the server's write whitelist exactly. */
const EDITABLE_FIELDS = [
  'title',
  'priority',
  'category',
  'department',
  'notes',
  'tags',
  'siteId',
  'clientId',
  'projectId',
  'assetId',
  'assignedToId',
  'status',
  'startedAt',
  'scheduledFor',
  'dueAt',
  'completedAt',
  'submittedAt',
  'startLocation',
  'endLocation',
  'distanceFromSiteMeters',
  'score',
  'outcome',
  'totalFields',
  'answeredFields',
  'failedFields',
  'criticalFailures',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

const COLUMN_BY_FIELD: Record<EditableField, string> = {
  title: 'title',
  priority: 'priority',
  category: 'category',
  department: 'department',
  notes: 'notes',
  tags: 'tags',
  siteId: 'site_id',
  clientId: 'client_id',
  projectId: 'project_id',
  assetId: 'asset_id',
  assignedToId: 'assigned_to_id',
  status: 'status',
  startedAt: 'started_at',
  scheduledFor: 'scheduled_for',
  dueAt: 'due_at',
  completedAt: 'completed_at',
  submittedAt: 'submitted_at',
  startLocation: 'start_location',
  endLocation: 'end_location',
  distanceFromSiteMeters: 'distance_from_site_meters',
  score: 'score',
  outcome: 'outcome',
  totalFields: 'total_fields',
  answeredFields: 'answered_fields',
  failedFields: 'failed_fields',
  criticalFailures: 'critical_failures',
};

/** JSON-encoded columns. */
const JSON_FIELDS = new Set<EditableField>(['tags', 'startLocation', 'endLocation']);

function bindValue(field: EditableField, value: JsonValue): SqlValue {
  if (value === null || value === undefined) return null;
  if (JSON_FIELDS.has(field)) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value as SqlValue;
}

export class InspectionRepository {
  constructor(
    private readonly db: Database,
    private readonly outbox: Outbox,
    private readonly identity: { userId: string; orgId: string },
  ) {}

  // --- reads ---------------------------------------------------------------

  findById(id: string): Inspection | null {
    const row = this.db.getFirst<InspectionRow>(
      `SELECT * FROM inspections WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return row ? toInspection(row) : null;
  }

  /**
   * List projection for the inspections screen.
   *
   * Denormalised in SQL rather than by N+1 lookups: the list renders template,
   * site, and client names, and doing that per row would make a 500-row list
   * issue 1,500 queries during a scroll.
   */
  list(filter: InspectionFilter = {}): InspectionListItem[] {
    const where: string[] = ['i.deleted_at IS NULL'];
    const params: SqlValue[] = [];

    if (!filter.includeArchived) where.push('i.is_archived = 0');

    if (filter.search) {
      // Matching number and title covers how inspectors actually search: they
      // either have the reference from a work order, or they remember the site.
      where.push('(i.number LIKE ? OR i.title LIKE ? OR s.name LIKE ?)');
      const term = `%${filter.search.trim()}%`;
      params.push(term, term, term);
    }
    if (filter.status?.length) {
      where.push(`i.status IN (${filter.status.map(() => '?').join(',')})`);
      params.push(...filter.status);
    }
    if (filter.priority?.length) {
      where.push(`i.priority IN (${filter.priority.map(() => '?').join(',')})`);
      params.push(...filter.priority);
    }
    if (filter.assignedToId) {
      where.push('i.assigned_to_id = ?');
      params.push(filter.assignedToId);
    }
    if (filter.siteId) {
      where.push('i.site_id = ?');
      params.push(filter.siteId);
    }
    if (filter.clientId) {
      where.push('i.client_id = ?');
      params.push(filter.clientId);
    }
    if (filter.projectId) {
      where.push('i.project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.templateId) {
      where.push('i.template_id = ?');
      params.push(filter.templateId);
    }
    if (filter.dueBefore) {
      where.push('i.due_at <= ?');
      params.push(filter.dueBefore);
    }
    if (filter.dueAfter) {
      where.push('i.due_at >= ?');
      params.push(filter.dueAfter);
    }
    if (filter.dirtyOnly) where.push('i.is_dirty = 1');
    if (filter.conflictedOnly) where.push('i.has_conflict = 1');

    if (filter.tags?.length) {
      // SQLite has no array type; tags are a JSON array, matched by substring.
      // Quoting the term avoids "wind" matching "winding".
      for (const tag of filter.tags) {
        where.push(`i.tags LIKE ?`);
        params.push(`%"${tag}"%`);
      }
    }

    const sortColumn = {
      updatedAt: 'i.updated_at',
      dueAt: 'i.due_at',
      createdAt: 'i.created_at',
      number: 'i.number',
      // Priority is stored as text, so sort by explicit rank rather than
      // alphabetically — otherwise CRITICAL sorts between a NORMAL and a LOW.
      priority: `CASE i.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END`,
    }[filter.sortBy ?? 'updatedAt'];

    const dir = filter.sortDir === 'asc' ? 'ASC' : 'DESC';

    const rows = this.db.getAll<{
      id: string;
      number: string;
      title: string;
      status: string;
      outcome: string;
      priority: string;
      template_name: string | null;
      site_name: string | null;
      client_name: string | null;
      assignee_first: string | null;
      assignee_last: string | null;
      due_at: string | null;
      updated_at: string;
      score: number | null;
      answered_fields: number;
      total_fields: number;
      attachment_count: number;
      is_dirty: number;
      has_conflict: number;
    }>(
      `SELECT i.id, i.number, i.title, i.status, i.outcome, i.priority,
              t.name AS template_name, s.name AS site_name, c.name AS client_name,
              u.first_name AS assignee_first, u.last_name AS assignee_last,
              i.due_at, i.updated_at, i.score, i.answered_fields, i.total_fields,
              (SELECT COUNT(*) FROM attachments a
                WHERE a.inspection_id = i.id AND a.deleted_at IS NULL) AS attachment_count,
              i.is_dirty, i.has_conflict
         FROM inspections i
         LEFT JOIN template_versions t ON t.id = i.template_version_id
         LEFT JOIN sites   s ON s.id = i.site_id
         LEFT JOIN clients c ON c.id = i.client_id
         LEFT JOIN users   u ON u.id = i.assigned_to_id
        WHERE ${where.join(' AND ')}
        ORDER BY ${sortColumn} ${dir}
        LIMIT ? OFFSET ?`,
      [...params, filter.limit ?? 50, filter.offset ?? 0],
    );

    return rows.map((r) => ({
      id: r.id as InspectionListItem['id'],
      number: r.number,
      title: r.title,
      status: r.status as InspectionStatus,
      outcome: r.outcome as InspectionOutcome,
      priority: r.priority as Priority,
      templateName: r.template_name ?? 'Unknown template',
      siteName: r.site_name,
      clientName: r.client_name,
      assigneeName: r.assignee_first ? `${r.assignee_first} ${r.assignee_last ?? ''}`.trim() : null,
      dueAt: r.due_at as InspectionListItem['dueAt'],
      updatedAt: r.updated_at as InspectionListItem['updatedAt'],
      score: r.score,
      answeredFields: r.answered_fields,
      totalFields: r.total_fields,
      attachmentCount: r.attachment_count,
      hasPendingChanges: r.is_dirty === 1,
      hasConflict: r.has_conflict === 1,
    }));
  }

  count(filter: InspectionFilter = {}): number {
    const rows = this.list({ ...filter, limit: 100_000, offset: 0 });
    return rows.length;
  }

  /** Dashboard tallies, computed in one pass rather than six queries. */
  statusCounts(assignedToId?: string): Record<string, number> {
    const rows = this.db.getAll<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n
         FROM inspections
        WHERE deleted_at IS NULL AND is_archived = 0
          ${assignedToId ? 'AND assigned_to_id = ?' : ''}
        GROUP BY status`,
      assignedToId ? [assignedToId] : [],
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Overdue = past due and not yet in a terminal state. */
  overdueCount(assignedToId?: string): number {
    const row = this.db.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inspections
        WHERE deleted_at IS NULL AND is_archived = 0
          AND due_at IS NOT NULL AND due_at < ?
          AND status NOT IN ('APPROVED','CANCELLED','ARCHIVED','SUBMITTED','UNDER_REVIEW')
          ${assignedToId ? 'AND assigned_to_id = ?' : ''}`,
      assignedToId ? [new Date().toISOString(), assignedToId] : [new Date().toISOString()],
    );
    return row?.n ?? 0;
  }

  dueTodayCount(assignedToId?: string): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const row = this.db.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inspections
        WHERE deleted_at IS NULL AND is_archived = 0
          AND due_at >= ? AND due_at < ?
          AND status NOT IN ('APPROVED','CANCELLED','ARCHIVED')
          ${assignedToId ? 'AND assigned_to_id = ?' : ''}`,
      assignedToId
        ? [start.toISOString(), end.toISOString(), assignedToId]
        : [start.toISOString(), end.toISOString()],
    );
    return row?.n ?? 0;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Create an inspection locally.
   *
   * The id is minted here, on the device, so the record has real identity
   * immediately — the inspector can photograph and answer against it before any
   * server has heard of it. The human-facing number stays provisional until the
   * server allocates the real one.
   */
  create(input: CreateInspectionInput): Inspection {
    const id = ulid();
    const now = new Date().toISOString();

    return this.db.write(() => {
      const patch: Record<string, JsonValue> = {
        templateId: input.templateId,
        templateVersionId: input.templateVersionId,
        title: input.title,
        projectId: input.projectId ?? null,
        clientId: input.clientId ?? null,
        siteId: input.siteId ?? null,
        assetId: input.assetId ?? null,
        priority: input.priority ?? 'NORMAL',
        category: input.category ?? null,
        department: input.department ?? null,
        assignedToId: input.assignedToId ?? this.identity.userId,
        status: input.status ?? InspectionStatus.IN_PROGRESS,
        scheduledFor: input.scheduledFor ?? null,
        dueAt: input.dueAt ?? null,
        notes: input.notes ?? null,
        tags: (input.tags ?? []) as JsonValue,
        startLocation: (input.startLocation ?? null) as JsonValue,
        startedAt: now,
      };

      this.db.run(
        `INSERT INTO inspections
           (id, org_id, number, template_id, template_version_id, project_id, client_id,
            site_id, asset_id, title, status, outcome, priority, category, department,
            assigned_to_id, created_by_id, started_at, scheduled_for, due_at,
            start_location, notes, tags, is_provisional_number,
            version, sync_cursor, created_at, updated_at, is_dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 1)`,
        [
          id,
          this.identity.orgId,
          provisionalInspectionNumber(id),
          input.templateId,
          input.templateVersionId,
          input.projectId ?? null,
          input.clientId ?? null,
          input.siteId ?? null,
          input.assetId ?? null,
          input.title,
          toDisplayString(patch.status),
          toDisplayString(patch.priority),
          input.category ?? null,
          input.department ?? null,
          input.assignedToId ?? this.identity.userId,
          this.identity.userId,
          now,
          input.scheduledFor ?? null,
          input.dueAt ?? null,
          input.startLocation ? JSON.stringify(input.startLocation) : null,
          input.notes ?? null,
          JSON.stringify(input.tags ?? []),
          now,
          now,
        ],
      );

      // Version 0 means "the server has never seen this", which is what tells
      // the sync engine to send a CREATE rather than a versioned UPDATE.
      this.outbox.enqueue({
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.CREATE,
        entityId: id,
        patch,
        baseVersion: null,
      });

      return this.findById(id)!;
    });
  }

  /**
   * Apply a partial edit.
   *
   * Only changed fields are queued. A field-level patch is what lets a
   * supervisor reassign this inspection while the inspector edits its notes,
   * and have both survive the merge.
   */
  update(id: string, changes: Partial<Record<EditableField, JsonValue>>): Inspection {
    return this.db.write(() => {
      const current = this.db.getFirst<InspectionRow>(`SELECT * FROM inspections WHERE id = ?`, [
        id,
      ]);
      if (!current) throw new Error(`Inspection ${id} not found`);

      const sets: string[] = [];
      const params: SqlValue[] = [];
      const patch: Record<string, JsonValue> = {};

      for (const [field, value] of Object.entries(changes) as Array<[EditableField, JsonValue]>) {
        if (!EDITABLE_FIELDS.includes(field)) continue;
        sets.push(`${COLUMN_BY_FIELD[field]} = ?`);
        params.push(bindValue(field, value));
        patch[field] = value;
      }

      if (sets.length === 0) return toInspection(current);

      const now = new Date().toISOString();
      sets.push('updated_at = ?', 'is_dirty = 1');
      params.push(now, id);

      this.db.run(`UPDATE inspections SET ${sets.join(', ')} WHERE id = ?`, params);

      // Preserve the last acknowledged state as the merge ancestor, but only on
      // the first local edit — later edits must not overwrite the ancestor with
      // already-dirty data, or the three-way diff loses its reference point.
      if (current.is_dirty === 0) {
        this.db.run(`UPDATE inspections SET base_snapshot = ? WHERE id = ?`, [
          JSON.stringify(toInspection(current)),
          id,
        ]);
      }

      this.outbox.enqueue({
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.UPDATE,
        entityId: id,
        patch,
        // Version 0 means the server has not acknowledged this record yet, so
        // there is no base version to conflict against.
        baseVersion: current.version > 0 ? current.version : null,
      });

      return this.findById(id)!;
    });
  }

  /** Recompute cached counters after answers change. */
  refreshProgress(
    id: string,
    progress: {
      score: number | null;
      outcome: InspectionOutcome;
      totalFields: number;
      answeredFields: number;
      failedFields: number;
      criticalFailures: number;
    },
  ): void {
    this.update(id, {
      score: progress.score,
      outcome: progress.outcome,
      totalFields: progress.totalFields,
      answeredFields: progress.answeredFields,
      failedFields: progress.failedFields,
      criticalFailures: progress.criticalFailures,
    });
  }

  /**
   * Duplicate an inspection's metadata as a new draft.
   *
   * Answers are deliberately not copied: an inspection is evidence of a specific
   * visit, and pre-filling last month's findings is how false records get
   * created. Only the addressing metadata carries over.
   */
  duplicate(id: string): Inspection {
    const source = this.findById(id);
    if (!source) throw new Error(`Inspection ${id} not found`);

    return this.create({
      templateId: source.templateId,
      templateVersionId: source.templateVersionId,
      title: `${source.title} (copy)`,
      projectId: source.projectId,
      clientId: source.clientId,
      siteId: source.siteId,
      assetId: source.assetId,
      priority: source.priority,
      category: source.category,
      department: source.department,
      assignedToId: source.assignedToId,
      tags: source.tags,
      status: InspectionStatus.DRAFT,
    });
  }

  archive(id: string): void {
    this.db.write(() => {
      this.db.run(
        `UPDATE inspections SET is_archived = 1, updated_at = ?, is_dirty = 1 WHERE id = ?`,
        [new Date().toISOString(), id],
      );
      const current = this.db.getFirst<{ version: number }>(
        `SELECT version FROM inspections WHERE id = ?`,
        [id],
      );
      this.outbox.enqueue({
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.UPDATE,
        entityId: id,
        patch: { status: InspectionStatus.ARCHIVED },
        baseVersion: current && current.version > 0 ? current.version : null,
      });
    });
  }

  /** Soft delete. The tombstone replicates; the row stays for the audit trail. */
  remove(id: string): void {
    this.db.write(() => {
      const current = this.db.getFirst<{ version: number }>(
        `SELECT version FROM inspections WHERE id = ?`,
        [id],
      );
      this.db.run(`UPDATE inspections SET deleted_at = ?, is_dirty = 1 WHERE id = ?`, [
        new Date().toISOString(),
        id,
      ]);
      this.outbox.enqueue({
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.DELETE,
        entityId: id,
        patch: {},
        baseVersion: current && current.version > 0 ? current.version : null,
      });
    });
  }

  /** Rows with unsynced changes, for the "pending sync" sheet. */
  pendingSync(): InspectionListItem[] {
    return this.list({ dirtyOnly: true, limit: 200 });
  }

  conflicted(): InspectionListItem[] {
    return this.list({ conflictedOnly: true, limit: 200 });
  }
}
