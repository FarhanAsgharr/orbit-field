/**
 * Inspection REST API.
 *
 * This is the read/admin surface. Field devices do not use it — they create and
 * edit through the sync engine, which owns conflict detection and the outbox.
 * Anything here that mutates therefore has to write a change-log entry itself,
 * or offline devices would never learn about the change.
 */

import {
  AppError,
  assertTransition,
  can,
  canAccessInspection,
  ErrorCode,
  Permission,
} from '@orbit/shared';
import { InspectionStatus, type Priority, SyncEntity, SyncOperation } from '@orbit/types';
import { ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import {
  csvArray,
  dateRange,
  paginate,
  paginationArgs,
  paginationSchema,
  searchFilter,
  sortArgs,
} from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import {
  notifyInspectionAssigned,
  notifyInspectionReviewed,
} from '../notifications/push.service.js';
import { recordChange } from '../sync/change-log.js';

const router: Router = Router();

const listQuery = paginationSchema.extend({
  search: z.string().max(200).optional(),
  status: csvArray,
  outcome: csvArray,
  priority: csvArray,
  templateId: csvArray,
  projectId: csvArray,
  clientId: csvArray,
  siteId: csvArray,
  assignedToId: csvArray,
  tags: csvArray,
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  dueFrom: z.string().optional(),
  dueTo: z.string().optional(),
  includeArchived: z.coerce.boolean().default(false),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const SORTABLE = ['createdAt', 'updatedAt', 'dueAt', 'number', 'score', 'priority'] as const;

/** Scope every query to what the caller may see. Never omit this. */
function scopeFilter(subject: ReturnType<typeof auth>): Prisma.InspectionWhereInput {
  const base: Prisma.InspectionWhereInput = { orgId: subject.orgId, deletedAt: null };

  if (!can(subject, Permission.INSPECTION_READ_ALL)) {
    // Own work only: assigned to me, or created by me.
    base.OR = [{ assignedToId: subject.userId }, { createdById: subject.userId }];
  }
  if (subject.projectIds.length > 0) {
    // Project-scoped users additionally see nothing outside their projects.
    base.AND = [{ OR: [{ projectId: { in: subject.projectIds } }, { projectId: null }] }];
  }
  return base;
}

const listInclude = {
  template: { select: { name: true } },
  templateVersion: { select: { version: true } },
  site: { select: { id: true, name: true } },
  client: { select: { id: true, name: true } },
  project: { select: { id: true, name: true, code: true } },
  assignedTo: { select: { id: true, firstName: true, lastName: true } },
  _count: { select: { attachments: true, responses: true } },
} satisfies Prisma.InspectionInclude;

/** Search and filter. The primary admin list endpoint. */
router.get(
  '/',
  requireAuth,
  requirePermission(Permission.INSPECTION_READ),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as z.infer<typeof listQuery>;

    const where: Prisma.InspectionWhereInput = {
      ...scopeFilter(subject),
      ...(q.includeArchived ? {} : { isArchived: false }),
      ...(q.status?.length ? { status: { in: q.status as InspectionStatus[] } } : {}),
      ...(q.outcome?.length ? { outcome: { in: q.outcome as never } } : {}),
      ...(q.priority?.length ? { priority: { in: q.priority as Priority[] } } : {}),
      ...(q.templateId?.length ? { templateId: { in: q.templateId } } : {}),
      ...(q.projectId?.length ? { projectId: { in: q.projectId } } : {}),
      ...(q.clientId?.length ? { clientId: { in: q.clientId } } : {}),
      ...(q.siteId?.length ? { siteId: { in: q.siteId } } : {}),
      ...(q.assignedToId?.length ? { assignedToId: { in: q.assignedToId } } : {}),
      ...(q.tags?.length ? { tags: { hasSome: q.tags } } : {}),
      ...(dateRange(q.createdFrom, q.createdTo)
        ? { createdAt: dateRange(q.createdFrom, q.createdTo) }
        : {}),
      ...(dateRange(q.dueFrom, q.dueTo) ? { dueAt: dateRange(q.dueFrom, q.dueTo) } : {}),
    };

    if (q.search) {
      const term = searchFilter(q.search)!;
      // Matching number, title, and site covers how people actually search:
      // from a work order reference, or from where they were.
      where.AND = [
        ...((where.AND as Prisma.InspectionWhereInput[]) ?? []),
        {
          OR: [
            { number: term },
            { title: term },
            { notes: term },
            { site: { name: term } },
            { client: { name: term } },
          ],
        },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.inspection.findMany({
        where,
        include: listInclude,
        orderBy: sortArgs(q.sortBy, q.sortDir, SORTABLE, 'updatedAt'),
        ...paginationArgs(q),
      }),
      prisma.inspection.count({ where }),
    ]);

    res.json({ data: paginate(items, total, q) });
  }),
);

/** Full record including responses, attachments, and signatures. */
router.get(
  '/:id',
  requireAuth,
  requirePermission(Permission.INSPECTION_READ),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: {
        ...listInclude,
        templateVersion: { select: { id: true, version: true, definition: true, scoring: true } },
        responses: { where: { deletedAt: null } },
        attachments: { where: { deletedAt: null } },
        signatures: { where: { deletedAt: null } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        reviewedBy: { select: { id: true, firstName: true, lastName: true } },
        supervisor: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    if (!canAccessInspection(subject, inspection)) {
      // Deliberately 404, not 403: confirming a record exists is itself a leak
      // when the caller has no right to know about it.
      throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    }

    res.json({ data: inspection });
  }),
);

/**
 * Audit history for one inspection.
 *
 * Reads the change log rather than the audit log: the change log holds a row
 * snapshot per accepted version, which is what "what did this look like on
 * Tuesday" actually requires.
 */
router.get(
  '/:id/history',
  requireAuth,
  requirePermission(Permission.INSPECTION_READ),
  validate({ params: z.object({ id: schemas.ulid }), query: paginationSchema }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const page = req.validated!.query as z.infer<typeof paginationSchema>;

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId },
      select: { orgId: true, assignedToId: true, projectId: true, createdById: true },
    });
    if (!inspection || !canAccessInspection(subject, inspection)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    }

    const where: Prisma.ChangeLogEntryWhereInput = {
      orgId: subject.orgId,
      entityId: id,
      entity: {
        in: [
          SyncEntity.INSPECTION,
          SyncEntity.RESPONSE,
          SyncEntity.ATTACHMENT,
          SyncEntity.SIGNATURE,
        ],
      },
    };

    const [entries, total] = await Promise.all([
      prisma.changeLogEntry.findMany({
        where,
        orderBy: { cursor: 'desc' },
        ...paginationArgs(page),
      }),
      prisma.changeLogEntry.count({ where }),
    ]);

    // Resolve actor names in one query rather than per entry.
    const actorIds = Array.from(
      new Set(entries.map((e) => e.actorUserId).filter(Boolean)),
    ) as string[];
    const actors = await prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const actorById = new Map(actors.map((a) => [a.id, `${a.firstName} ${a.lastName}`]));

    res.json({
      data: paginate(
        entries.map((entry) => ({
          cursor: Number(entry.cursor),
          entity: entry.entity,
          operation: entry.operation,
          entityId: entry.entityId,
          version: entry.version,
          at: entry.createdAt,
          actorName: entry.actorUserId ? (actorById.get(entry.actorUserId) ?? null) : null,
          actorDeviceId: entry.actorDeviceId,
          data: entry.data,
        })),
        total,
        page,
      ),
    });
  }),
);

/**
 * Allocate the next inspection number for an organisation.
 *
 * A single atomic UPDATE, so two administrators scheduling work at the same
 * moment cannot be handed the same reference. The sequence restarts each
 * calendar year, which is what the `INS-2026-000001` shape implies and what
 * every operator reading it will assume.
 */
async function allocateNumber(tx: Prisma.TransactionClient, orgId: string): Promise<string> {
  const rows = await tx.$queryRaw<
    Array<{ number_sequence: number; number_prefix: string; number_year: number }>
  >`
    UPDATE organizations
       SET "numberSequence" = CASE WHEN "numberYear" = EXTRACT(YEAR FROM NOW())::int
                                   THEN "numberSequence" + 1 ELSE 1 END,
           "numberYear"     = EXTRACT(YEAR FROM NOW())::int
     WHERE id = ${orgId}
    RETURNING "numberSequence" AS number_sequence, "numberPrefix" AS number_prefix, "numberYear" AS number_year
  `;
  const row = rows[0]!;
  return `${row.number_prefix}-${row.number_year}-${String(row.number_sequence).padStart(6, '0')}`;
}

/**
 * Reference data an inspection may point at, checked inside this organisation.
 *
 * Every id on the body is attacker-controlled, and each of these is a
 * cross-tenant read if it goes unchecked — scheduling work against another
 * company's site would put their address on this organisation's report.
 */
async function resolveReferences(
  orgId: string,
  body: {
    templateId: string;
    projectId?: string | null;
    siteId?: string | null;
    assignedToId?: string | null;
    supervisorId?: string | null;
  },
): Promise<{ templateVersionId: string; clientId: string | null }> {
  const template = await prisma.template.findFirst({
    where: { id: body.templateId, orgId, deletedAt: null },
    select: { activeVersionId: true },
  });
  if (!template) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'That checklist was not found.', {
      fields: { templateId: 'Not found in this organisation.' },
    });
  }
  if (!template.activeVersionId) {
    // A draft template has no questions an inspector could answer.
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'That checklist has not been published yet.', {
      fields: { templateId: 'Publish it before scheduling work against it.' },
    });
  }

  let clientId: string | null = null;

  if (body.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: body.projectId, orgId, deletedAt: null },
      select: { clientId: true },
    });
    if (!project) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That project was not found.', {
        fields: { projectId: 'Not found in this organisation.' },
      });
    }
    // Derived rather than accepted from the body: the client is a property of
    // the project, and letting a caller state a different one would put the
    // wrong company on the report.
    clientId = project.clientId;
  }

  if (body.siteId) {
    const site = await prisma.site.findFirst({
      where: { id: body.siteId, orgId, deletedAt: null },
      select: { clientId: true },
    });
    if (!site) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That site was not found.', {
        fields: { siteId: 'Not found in this organisation.' },
      });
    }
    clientId ??= site.clientId;
  }

  if (body.supervisorId) {
    const supervisor = await prisma.user.findFirst({
      where: { id: body.supervisorId, orgId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!supervisor) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That supervisor was not found.', {
        fields: { supervisorId: 'Not an active member of this organisation.' },
      });
    }
  }

  if (body.assignedToId) {
    const assignee = await prisma.user.findFirst({
      where: { id: body.assignedToId, orgId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!assignee) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That inspector was not found.', {
        fields: { assignedToId: 'Not an active member of this organisation.' },
      });
    }
  }

  return { templateVersionId: template.activeVersionId, clientId };
}

const writableFields = {
  title: z.string().min(1).max(300).trim(),
  description: z.string().max(5000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  templateId: schemas.ulid,
  projectId: schemas.ulid.nullable().optional(),
  siteId: schemas.ulid.nullable().optional(),
  assetId: schemas.ulid.nullable().optional(),
  assignedToId: schemas.ulid.nullable().optional(),
  supervisorId: schemas.ulid.nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  estimatedDurationMinutes: z.number().int().positive().max(10_080).nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  department: z.string().max(120).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  status: z.enum(['DRAFT', 'SCHEDULED']).default('SCHEDULED'),
};

/**
 * Schedule an inspection and assign it to somebody.
 *
 * The counterpart to the device-created inspection the sync engine already
 * handles. Both end in the same row and the same change-log entry; the
 * difference is only who started it — an inspector standing in front of the
 * asset, or an administrator planning next week.
 *
 * Gated on `INSPECTION_ASSIGN` rather than `INSPECTION_CREATE`. Inspectors hold
 * the latter, because creating work they are standing in front of is their job;
 * what they must not do is hand work to somebody else.
 *
 * Only DRAFT or SCHEDULED are accepted as a starting status. Anything further
 * along asserts that work has happened — an inspection created directly as
 * APPROVED would be a signed-off record nobody carried out.
 */
router.post(
  '/',
  requireAuth,
  requirePermission(Permission.INSPECTION_ASSIGN),
  validate({ body: z.object(writableFields) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as z.infer<z.ZodObject<typeof writableFields>>;

    const { templateVersionId, clientId } = await resolveReferences(subject.orgId, body);

    const created = await prisma.$transaction(async (tx) => {
      const number = await allocateNumber(tx, subject.orgId);
      const id = ulid();

      const inspection = await tx.inspection.create({
        data: {
          id,
          orgId: subject.orgId,
          number,
          templateId: body.templateId,
          templateVersionId,
          projectId: body.projectId ?? null,
          clientId,
          siteId: body.siteId ?? null,
          assetId: body.assetId ?? null,
          title: body.title,
          description: body.description ?? null,
          notes: body.notes ?? null,
          status: body.status as never,
          priority: body.priority as Priority,
          category: body.category ?? null,
          department: body.department ?? null,
          tags: body.tags ?? [],
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          assignedToId: body.assignedToId ?? null,
          supervisorId: body.supervisorId ?? null,
          scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null,
          estimatedDurationMinutes: body.estimatedDurationMinutes ?? null,
          createdById: subject.userId,
        },
      });

      // Without this the inspection exists in the console and on no phone —
      // the assignee would never receive the work.
      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.CREATE,
        entityId: id,
        version: inspection.version,
        row: inspection,
        projectId: inspection.projectId,
        assignedToId: inspection.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_CREATED',
          entity: 'Inspection',
          entityId: id,
          metadata: { number, assignedToId: body.assignedToId ?? null },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return inspection;
    });

    // After the commit: a push failure must not roll back scheduled work.
    if (created.assignedToId) {
      void notifyInspectionAssigned({
        orgId: subject.orgId,
        assigneeId: created.assignedToId,
        inspectionId: created.id,
        number: created.number,
        title: created.title,
        siteName: null,
        dueAt: created.dueAt,
      }).catch(() => undefined);
    }

    res.status(201).json({ data: created });
  }),
);

/**
 * Edit a scheduled inspection, including reassigning it.
 *
 * Deliberately refuses once work has been submitted. Changing the checklist or
 * the site under a completed inspection would rewrite what was inspected after
 * somebody signed for it — the answers stay attached to a record that now
 * describes something else. Reviewing is how a submitted inspection changes.
 */
router.patch(
  '/:id',
  requireAuth,
  requirePermission(Permission.INSPECTION_UPDATE_ANY),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object(writableFields).partial(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = req.validated!.body as Partial<z.infer<z.ZodObject<typeof writableFields>>>;

    const existing = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    const OPEN: string[] = [
      InspectionStatus.DRAFT,
      InspectionStatus.SCHEDULED,
      InspectionStatus.IN_PROGRESS,
      InspectionStatus.REJECTED,
    ];
    if (!OPEN.includes(existing.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `This inspection is ${existing.status.toLowerCase().replace(/_/g, ' ')} and can no longer be edited. Reopen or review it instead.`,
      );
    }

    // Re-resolve only what is being changed, against the org.
    const { templateVersionId, clientId } = await resolveReferences(subject.orgId, {
      templateId: body.templateId ?? existing.templateId,
      projectId: body.projectId === undefined ? existing.projectId : body.projectId,
      siteId: body.siteId === undefined ? existing.siteId : body.siteId,
      assignedToId: body.assignedToId ?? undefined,
      supervisorId: body.supervisorId ?? undefined,
    });

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.inspection.update({
        where: { id },
        data: {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.templateId !== undefined
            ? { templateId: body.templateId, templateVersionId }
            : {}),
          ...(body.projectId !== undefined ? { projectId: body.projectId, clientId } : {}),
          ...(body.siteId !== undefined ? { siteId: body.siteId } : {}),
          ...(body.assetId !== undefined ? { assetId: body.assetId } : {}),
          ...(body.assignedToId !== undefined ? { assignedToId: body.assignedToId } : {}),
          ...(body.supervisorId !== undefined ? { supervisorId: body.supervisorId } : {}),
          ...(body.estimatedDurationMinutes !== undefined
            ? { estimatedDurationMinutes: body.estimatedDurationMinutes }
            : {}),
          ...(body.scheduledAt !== undefined
            ? { scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null }
            : {}),
          ...(body.priority !== undefined ? { priority: body.priority as Priority } : {}),
          ...(body.category !== undefined ? { category: body.category } : {}),
          ...(body.department !== undefined ? { department: body.department } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.status !== undefined ? { status: body.status as never } : {}),
          ...(body.dueAt !== undefined ? { dueAt: body.dueAt ? new Date(body.dueAt) : null } : {}),
          version: { increment: 1 },
        },
      });

      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.UPDATE,
        entityId: id,
        version: row.version,
        row,
        projectId: row.projectId,
        assignedToId: row.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_UPDATED',
          entity: 'Inspection',
          entityId: id,
          changes: {
            before: { assignedToId: existing.assignedToId, status: existing.status },
            after: body,
          } as never,
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return row;
    });

    // Tell the new assignee, but only when the assignment actually moved.
    if (updated.assignedToId && updated.assignedToId !== existing.assignedToId) {
      void notifyInspectionAssigned({
        orgId: subject.orgId,
        assigneeId: updated.assignedToId,
        inspectionId: updated.id,
        number: updated.number,
        title: updated.title,
        siteName: null,
        dueAt: updated.dueAt,
      }).catch(() => undefined);
    }

    res.json({ data: updated });
  }),
);

/**
 * Delete an inspection.
 *
 * Soft, always. The row carries answers, photographs and signatures that a
 * report may already have been produced from, and a hard delete would remove
 * the evidence behind a document somebody has been given. The tombstone is what
 * removes it from every device.
 *
 * Refused once work has been submitted — at that point it is a compliance
 * record, and archiving is the correct way to get it out of the way.
 */
router.delete(
  '/:id',
  requireAuth,
  requirePermission(Permission.INSPECTION_DELETE),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const existing = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true, number: true, status: true, version: true },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    const DELETABLE: string[] = [
      InspectionStatus.DRAFT,
      InspectionStatus.SCHEDULED,
      InspectionStatus.IN_PROGRESS,
    ];
    if (!DELETABLE.includes(existing.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'Submitted work cannot be deleted — it is a compliance record. Archive it instead.',
      );
    }

    await prisma.$transaction(async (tx) => {
      const row = await tx.inspection.update({
        where: { id },
        data: { deletedAt: new Date(), version: { increment: 1 } },
      });

      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.DELETE,
        entityId: id,
        version: row.version,
        row: null,
        projectId: row.projectId,
        assignedToId: row.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_DELETED',
          entity: 'Inspection',
          entityId: id,
          metadata: { number: existing.number, status: existing.status },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });
    });

    res.status(204).end();
  }),
);

/**
 * Move an inspection to a status, replicate it, and record why.
 *
 * Cancel and reopen differ only in the target and the audit action, so the
 * change-log entry and the transaction live in one place — a status change that
 * skipped the change log would leave the job on the inspector's phone looking
 * live.
 */
async function applyStatus(
  req: Parameters<typeof auth>[0] & { requestId: string },
  inspection: { id: string; orgId: string; number: string; status: string },
  target: InspectionStatus,
  reason?: string,
): Promise<unknown> {
  const subject = auth(req);

  return prisma.$transaction(async (tx) => {
    const row = await tx.inspection.update({
      where: { id: inspection.id },
      data: { status: target as never, version: { increment: 1 } },
    });

    await recordChange(tx, {
      orgId: subject.orgId,
      entity: SyncEntity.INSPECTION,
      operation: SyncOperation.UPDATE,
      entityId: inspection.id,
      version: row.version,
      row,
      projectId: row.projectId,
      assignedToId: row.assignedToId,
      actorUserId: subject.userId,
      actorDeviceId: subject.deviceId,
    });

    if (reason?.trim()) {
      await tx.inspectionComment.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          inspectionId: inspection.id,
          authorId: subject.userId,
          body: reason.trim(),
          decision: target === InspectionStatus.CANCELLED ? 'CANCELLED' : 'REOPENED',
        },
      });
    }

    await tx.auditLog.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        userId: subject.userId,
        action: 'RECORD_UPDATED',
        entity: 'Inspection',
        entityId: inspection.id,
        metadata: {
          number: inspection.number,
          from: inspection.status,
          to: target,
          reason: reason ?? null,
        },
        ipAddress: clientIp(req),
        requestId: req.requestId,
      },
    });

    return row;
  });
}
/**
 * Cancel an inspection, or reopen a cancelled one.
 *
 * Distinct from delete and from archive, and the difference matters to whoever
 * reads the record later: a cancelled visit is one that was scheduled and
 * deliberately called off — a customer postponed, a site was inaccessible — and
 * that is a fact worth keeping. Deleting it would say it never existed;
 * archiving says it is finished.
 */
router.post(
  '/:id/cancel',
  requireAuth,
  requirePermission(Permission.INSPECTION_UPDATE_ANY),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ reason: z.string().max(2000).optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const reason = (req.validated!.body as { reason?: string } | undefined)?.reason;

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    const CANCELLABLE: string[] = [
      InspectionStatus.DRAFT,
      InspectionStatus.SCHEDULED,
      InspectionStatus.IN_PROGRESS,
      InspectionStatus.REJECTED,
    ];
    if (!CANCELLABLE.includes(inspection.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `An inspection that is ${inspection.status.toLowerCase().replace(/_/g, ' ')} cannot be cancelled.`,
      );
    }

    const updated = await applyStatus(req, inspection, InspectionStatus.CANCELLED, reason);
    res.json({ data: updated });
  }),
);

/**
 * Reopen a cancelled inspection, putting it back in the inspector's list.
 *
 * Returns to SCHEDULED rather than to whatever it was before: the work has to
 * be planned again, and its previous progress — if any — is still attached.
 */
router.post(
  '/:id/reopen',
  requireAuth,
  requirePermission(Permission.INSPECTION_REOPEN),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ reason: z.string().max(2000).optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const reason = (req.validated!.body as { reason?: string } | undefined)?.reason;

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    const REOPENABLE: string[] = [InspectionStatus.CANCELLED, InspectionStatus.APPROVED];
    if (!REOPENABLE.includes(inspection.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'Only a cancelled or approved inspection can be reopened.',
      );
    }

    const updated = await applyStatus(req, inspection, InspectionStatus.SCHEDULED, reason);
    res.json({ data: updated });
  }),
);

/** The review conversation, oldest first — this is the record of what was asked. */
router.get(
  '/:id/comments',
  requireAuth,
  requirePermission(Permission.INSPECTION_READ),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true, assignedToId: true, projectId: true, createdById: true, orgId: true },
    });
    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    // An inspector may read the thread on their own work and nobody else's.
    if (!canAccessInspection(subject, inspection)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    }

    const comments = await prisma.inspectionComment.findMany({
      where: { inspectionId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        body: true,
        decision: true,
        createdAt: true,
        author: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.json({ data: comments });
  }),
);

/** Add a comment without making a review decision. */
router.post(
  '/:id/comments',
  requireAuth,
  requirePermission(Permission.INSPECTION_READ),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ body: z.string().min(1).max(2000).trim() }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { body } = req.validated!.body as { body: string };

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true, assignedToId: true, projectId: true, createdById: true, orgId: true },
    });
    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    if (!canAccessInspection(subject, inspection)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    }

    const comment = await prisma.inspectionComment.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        inspectionId: id,
        authorId: subject.userId,
        body,
      },
      select: {
        id: true,
        body: true,
        decision: true,
        createdAt: true,
        author: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    res.status(201).json({ data: comment });
  }),
);

/**
 * Duplicate an inspection.
 *
 * Metadata only — answers are never copied. An inspection is evidence of a
 * specific visit, and pre-filling last month's findings is precisely how false
 * records get created.
 */
router.post(
  '/:id/duplicate',
  requireAuth,
  requirePermission(Permission.INSPECTION_CREATE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z
      .object({
        title: z.string().max(300).optional(),
        assignedToId: schemas.ulid.nullable().optional(),
        scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
        dueAt: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = (req.validated!.body ?? {}) as {
      title?: string;
      assignedToId?: string | null;
      scheduledFor?: string | null;
      dueAt?: string | null;
    };

    const source = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!source || !canAccessInspection(subject, source)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    }

    // The copy starts on the template's *current* published version, not the
    // source's pinned one — otherwise duplicating an old job silently
    // reintroduces a retired checklist.
    const template = await prisma.template.findFirst({
      where: { id: source.templateId, orgId: subject.orgId },
      select: { activeVersionId: true },
    });

    const created = await prisma.$transaction(async (tx) => {
      const seq = await tx.$queryRaw<
        Array<{ number_sequence: number; number_prefix: string; number_year: number }>
      >`
        UPDATE organizations
           SET "numberSequence" = CASE WHEN "numberYear" = EXTRACT(YEAR FROM NOW())::int
                                       THEN "numberSequence" + 1 ELSE 1 END,
               "numberYear"     = EXTRACT(YEAR FROM NOW())::int
         WHERE id = ${subject.orgId}
        RETURNING "numberSequence" AS number_sequence, "numberPrefix" AS number_prefix, "numberYear" AS number_year
      `;
      const row = seq[0]!;
      const number = `${row.number_prefix}-${row.number_year}-${String(row.number_sequence).padStart(6, '0')}`;
      const newId = ulid();

      const inspection = await tx.inspection.create({
        data: {
          id: newId,
          orgId: subject.orgId,
          number,
          templateId: source.templateId,
          templateVersionId: template?.activeVersionId ?? source.templateVersionId,
          projectId: source.projectId,
          clientId: source.clientId,
          siteId: source.siteId,
          assetId: source.assetId,
          title: body.title ?? `${source.title} (copy)`,
          status: InspectionStatus.DRAFT,
          priority: source.priority,
          category: source.category,
          department: source.department,
          tags: source.tags,
          assignedToId: body.assignedToId !== undefined ? body.assignedToId : source.assignedToId,
          createdById: subject.userId,
          scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          dueAt: body.dueAt ? new Date(body.dueAt) : null,
          duplicatedFromId: source.id,
        },
      });

      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.CREATE,
        entityId: inspection.id,
        version: inspection.version,
        row: inspection,
        projectId: inspection.projectId,
        assignedToId: inspection.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      return inspection;
    });

    res.status(201).json({ data: created });
  }),
);

/** Archive / unarchive. */
router.post(
  '/:id/archive',
  requireAuth,
  requirePermission(Permission.INSPECTION_ARCHIVE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ archived: z.boolean().default(true) }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const archived = (req.validated!.body as { archived?: boolean } | undefined)?.archived ?? true;

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!inspection || !canAccessInspection(subject, inspection)) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.inspection.update({
        where: { id },
        data: { isArchived: archived, version: { increment: 1 } },
      });
      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.UPDATE,
        entityId: id,
        version: row.version,
        row,
        projectId: row.projectId,
        assignedToId: row.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });
      return row;
    });

    res.json({ data: updated });
  }),
);

/** Review decision: approve or reject a submitted inspection. */
router.post(
  '/:id/review',
  requireAuth,
  requirePermission(Permission.INSPECTION_REVIEW),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_CHANGES']),
      reason: z.string().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { decision, reason } = req.validated!.body as {
      decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES';
      reason?: string;
    };
    /*
     * REQUEST_CHANGES lands on the same status as REJECT — the inspection goes
     * back to the inspector either way, and the state machine has one
     * transition for that. What differs is intent, and intent is what the
     * person receiving it needs: "this is wrong" and "add the north elevation
     * photo" call for different responses. The decision is recorded on the
     * comment and in the audit entry so the two stay distinguishable.
     */
    const sendsBack = decision !== 'APPROVE';

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    if (sendsBack && !reason?.trim()) {
      // A rejection without a reason is unusable to the inspector who has to
      // act on it, so it is refused rather than accepted silently.
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'A reason is required when rejecting an inspection.',
        {
          fields: { reason: 'Explain what needs to change.' },
        },
      );
    }

    const target = decision === 'APPROVE' ? InspectionStatus.APPROVED : InspectionStatus.REJECTED;

    // The shared state machine is the authority on legal transitions.
    assertTransition(
      {
        subject,
        inspection: {
          id: inspection.id,
          status: inspection.status as InspectionStatus,
          assignedToId: inspection.assignedToId,
          projectId: inspection.projectId,
          totalFields: inspection.totalFields,
          answeredFields: inspection.answeredFields,
          criticalFailures: inspection.criticalFailures,
        },
      },
      target,
    );

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.inspection.update({
        where: { id },
        data: {
          status: target,
          reviewedById: subject.userId,
          reviewedAt: new Date(),
          rejectionReason: sendsBack ? (reason ?? null) : null,
          version: { increment: 1 },
        },
      });

      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.UPDATE,
        entityId: id,
        version: row.version,
        row,
        projectId: row.projectId,
        assignedToId: row.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      // The thread is what an inspector actually acts on. "Rejected" alone
      // sends somebody back to site without telling them what to change.
      if (reason?.trim()) {
        await tx.inspectionComment.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            inspectionId: id,
            authorId: subject.userId,
            body: reason.trim(),
            decision,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: decision === 'APPROVE' ? 'INSPECTION_APPROVED' : 'INSPECTION_REJECTED',
          entity: 'Inspection',
          entityId: id,
          metadata: { decision, reason: reason ?? null, number: inspection.number },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return row;
    });

    // Fired after the transaction commits, never inside it: a push failure must
    // not roll back a review decision that has already been made.
    if (updated.assignedToId) {
      void notifyInspectionReviewed({
        orgId: subject.orgId,
        assigneeId: updated.assignedToId,
        inspectionId: updated.id,
        number: updated.number,
        approved: decision === 'APPROVE',
        reason: reason ?? null,
      });
    }

    res.json({ data: updated });
  }),
);

/**
 * Bulk operations.
 *
 * Capped at 200 ids: a bulk assign across ten thousand records belongs in a
 * background job, and letting it run inline would hold a transaction open long
 * enough to block sync pushes.
 */
router.post(
  '/bulk',
  requireAuth,
  requirePermission(Permission.INSPECTION_UPDATE_ANY),
  validate({
    body: z.object({
      ids: z.array(schemas.ulid).min(1).max(200),
      action: z.enum([
        'ASSIGN',
        'ARCHIVE',
        'UNARCHIVE',
        'SET_PRIORITY',
        'SET_DUE_DATE',
        'ADD_TAGS',
        'DELETE',
        'CANCEL',
        'SET_STATUS',
      ]),
      assignedToId: schemas.ulid.nullable().optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
      /*
       * Only the statuses an administrator legitimately sets in bulk. Anything
       * further along asserts that work happened — a batch that marked fifty
       * inspections APPROVED would be fifty sign-offs nobody performed.
       */
      status: z.enum(['DRAFT', 'SCHEDULED']).optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as {
      ids: string[];
      action: string;
      status?: string;
      assignedToId?: string | null;
      priority?: Priority;
      dueAt?: string | null;
      tags?: string[];
    };

    if (body.action === 'DELETE' && !can(subject, Permission.INSPECTION_DELETE)) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to delete inspections.',
      );
    }

    // Only touch rows the caller can actually see.
    const targets = await prisma.inspection.findMany({
      where: { id: { in: body.ids }, orgId: subject.orgId, deletedAt: null },
      select: {
        id: true,
        orgId: true,
        assignedToId: true,
        projectId: true,
        createdById: true,
        tags: true,
      },
    });

    const permitted = targets.filter((t) => canAccessInspection(subject, t));
    const skipped = body.ids.filter((id) => !permitted.some((p) => p.id === id));

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];

    for (const target of permitted) {
      try {
        await prisma.$transaction(async (tx) => {
          const data: Prisma.InspectionUncheckedUpdateInput = { version: { increment: 1 } };

          switch (body.action) {
            case 'ASSIGN':
              data.assignedToId = body.assignedToId ?? null;
              break;
            case 'ARCHIVE':
              data.isArchived = true;
              break;
            case 'UNARCHIVE':
              data.isArchived = false;
              break;
            case 'SET_PRIORITY':
              data.priority = body.priority;
              break;
            case 'SET_DUE_DATE':
              data.dueAt = body.dueAt ? new Date(body.dueAt) : null;
              break;
            case 'ADD_TAGS':
              // Union rather than replace — bulk tagging is additive by intent.
              data.tags = Array.from(new Set([...target.tags, ...(body.tags ?? [])]));
              break;
            case 'CANCEL':
              // Distinct from delete: the visit was scheduled and called off,
              // which is a fact the record should keep.
              data.status = InspectionStatus.CANCELLED as never;
              break;
            case 'SET_STATUS':
              data.status = body.status as never;
              break;
            case 'DELETE':
              data.deletedAt = new Date();
              break;
          }

          const row = await tx.inspection.update({ where: { id: target.id }, data });

          await recordChange(tx, {
            orgId: subject.orgId,
            entity: SyncEntity.INSPECTION,
            operation: body.action === 'DELETE' ? SyncOperation.DELETE : SyncOperation.UPDATE,
            entityId: target.id,
            version: row.version,
            row: body.action === 'DELETE' ? null : row,
            projectId: row.projectId,
            assignedToId: row.assignedToId,
            actorUserId: subject.userId,
            actorDeviceId: subject.deviceId,
          });
        });
        results.push({ id: target.id, ok: true });
      } catch (err) {
        // One failure must not abandon the rest of the batch.
        results.push({
          id: target.id,
          ok: false,
          error: err instanceof Error ? err.message : 'Failed',
        });
      }
    }

    res.json({
      data: {
        succeeded: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        skipped: skipped.length,
        results,
        skippedIds: skipped,
      },
    });
  }),
);

export { router as inspectionsRouter };
