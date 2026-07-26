/**
 * Per-entity sync behaviour.
 *
 * The sync engine is entity-agnostic: it handles ordering, idempotency,
 * conflict detection, cursors, and the change log. Everything entity-specific —
 * which columns exist, who may write them, what makes a record valid — lives
 * here, behind one interface. Adding a new syncable entity means writing one
 * handler, not touching the engine.
 */

import { can, canEditInspection, Permission } from '@orbit/shared';
import {
  EDITABLE_INSPECTION_STATUSES,
  type InspectionStatus,
  type JsonValue,
  SyncEntity,
  type SyncOperationEnvelope,
} from '@orbit/types';
import { toDisplayString, ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';

import type { DbClient } from '../../db/prisma.js';
import type { SyncActor } from './sync.service.js';

/** Minimum shape the engine needs from any syncable row. */
export interface SyncableRow {
  id: string;
  orgId: string;
  version: number;
  updatedAt: Date;
  deletedAt: Date | null;
  [key: string]: unknown;
}

export interface WriteMeta {
  version: number;
  cursor: bigint;
}

export interface EntityHandler {
  load(tx: DbClient, orgId: string, id: string): Promise<SyncableRow | null>;

  /**
   * Reconstruct the ancestor the device edited from.
   *
   * Returns null when it cannot be recovered, which correctly downgrades the
   * merge to "treat every difference as conflicting" rather than guessing.
   */
  loadVersionSnapshot(
    tx: DbClient,
    orgId: string,
    id: string,
    version: number,
  ): Promise<Record<string, JsonValue> | null>;

  /** Returns a denial reason, or null when permitted. */
  authorize(
    tx: DbClient,
    actor: SyncActor,
    op: SyncOperationEnvelope,
    current: SyncableRow | null,
  ): Promise<string | null>;

  /** Returns a validation failure message, or null when valid. */
  validate(
    tx: DbClient,
    actor: SyncActor,
    op: SyncOperationEnvelope,
    current: SyncableRow | null,
  ): Promise<string | null>;

  create(
    tx: DbClient,
    actor: SyncActor,
    op: SyncOperationEnvelope,
    meta: WriteMeta,
  ): Promise<SyncableRow>;
  update(
    tx: DbClient,
    actor: SyncActor,
    op: SyncOperationEnvelope,
    meta: WriteMeta,
  ): Promise<SyncableRow>;
  softDelete(
    tx: DbClient,
    id: string,
    ctx: { version: number; cursor: bigint; actor: SyncActor },
  ): Promise<void>;

  /** Row → wire snapshot. Strips internals the device has no use for. */
  serialize(row: SyncableRow): Record<string, JsonValue>;

  /** Scoping keys the change log indexes on. */
  projectIdOf(row: SyncableRow): string | null;
  assigneeOf(row: SyncableRow): string | null;
}

/** Whitelist of columns a device may write, per entity. */
function pick(
  patch: Record<string, JsonValue>,
  allowed: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in patch) out[key] = patch[key];
  }
  return out;
}

/** Coerce ISO strings in date-bearing columns to Date objects for Prisma. */
function coerceDates(
  data: Record<string, unknown>,
  dateFields: readonly string[],
): Record<string, unknown> {
  for (const key of dateFields) {
    const value = data[key];
    if (typeof value === 'string') {
      const parsed = new Date(value);
      data[key] = Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }
  return data;
}

/**
 * Coerce a device-supplied patch value to text.
 *
 * `op.patch` is `JsonValue`, so every field on it may legitimately be an object
 * or an array — the client controls that shape entirely. Passing one to
 * `String()` yields the literal "[object Object]", which then gets written to
 * the database as if it were a real identifier or title: a corrupt row that
 * looks valid and is only noticed much later, by a human reading a report.
 *
 * Serialising instead keeps the bad value visible and debuggable. Schema
 * validation upstream is what should reject it; this is the backstop for the
 * case where it does not.
 */
const text = toDisplayString;

function writerMeta(actor: SyncActor, meta: WriteMeta) {
  return {
    version: meta.version,
    syncCursor: meta.cursor,
    lastWriterDeviceId: actor.deviceId,
    lastWriterUserId: actor.userId,
  };
}

const jsonify = (value: unknown): JsonValue => {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonify);
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonify(v);
    return out;
  }
  return value as JsonValue;
};

function serializeRow(row: SyncableRow, omit: readonly string[] = []): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (omit.includes(key)) continue;
    out[key] = jsonify(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

const INSPECTION_WRITABLE = [
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

const INSPECTION_DATES = [
  'startedAt',
  'scheduledFor',
  'dueAt',
  'completedAt',
  'submittedAt',
] as const;

const inspectionHandler: EntityHandler = {
  async load(tx, orgId, id) {
    const row = await tx.inspection.findFirst({ where: { id, orgId } });
    return row as SyncableRow | null;
  },

  async loadVersionSnapshot(tx, orgId, id, version) {
    // The change log holds a snapshot per accepted version, which is exactly the
    // ancestor a three-way merge needs. When it has been pruned we return null
    // and the merge degrades safely to "everything conflicts".
    const entry = await tx.changeLogEntry.findFirst({
      where: { orgId, entityId: id, entity: SyncEntity.INSPECTION, version },
      orderBy: { cursor: 'desc' },
      select: { data: true },
    });
    return (entry?.data as Record<string, JsonValue> | undefined) ?? null;
  },

  async authorize(_tx, actor, op, current) {
    if (!current) {
      return can(actor, Permission.INSPECTION_CREATE)
        ? null
        : 'You do not have permission to create inspections.';
    }
    const editable = canEditInspection(actor, {
      orgId: current.orgId,
      assignedToId: current.assignedToId as string | null,
      projectId: current.projectId as string | null,
      createdById: current.createdById as string | null,
    });
    if (!editable) return 'You do not have permission to edit this inspection.';

    // A device that has been offline may push an edit to an inspection that has
    // since been approved. Accepting it would silently rewrite a signed-off
    // record, so it is refused and surfaced to the inspector.
    const status = current.status as InspectionStatus;
    const nextStatus = (op.patch.status as InspectionStatus | undefined) ?? status;
    const changingStatus = nextStatus !== status;

    if (!EDITABLE_INSPECTION_STATUSES.includes(status) && !changingStatus) {
      return `This inspection is ${status.toLowerCase().replace('_', ' ')} and can no longer be edited.`;
    }
    return null;
  },

  async validate(tx, actor, op, current) {
    const patch = op.patch;

    if (!current) {
      if (!patch.templateVersionId || !patch.templateId) {
        return 'An inspection must reference a template version.';
      }
      const templateVersion = await tx.templateVersion.findFirst({
        where: { id: text(patch.templateVersionId), orgId: actor.orgId },
        select: { id: true },
      });
      if (!templateVersion) return 'The referenced template version does not exist.';
    }

    for (const [field, table] of [
      ['siteId', 'site'],
      ['clientId', 'client'],
      ['projectId', 'project'],
      ['assetId', 'asset'],
    ] as const) {
      const value = patch[field];
      if (typeof value !== 'string') continue;
      // Cross-tenant reference check: a device must not be able to attach an
      // inspection to another organisation's site by guessing an id.
      const exists = await (
        tx as never as Record<string, { findFirst: (a: unknown) => Promise<unknown> }>
      )[table]!.findFirst({ where: { id: value, orgId: actor.orgId }, select: { id: true } });
      if (!exists) return `The referenced ${table} does not exist.`;
    }

    if (typeof patch.assignedToId === 'string') {
      const assignee = await tx.user.findFirst({
        where: { id: patch.assignedToId, orgId: actor.orgId, deletedAt: null },
        select: { id: true },
      });
      if (!assignee) return 'The assigned user does not exist.';
    }

    return null;
  },

  async create(tx, actor, op, meta) {
    const data = coerceDates(pick(op.patch, INSPECTION_WRITABLE), INSPECTION_DATES);

    // The human-facing number is allocated server-side; until then the device
    // displays a provisional draft reference.
    const org = await tx.$queryRaw<
      Array<{ number_sequence: number; number_prefix: string; number_year: number }>
    >`
      UPDATE organizations
         SET "numberSequence" = CASE WHEN "numberYear" = EXTRACT(YEAR FROM NOW())::int
                                     THEN "numberSequence" + 1 ELSE 1 END,
             "numberYear"     = EXTRACT(YEAR FROM NOW())::int
       WHERE id = ${actor.orgId}
      RETURNING "numberSequence" AS number_sequence, "numberPrefix" AS number_prefix, "numberYear" AS number_year
    `;
    const seq = org[0]!;
    const number = `${seq.number_prefix}-${seq.number_year}-${String(seq.number_sequence).padStart(6, '0')}`;

    const row = await tx.inspection.create({
      data: {
        ...(data as Prisma.InspectionUncheckedCreateInput),
        id: op.entityId,
        orgId: actor.orgId,
        number,
        templateId: text(op.patch.templateId),
        templateVersionId: text(op.patch.templateVersionId),
        title: text(op.patch.title ?? 'Untitled inspection'),
        createdById: actor.userId,
        ...writerMeta(actor, meta),
      },
    });
    return row as SyncableRow;
  },

  async update(tx, actor, op, meta) {
    const data = coerceDates(pick(op.patch, INSPECTION_WRITABLE), INSPECTION_DATES);
    const row = await tx.inspection.update({
      where: { id: op.entityId },
      data: { ...(data as Prisma.InspectionUncheckedUpdateInput), ...writerMeta(actor, meta) },
    });
    return row as SyncableRow;
  },

  async softDelete(tx, id, ctx) {
    await tx.inspection.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: ctx.version,
        syncCursor: ctx.cursor,
        lastWriterDeviceId: ctx.actor.deviceId,
        lastWriterUserId: ctx.actor.userId,
      },
    });
  },

  serialize: (row) => serializeRow(row),
  projectIdOf: (row) => (row.projectId as string | null) ?? null,
  assigneeOf: (row) => (row.assignedToId as string | null) ?? null,
};

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const RESPONSE_WRITABLE = [
  'value',
  'comment',
  'score',
  'isFailure',
  'isNotApplicable',
  'location',
  'answeredAt',
] as const;

const responseHandler: EntityHandler = {
  async load(tx, orgId, id) {
    return (await tx.inspectionResponse.findFirst({ where: { id, orgId } })) as SyncableRow | null;
  },

  async loadVersionSnapshot(tx, orgId, id, version) {
    const entry = await tx.changeLogEntry.findFirst({
      where: { orgId, entityId: id, entity: SyncEntity.RESPONSE, version },
      orderBy: { cursor: 'desc' },
      select: { data: true },
    });
    return (entry?.data as Record<string, JsonValue> | undefined) ?? null;
  },

  async authorize(tx, actor, op, current) {
    const inspectionId =
      (current?.inspectionId as string | undefined) ?? text(op.patch.inspectionId ?? '');
    if (!inspectionId) return 'A response must belong to an inspection.';

    const inspection = await tx.inspection.findFirst({
      where: { id: inspectionId, orgId: actor.orgId },
      select: {
        id: true,
        orgId: true,
        assignedToId: true,
        projectId: true,
        createdById: true,
        status: true,
      },
    });
    if (!inspection) return 'The parent inspection does not exist.';

    if (!canEditInspection(actor, inspection)) {
      return 'You do not have permission to edit this inspection.';
    }
    if (!EDITABLE_INSPECTION_STATUSES.includes(inspection.status as InspectionStatus)) {
      return 'This inspection can no longer be edited.';
    }
    return null;
  },

  async validate(_tx, _actor, op, current) {
    if (!current && (!op.patch.fieldId || !op.patch.sectionId)) {
      return 'A response must identify its field and section.';
    }
    return null;
  },

  async create(tx, actor, op, meta) {
    const data = pick(op.patch, RESPONSE_WRITABLE);
    if (typeof data.answeredAt === 'string') data.answeredAt = new Date(data.answeredAt);

    // Upsert rather than create: the unique key is (inspection, field, repeat),
    // so a replayed create from a device that lost its ack converges on the same
    // row instead of failing on a constraint violation.
    const row = await tx.inspectionResponse.upsert({
      where: {
        inspectionId_fieldId_repeatIndex: {
          inspectionId: text(op.patch.inspectionId),
          fieldId: text(op.patch.fieldId),
          repeatIndex: Number(op.patch.repeatIndex ?? 0),
        },
      },
      create: {
        ...(data as Prisma.InspectionResponseUncheckedCreateInput),
        id: op.entityId,
        orgId: actor.orgId,
        inspectionId: text(op.patch.inspectionId),
        sectionId: text(op.patch.sectionId),
        fieldId: text(op.patch.fieldId),
        repeatIndex: Number(op.patch.repeatIndex ?? 0),
        answeredById: actor.userId,
        ...writerMeta(actor, meta),
      },
      update: {
        ...(data as Prisma.InspectionResponseUncheckedUpdateInput),
        answeredById: actor.userId,
        ...writerMeta(actor, meta),
      },
    });
    return row as SyncableRow;
  },

  async update(tx, actor, op, meta) {
    const data = pick(op.patch, RESPONSE_WRITABLE);
    if (typeof data.answeredAt === 'string') data.answeredAt = new Date(data.answeredAt);
    const row = await tx.inspectionResponse.update({
      where: { id: op.entityId },
      data: {
        ...(data as Prisma.InspectionResponseUncheckedUpdateInput),
        answeredById: actor.userId,
        ...writerMeta(actor, meta),
      },
    });
    return row as SyncableRow;
  },

  async softDelete(tx, id, ctx) {
    await tx.inspectionResponse.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: ctx.version,
        syncCursor: ctx.cursor,
        lastWriterDeviceId: ctx.actor.deviceId,
        lastWriterUserId: ctx.actor.userId,
      },
    });
  },

  serialize: (row) => serializeRow(row),
  projectIdOf: () => null,
  assigneeOf: () => null,
};

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

const ATTACHMENT_WRITABLE = [
  'caption',
  'pairTag',
  'annotations',
  'location',
  'capturedAt',
  'state',
  'width',
  'height',
  'durationMs',
] as const;

const attachmentHandler: EntityHandler = {
  async load(tx, orgId, id) {
    return (await tx.attachment.findFirst({ where: { id, orgId } })) as SyncableRow | null;
  },

  async loadVersionSnapshot(tx, orgId, id, version) {
    const entry = await tx.changeLogEntry.findFirst({
      where: { orgId, entityId: id, entity: SyncEntity.ATTACHMENT, version },
      orderBy: { cursor: 'desc' },
      select: { data: true },
    });
    return (entry?.data as Record<string, JsonValue> | undefined) ?? null;
  },

  async authorize(_tx, actor, _op, _current) {
    return can(actor, Permission.INSPECTION_UPDATE)
      ? null
      : 'You do not have permission to attach files.';
  },

  async validate(_tx, _actor, op, current) {
    if (!current) {
      if (!op.patch.checksum || !op.patch.fileName || !op.patch.mimeType) {
        return 'An attachment must declare its file name, type, and checksum.';
      }
    }
    return null;
  },

  async create(tx, actor, op, meta) {
    const data = pick(op.patch, ATTACHMENT_WRITABLE);
    if (typeof data.capturedAt === 'string') data.capturedAt = new Date(data.capturedAt);

    const row = await tx.attachment.create({
      data: {
        ...(data as Prisma.AttachmentUncheckedCreateInput),
        id: op.entityId,
        orgId: actor.orgId,
        inspectionId: (op.patch.inspectionId as string | null) ?? null,
        responseId: (op.patch.responseId as string | null) ?? null,
        kind: op.patch.kind as Prisma.AttachmentCreateInput['kind'],
        fileName: text(op.patch.fileName),
        mimeType: text(op.patch.mimeType),
        sizeBytes: BigInt(Number(op.patch.sizeBytes ?? 0)),
        checksum: text(op.patch.checksum),
        ...writerMeta(actor, meta),
      },
    });
    return row as SyncableRow;
  },

  async update(tx, actor, op, meta) {
    const data = pick(op.patch, ATTACHMENT_WRITABLE);
    if (typeof data.capturedAt === 'string') data.capturedAt = new Date(data.capturedAt);
    const row = await tx.attachment.update({
      where: { id: op.entityId },
      data: { ...(data as Prisma.AttachmentUncheckedUpdateInput), ...writerMeta(actor, meta) },
    });
    return row as SyncableRow;
  },

  async softDelete(tx, id, ctx) {
    await tx.attachment.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: ctx.version,
        syncCursor: ctx.cursor,
        lastWriterDeviceId: ctx.actor.deviceId,
        lastWriterUserId: ctx.actor.userId,
      },
    });
  },

  serialize: (row) => serializeRow(row),
  projectIdOf: () => null,
  assigneeOf: () => null,
};

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

const SIGNATURE_WRITABLE = [
  'signerName',
  'signerTitle',
  'signerEmail',
  'attachmentId',
  'strokes',
  'location',
  'declaration',
] as const;

const signatureHandler: EntityHandler = {
  async load(tx, orgId, id) {
    return (await tx.signature.findFirst({ where: { id, orgId } })) as SyncableRow | null;
  },

  async loadVersionSnapshot(tx, orgId, id, version) {
    const entry = await tx.changeLogEntry.findFirst({
      where: { orgId, entityId: id, entity: SyncEntity.SIGNATURE, version },
      orderBy: { cursor: 'desc' },
      select: { data: true },
    });
    return (entry?.data as Record<string, JsonValue> | undefined) ?? null;
  },

  async authorize(tx, actor, op, current) {
    const inspectionId =
      (current?.inspectionId as string | undefined) ?? text(op.patch.inspectionId ?? '');
    const inspection = await tx.inspection.findFirst({
      where: { id: inspectionId, orgId: actor.orgId },
      select: { orgId: true, assignedToId: true, projectId: true, createdById: true },
    });
    if (!inspection) return 'The parent inspection does not exist.';
    return canEditInspection(actor, inspection)
      ? null
      : 'You do not have permission to sign this inspection.';
  },

  async validate(_tx, _actor, op, current) {
    if (!current && (!op.patch.inspectionId || !op.patch.role || !op.patch.signerName)) {
      return 'A signature must identify the inspection, the role, and the signatory.';
    }
    return null;
  },

  async create(tx, actor, op, meta) {
    const data = pick(op.patch, SIGNATURE_WRITABLE);
    const row = await tx.signature.create({
      data: {
        ...(data as Prisma.SignatureUncheckedCreateInput),
        id: op.entityId,
        orgId: actor.orgId,
        inspectionId: text(op.patch.inspectionId),
        role: op.patch.role as Prisma.SignatureCreateInput['role'],
        signerName: text(op.patch.signerName),
        signedAt: op.patch.signedAt ? new Date(text(op.patch.signedAt)) : new Date(),
        ...writerMeta(actor, meta),
      },
    });
    return row as SyncableRow;
  },

  async update(tx, actor, op, meta) {
    const data = pick(op.patch, SIGNATURE_WRITABLE);
    const row = await tx.signature.update({
      where: { id: op.entityId },
      data: { ...(data as Prisma.SignatureUncheckedUpdateInput), ...writerMeta(actor, meta) },
    });
    return row as SyncableRow;
  },

  async softDelete(tx, id, ctx) {
    await tx.signature.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: ctx.version,
        syncCursor: ctx.cursor,
        lastWriterDeviceId: ctx.actor.deviceId,
        lastWriterUserId: ctx.actor.userId,
      },
    });
  },

  serialize: (row) => serializeRow(row),
  projectIdOf: () => null,
  assigneeOf: () => null,
};

// ---------------------------------------------------------------------------
// Asset — inspectors register equipment they find in the field.
// ---------------------------------------------------------------------------

const ASSET_WRITABLE = [
  'name',
  'tag',
  'category',
  'manufacturer',
  'model',
  'serialNumber',
  'installedAt',
  'latitude',
  'longitude',
  'metadata',
  'siteId',
  'parentAssetId',
] as const;

const assetHandler: EntityHandler = {
  async load(tx, orgId, id) {
    return (await tx.asset.findFirst({ where: { id, orgId } })) as SyncableRow | null;
  },

  async loadVersionSnapshot(tx, orgId, id, version) {
    const entry = await tx.changeLogEntry.findFirst({
      where: { orgId, entityId: id, entity: SyncEntity.ASSET, version },
      orderBy: { cursor: 'desc' },
      select: { data: true },
    });
    return (entry?.data as Record<string, JsonValue> | undefined) ?? null;
  },

  async authorize(_tx, actor) {
    return can(actor, Permission.ASSET_WRITE)
      ? null
      : 'You do not have permission to register assets.';
  },

  async validate(_tx, _actor, op, current) {
    if (!current && (!op.patch.name || !op.patch.tag)) {
      return 'An asset must have a name and a tag.';
    }
    return null;
  },

  async create(tx, actor, op, meta) {
    const data = coerceDates(pick(op.patch, ASSET_WRITABLE), ['installedAt']);
    const row = await tx.asset.create({
      data: {
        ...(data as Prisma.AssetUncheckedCreateInput),
        id: op.entityId,
        orgId: actor.orgId,
        name: text(op.patch.name),
        tag: text(op.patch.tag),
        ...writerMeta(actor, meta),
      },
    });
    return row as SyncableRow;
  },

  async update(tx, actor, op, meta) {
    const data = coerceDates(pick(op.patch, ASSET_WRITABLE), ['installedAt']);
    const row = await tx.asset.update({
      where: { id: op.entityId },
      data: { ...(data as Prisma.AssetUncheckedUpdateInput), ...writerMeta(actor, meta) },
    });
    return row as SyncableRow;
  },

  async softDelete(tx, id, ctx) {
    await tx.asset.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        version: ctx.version,
        syncCursor: ctx.cursor,
        lastWriterDeviceId: ctx.actor.deviceId,
        lastWriterUserId: ctx.actor.userId,
      },
    });
  },

  serialize: (row) => serializeRow(row),
  projectIdOf: () => null,
  assigneeOf: () => null,
};

export const ENTITY_HANDLERS: Partial<Record<SyncEntity, EntityHandler>> = {
  [SyncEntity.INSPECTION]: inspectionHandler,
  [SyncEntity.RESPONSE]: responseHandler,
  [SyncEntity.ATTACHMENT]: attachmentHandler,
  [SyncEntity.SIGNATURE]: signatureHandler,
  [SyncEntity.ASSET]: assetHandler,
};

export { ulid };
