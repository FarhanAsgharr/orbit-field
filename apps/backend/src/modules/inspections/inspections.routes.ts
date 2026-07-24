/**
 * Inspection REST API.
 *
 * This is the read/admin surface. Field devices do not use it — they create and
 * edit through the sync engine, which owns conflict detection and the outbox.
 * Anything here that mutates therefore has to write a change-log entry itself,
 * or offline devices would never learn about the change.
 */

import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  InspectionStatus,
  SyncEntity,
  SyncOperation,
  type Priority,
} from '@orbit/types';
import {
  AppError,
  ErrorCode,
  Permission,
  assertTransition,
  can,
  canAccessInspection,
} from '@orbit/shared';
import { ulid } from '@orbit/utils';
import { prisma } from '../../db/prisma.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import { csvArray, dateRange, paginate, paginationArgs, paginationSchema, searchFilter, sortArgs } from '../../lib/pagination.js';
import { recordChange } from '../sync/change-log.js';
import { notifyInspectionReviewed } from '../notifications/push.service.js';

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
      ...(dateRange(q.createdFrom, q.createdTo) ? { createdAt: dateRange(q.createdFrom, q.createdTo) } : {}),
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
      entity: { in: [SyncEntity.INSPECTION, SyncEntity.RESPONSE, SyncEntity.ATTACHMENT, SyncEntity.SIGNATURE] },
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
    const actorIds = Array.from(new Set(entries.map((e) => e.actorUserId).filter(Boolean))) as string[];
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
    body: z.object({
      title: z.string().max(300).optional(),
      assignedToId: schemas.ulid.nullable().optional(),
      scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = (req.validated!.body ?? {}) as { title?: string; assignedToId?: string | null; scheduledFor?: string | null; dueAt?: string | null };

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
      const seq = await tx.$queryRaw<Array<{ number_sequence: number; number_prefix: string; number_year: number }>>`
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
      decision: z.enum(['APPROVE', 'REJECT']),
      reason: z.string().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { decision, reason } = req.validated!.body as { decision: 'APPROVE' | 'REJECT'; reason?: string };

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    if (decision === 'REJECT' && !reason?.trim()) {
      // A rejection without a reason is unusable to the inspector who has to
      // act on it, so it is refused rather than accepted silently.
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A reason is required when rejecting an inspection.', {
        fields: { reason: 'Explain what needs to change.' },
      });
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
          rejectionReason: decision === 'REJECT' ? (reason ?? null) : null,
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
          action: decision === 'APPROVE' ? 'INSPECTION_APPROVED' : 'INSPECTION_REJECTED',
          entity: 'Inspection',
          entityId: id,
          metadata: { reason: reason ?? null, number: inspection.number },
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
      action: z.enum(['ASSIGN', 'ARCHIVE', 'UNARCHIVE', 'SET_PRIORITY', 'SET_DUE_DATE', 'ADD_TAGS', 'DELETE']),
      assignedToId: schemas.ulid.nullable().optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as {
      ids: string[];
      action: string;
      assignedToId?: string | null;
      priority?: Priority;
      dueAt?: string | null;
      tags?: string[];
    };

    if (body.action === 'DELETE' && !can(subject, Permission.INSPECTION_DELETE)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You do not have permission to delete inspections.');
    }

    // Only touch rows the caller can actually see.
    const targets = await prisma.inspection.findMany({
      where: { id: { in: body.ids }, orgId: subject.orgId, deletedAt: null },
      select: { id: true, orgId: true, assignedToId: true, projectId: true, createdById: true, tags: true },
    });

    const permitted = targets.filter((t) => canAccessInspection(subject, t));
    const skipped = body.ids.filter((id) => !permitted.some((p) => p.id === id));

    const results: Array<{ id: string; ok: boolean; error?: string }> = [];

    for (const target of permitted) {
      try {
        await prisma.$transaction(async (tx) => {
          let data: Prisma.InspectionUncheckedUpdateInput = { version: { increment: 1 } };

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
        results.push({ id: target.id, ok: false, error: err instanceof Error ? err.message : 'Failed' });
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
