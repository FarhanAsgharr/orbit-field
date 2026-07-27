/**
 * Inspection requests — the customer's way in, and the reviewer's queue.
 *
 * One router, two audiences, because they act on the same record and splitting
 * them would mean two places to keep the status machine correct. Which
 * audience you are is decided by `subject.clientId`, not by the path: a client
 * account carries one and is narrowed to it on every query; staff carry none
 * and see the organisation's queue.
 *
 * The isolation here is a second boundary *inside* the tenant. Everything else
 * in Orbit Field scopes by organisation, and inside an organisation staff can
 * see everything their role allows. A customer must not — one client reading
 * another client's request is a disclosure between two companies who may be
 * competitors, and it would look like nothing in the response. So `clientScope`
 * is applied in the `where` of every query rather than checked afterwards, and
 * a request that does not match is a 404 rather than a 403: confirming a
 * record exists is itself a leak when the caller has no right to know.
 *
 * Approval creates the inspection. That is the whole point of the portal — a
 * request that is approved and then has to be typed in again by hand is a
 * queue, not a workflow — and it happens in the same transaction as the
 * decision, so an approved request without work is not a state that exists.
 */

import { AppError, ErrorCode, Permission } from '@orbit/shared';
import { InspectionStatus, type Priority, SyncEntity, SyncOperation } from '@orbit/types';
import { ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { paginate, paginationArgs, paginationSchema, searchFilter } from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import { notifyUsers } from '../notifications/push.service.js';
import { recordChange } from '../sync/change-log.js';
import { storage } from '../uploads/storage.js';
import { MAX_ATTACHMENTS_PER_REQUEST, validateDeclaration } from './attachment-rules.js';

const router: Router = Router();

/**
 * The customer filter, or nothing for staff.
 *
 * Spread into the `where` of every query that can reach a request. Applying it
 * in the query rather than checking the result afterwards means a missed call
 * site returns nothing instead of everything, which is the failure mode you
 * want when the alternative is one company reading another's file.
 */
function clientScope(subject: ReturnType<typeof auth>): { clientId?: string } {
  return subject.clientId ? { clientId: subject.clientId } : {};
}

/** True when this caller is a customer rather than a member of staff. */
const isCustomer = (subject: ReturnType<typeof auth>): boolean => Boolean(subject.clientId);

/**
 * Allocate the next request number.
 *
 * Reuses the organisation's inspection sequence deliberately: a customer
 * quoting "REQ-2026-000014" and an operator searching for it should not have
 * to care that requests and inspections are counted separately, and a single
 * sequence cannot produce two records claiming the same reference.
 */
async function allocateNumber(tx: Prisma.TransactionClient, orgId: string): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ number_sequence: number; number_year: number }>>`
    UPDATE organizations
       SET "numberSequence" = CASE WHEN "numberYear" = EXTRACT(YEAR FROM NOW())::int
                                   THEN "numberSequence" + 1 ELSE 1 END,
           "numberYear"     = EXTRACT(YEAR FROM NOW())::int
     WHERE id = ${orgId}
    RETURNING "numberSequence" AS number_sequence, "numberYear" AS number_year
  `;
  const row = rows[0]!;
  return `REQ-${row.number_year}-${String(row.number_sequence).padStart(6, '0')}`;
}

const listInclude = {
  client: { select: { id: true, name: true } },
  site: { select: { id: true, name: true } },
  asset: { select: { id: true, name: true, tag: true } },
  requestedBy: { select: { id: true, firstName: true, lastName: true } },
  reviewedBy: { select: { id: true, firstName: true, lastName: true } },
  inspection: { select: { id: true, number: true, status: true } },
  _count: { select: { attachments: true, comments: true } },
} satisfies Prisma.InspectionRequestInclude;

/**
 * The status a customer should see.
 *
 * A request has a life of its own until it is approved, after which what the
 * customer cares about is the inspection's progress — "approved" stops being
 * useful the moment somebody is on site. This collapses the two into the one
 * label they asked for, so the portal never shows a stale "Approved" against
 * work that was finished last week.
 */
function displayStatus(request: { status: string; inspection: { status: string } | null }): string {
  if (request.status !== 'APPROVED' || !request.inspection) return request.status;
  return request.inspection.status;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The queue, or the customer's own requests. */
router.get(
  '/',
  requireAuth,
  validate({
    query: paginationSchema.extend({
      status: z.string().max(40).optional(),
      search: z.string().max(200).optional(),
      clientId: schemas.ulid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as {
      page: number;
      pageSize: number;
      status?: string;
      search?: string;
      clientId?: string;
    };

    // A client asking to filter by another client's id gets their own scope
    // regardless — the spread wins because it comes last.
    const where: Prisma.InspectionRequestWhereInput = {
      orgId: subject.orgId,
      deletedAt: null,
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.search
        ? { OR: [{ title: searchFilter(q.search) }, { number: searchFilter(q.search) }] }
        : {}),
      ...clientScope(subject),
    };

    const [items, total] = await Promise.all([
      prisma.inspectionRequest.findMany({
        where,
        include: listInclude,
        orderBy: { createdAt: 'desc' },
        ...paginationArgs(q),
      }),
      prisma.inspectionRequest.count({ where }),
    ]);

    res.json({
      data: paginate(
        items.map((r) => ({ ...r, displayStatus: displayStatus(r) })),
        total,
        q,
      ),
    });
  }),
);

/** One request, with its conversation. */
router.get(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null, ...clientScope(subject) },
      include: {
        ...listInclude,
        attachments: {
          where: { deletedAt: null },
          select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
        },
        comments: {
          // A customer never sees a note staff wrote to each other.
          where: isCustomer(subject) ? { internal: false } : {},
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, firstName: true, lastName: true } } },
        },
      },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    res.json({ data: { ...request, displayStatus: displayStatus(request) } });
  }),
);

// ---------------------------------------------------------------------------
// The customer's side
// ---------------------------------------------------------------------------

/**
 * Ask for work.
 *
 * Open to staff as well, because an operator taking a request over the phone is
 * a real thing and should land in the same queue rather than a spreadsheet —
 * but staff must then say which customer it is for, since they have no
 * `clientId` of their own to infer it from.
 */
router.post(
  '/',
  requireAuth,
  validate({
    body: z.object({
      title: z.string().min(1).max(300).trim(),
      description: z.string().max(5000).nullable().optional(),
      inspectionType: z.string().max(120).nullable().optional(),
      specialInstructions: z.string().max(5000).nullable().optional(),
      siteId: schemas.ulid.nullable().optional(),
      assetId: schemas.ulid.nullable().optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
      preferredDate: z.string().datetime({ offset: true }).nullable().optional(),
      preferredTime: z.string().max(20).nullable().optional(),
      clientId: schemas.ulid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as {
      title: string;
      description?: string | null;
      inspectionType?: string | null;
      specialInstructions?: string | null;
      siteId?: string | null;
      assetId?: string | null;
      priority: string;
      preferredDate?: string | null;
      preferredTime?: string | null;
      clientId?: string;
    };

    // Never taken from the body for a customer: it is who they are, not what
    // they claim.
    const clientId = subject.clientId ?? body.clientId;
    if (!clientId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say which client this request is for.', {
        fields: { clientId: 'Required when you are not a client user.' },
      });
    }

    const client = await prisma.client.findFirst({
      where: { id: clientId, orgId: subject.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!client) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That client was not found.', {
        fields: { clientId: 'Not found in this organisation.' },
      });
    }

    /*
     * A site or asset must belong to this customer.
     *
     * Otherwise a request is a way to discover another company's sites by
     * guessing ids and reading which ones are accepted.
     */
    if (body.siteId) {
      const site = await prisma.site.findFirst({
        where: { id: body.siteId, orgId: subject.orgId, deletedAt: null },
        select: { clientId: true },
      });
      if (!site || (isCustomer(subject) && site.clientId !== clientId)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That site was not found.', {
          fields: { siteId: 'Not one of your sites.' },
        });
      }
    }
    if (body.assetId) {
      const asset = await prisma.asset.findFirst({
        where: { id: body.assetId, orgId: subject.orgId, deletedAt: null },
        select: { site: { select: { clientId: true } } },
      });
      if (!asset || (isCustomer(subject) && asset.site?.clientId !== clientId)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That asset was not found.', {
          fields: { assetId: 'Not one of your assets.' },
        });
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const number = await allocateNumber(tx, subject.orgId);
      const id = ulid();

      const request = await tx.inspectionRequest.create({
        data: {
          id,
          orgId: subject.orgId,
          clientId,
          number,
          title: body.title,
          description: body.description ?? null,
          inspectionType: body.inspectionType ?? null,
          specialInstructions: body.specialInstructions ?? null,
          siteId: body.siteId ?? null,
          assetId: body.assetId ?? null,
          priority: body.priority as Priority,
          status: 'PENDING_APPROVAL',
          preferredDate: body.preferredDate ? new Date(body.preferredDate) : null,
          preferredTime: body.preferredTime ?? null,
          requestedById: subject.userId,
        },
        include: listInclude,
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_CREATED',
          entity: 'InspectionRequest',
          entityId: id,
          metadata: { number, clientId, title: body.title },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return request;
    });

    /*
     * Tell the people who can act on it.
     *
     * A request nobody is told about sits in a queue until somebody happens to
     * look, which for an urgent one is the difference between a visit tomorrow
     * and a visit next week.
     */
    const reviewers = await prisma.user.findMany({
      where: {
        orgId: subject.orgId,
        status: 'ACTIVE',
        deletedAt: null,
        role: { in: ['SUPER_ADMIN', 'ADMIN', 'MANAGER'] },
      },
      select: { id: true },
    });
    void notifyUsers(
      subject.orgId,
      reviewers.map((u) => u.id),
      {
        topic: 'INSPECTION_ASSIGNED' as never,
        title: `New inspection request ${created.number}`,
        body: created.title,
        data: { requestId: created.id },
      },
    ).catch(() => undefined);

    res.status(201).json({ data: { ...created, displayStatus: displayStatus(created) } });
  }),
);

/** Add to the conversation. Customers post replies; staff post either. */
router.post(
  '/:id/comments',
  requireAuth,
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      body: z.string().min(1).max(5000).trim(),
      internal: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { body, internal } = req.validated!.body as { body: string; internal: boolean };

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null, ...clientScope(subject) },
      select: { id: true, status: true, clientId: true, number: true, requestedById: true },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    const comment = await prisma.requestComment.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        requestId: id,
        authorId: subject.userId,
        body,
        // A customer cannot mark anything internal — the flag would hide their
        // own words from them.
        internal: isCustomer(subject) ? false : internal,
      },
      include: { author: { select: { id: true, firstName: true, lastName: true } } },
    });

    /*
     * A customer answering a question moves the request back into the queue.
     * Leaving it at INFORMATION_REQUESTED would mean the reply is never seen,
     * because that is the status reviewers filter out.
     */
    if (isCustomer(subject) && request.status === 'INFORMATION_REQUESTED') {
      await prisma.inspectionRequest.update({
        where: { id },
        data: { status: 'PENDING_APPROVAL' },
      });
    }

    res.status(201).json({ data: comment });
  }),
);

/** Withdraw a request that has not been decided yet. */
router.post(
  '/:id/cancel',
  requireAuth,
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ reason: z.string().max(2000).optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const reason = (req.validated!.body as { reason?: string } | undefined)?.reason;

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null, ...clientScope(subject) },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    if (!['PENDING_APPROVAL', 'INFORMATION_REQUESTED'].includes(request.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'Only a request that has not been decided can be withdrawn.',
      );
    }

    const updated = await prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'CANCELLED', decisionNote: reason ?? null },
      include: listInclude,
    });

    res.json({ data: { ...updated, displayStatus: displayStatus(updated) } });
  }),
);

// ---------------------------------------------------------------------------
// The reviewer's side
// ---------------------------------------------------------------------------

/**
 * Decide a request.
 *
 * Approval creates the inspection in the same transaction. An approved request
 * with no work behind it is not a state worth having: somebody would have to
 * notice and type it in, and the customer has already been told it is
 * happening.
 *
 * Gated on `INSPECTION_ASSIGN` — deciding what work exists and who does it is
 * the same authority, and it is exactly what a customer must not hold.
 */
router.post(
  '/:id/decide',
  requireAuth,
  requirePermission(Permission.INSPECTION_ASSIGN),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_INFORMATION']),
      note: z.string().max(2000).optional(),
      // Approval only.
      templateId: schemas.ulid.optional(),
      assignedToId: schemas.ulid.nullable().optional(),
      supervisorId: schemas.ulid.nullable().optional(),
      projectId: schemas.ulid.nullable().optional(),
      dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = req.validated!.body as {
      decision: 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION';
      note?: string;
      templateId?: string;
      assignedToId?: string | null;
      supervisorId?: string | null;
      projectId?: string | null;
      dueAt?: string | null;
    };

    // Staff only: a client reaching this would be approving their own work.
    if (isCustomer(subject)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'Requests are decided by the organisation.');
    }

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: { client: { select: { id: true } }, site: { select: { id: true, clientId: true } } },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    if (!['PENDING_APPROVAL', 'INFORMATION_REQUESTED'].includes(request.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `This request is already ${request.status.toLowerCase().replace(/_/g, ' ')}.`,
      );
    }

    if (body.decision !== 'APPROVE' && !body.note?.trim()) {
      // A rejection the customer cannot act on is worse than no answer.
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say why.', {
        fields: { note: 'Required when rejecting or asking for more information.' },
      });
    }

    if (body.decision === 'REQUEST_INFORMATION') {
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.inspectionRequest.update({
          where: { id },
          data: { status: 'INFORMATION_REQUESTED', decisionNote: body.note ?? null },
          include: listInclude,
        });
        await tx.requestComment.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            requestId: id,
            authorId: subject.userId,
            body: body.note!,
          },
        });
        return row;
      });

      void notifyRequester(request.requestedById, subject.orgId, {
        title: `More information needed on ${request.number}`,
        body: body.note!,
        requestId: id,
      });

      res.json({ data: { ...updated, displayStatus: displayStatus(updated) } });
      return;
    }

    if (body.decision === 'REJECT') {
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.inspectionRequest.update({
          where: { id },
          data: {
            status: 'REJECTED',
            decisionNote: body.note ?? null,
            reviewedById: subject.userId,
            reviewedAt: new Date(),
          },
          include: listInclude,
        });
        await tx.requestComment.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            requestId: id,
            authorId: subject.userId,
            body: body.note!,
          },
        });
        await tx.auditLog.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            userId: subject.userId,
            action: 'RECORD_UPDATED',
            entity: 'InspectionRequest',
            entityId: id,
            metadata: { decision: 'REJECT', number: request.number },
            ipAddress: clientIp(req),
            requestId: req.requestId,
          },
        });
        return row;
      });

      void notifyRequester(request.requestedById, subject.orgId, {
        title: `Request ${request.number} was declined`,
        body: body.note!,
        requestId: id,
      });

      res.json({ data: { ...updated, displayStatus: displayStatus(updated) } });
      return;
    }

    // --- approve: the request becomes work ---------------------------------
    if (!body.templateId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a checklist for the inspection.', {
        fields: { templateId: 'Required to approve a request.' },
      });
    }

    const template = await prisma.template.findFirst({
      where: { id: body.templateId, orgId: subject.orgId, deletedAt: null },
      select: { activeVersionId: true },
    });
    if (!template?.activeVersionId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That checklist is not published.', {
        fields: { templateId: 'Publish it before scheduling work against it.' },
      });
    }

    const approved = await prisma.$transaction(async (tx) => {
      const number = await allocateNumber(tx, subject.orgId);
      // The request's number is REQ-…; the inspection gets its own INS-… one.
      const inspectionNumber = number.replace(/^REQ-/, 'INS-');
      const inspectionId = ulid();

      const inspection = await tx.inspection.create({
        data: {
          id: inspectionId,
          orgId: subject.orgId,
          number: inspectionNumber,
          templateId: body.templateId!,
          templateVersionId: template.activeVersionId!,
          projectId: body.projectId ?? null,
          clientId: request.clientId,
          siteId: request.siteId,
          assetId: request.assetId,
          title: request.title,
          description: request.description,
          notes: request.specialInstructions,
          status: InspectionStatus.SCHEDULED as never,
          priority: request.priority,
          dueAt: body.dueAt ? new Date(body.dueAt) : request.preferredDate,
          scheduledAt: request.preferredDate,
          assignedToId: body.assignedToId ?? null,
          supervisorId: body.supervisorId ?? null,
          createdById: subject.userId,
        },
      });

      // Devices replay the change log and nothing else — without this the
      // inspector is never told the job exists.
      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.INSPECTION,
        operation: SyncOperation.CREATE,
        entityId: inspectionId,
        version: inspection.version,
        row: inspection,
        projectId: inspection.projectId,
        assignedToId: inspection.assignedToId,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      /*
       * The customer's files become the inspection's.
       *
       * A foreign-key update, not a copy: the rows and the objects in storage
       * are the ones the customer uploaded, so nothing is transferred twice
       * and the checksums still describe the bytes they sent. `requestId` is
       * kept so the provenance survives.
       */
      const carried = await tx.attachment.findMany({
        where: { requestId: id, deletedAt: null },
        select: { id: true, version: true },
      });
      if (carried.length > 0) {
        await tx.attachment.updateMany({
          where: { requestId: id, deletedAt: null },
          data: { inspectionId, version: { increment: 1 } },
        });

        /*
         * Devices replay the change log and nothing else, so without this the
         * inspector arrives on site without the drawing the customer sent.
         */
        for (const attachment of carried) {
          const row = await tx.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
          await recordChange(tx, {
            orgId: subject.orgId,
            entity: SyncEntity.ATTACHMENT,
            operation: SyncOperation.CREATE,
            entityId: attachment.id,
            version: row.version,
            row,
            assignedToId: body.assignedToId ?? null,
            actorUserId: subject.userId,
            actorDeviceId: subject.deviceId,
          });
        }
      }

      const row = await tx.inspectionRequest.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedById: subject.userId,
          reviewedAt: new Date(),
          decisionNote: body.note ?? null,
          inspectionId,
        },
        include: listInclude,
      });

      if (body.note?.trim()) {
        await tx.requestComment.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            requestId: id,
            authorId: subject.userId,
            body: body.note,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_UPDATED',
          entity: 'InspectionRequest',
          entityId: id,
          metadata: {
            decision: 'APPROVE',
            number: request.number,
            inspectionId,
            inspectionNumber,
          },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return row;
    });

    void notifyRequester(request.requestedById, subject.orgId, {
      title: `Request ${request.number} was approved`,
      body: 'An inspection has been scheduled.',
      requestId: id,
    });

    if (body.assignedToId) {
      void notifyUsers(subject.orgId, [body.assignedToId], {
        topic: 'INSPECTION_ASSIGNED' as never,
        title: 'New inspection assigned',
        body: request.title,
        data: { inspectionId: approved.inspectionId ?? '' },
      }).catch(() => undefined);
    }

    res.json({ data: { ...approved, displayStatus: displayStatus(approved) } });
  }),
);

/** Tell the customer what happened. Never throws — a push must not fail a decision. */
function notifyRequester(
  userId: string,
  orgId: string,
  message: { title: string; body: string; requestId: string },
): void {
  void notifyUsers(orgId, [userId], {
    topic: 'INSPECTION_ASSIGNED' as never,
    title: message.title,
    body: message.body,
    data: { requestId: message.requestId },
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/**
 * Declare a file, then upload it through the existing pipeline.
 *
 * Two steps rather than one, and reusing `Attachment` rather than a table of
 * its own, because everything a request attachment needs already exists for
 * inspection attachments: chunked transfer with resume, checksum verification,
 * storage keys, content serving, replication to devices, and the reports
 * section that lists them. A parallel implementation would be a second copy of
 * all of it, drifting.
 *
 * The payoff shows up at approval: carrying the customer's files into the
 * inspection is a foreign-key update, not a copy. One row, one object in
 * storage, two owners over its life — which is what "no duplicate uploads"
 * actually requires.
 *
 * This endpoint validates and reserves. The bytes go to `POST /uploads` and
 * `/uploads/:id/chunks/:index` exactly as a phone's photographs do.
 */
router.post(
  '/:id/attachments',
  requireAuth,
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      fileName: z.string().min(1).max(300),
      mimeType: z.string().min(1).max(120),
      sizeBytes: z.number().int().positive(),
      checksum: z.string().regex(/^[a-f0-9]{64}$/i),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = req.validated!.body as {
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      checksum: string;
    };

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null, ...clientScope(subject) },
      select: { id: true, status: true, clientId: true },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    /*
     * Files may be added while the request is still open.
     *
     * After a decision the request is either work in progress — where the
     * inspection is the right place for new evidence — or closed, where adding
     * to it would change what was decided after the fact.
     */
    if (!['PENDING_APPROVAL', 'INFORMATION_REQUESTED'].includes(request.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'This request has been decided and cannot take new files.',
      );
    }

    // Type, size, extension and executable rules, before a byte is accepted.
    const { fileName } = validateDeclaration(body);

    const existing = await prisma.attachment.count({
      where: { requestId: id, deletedAt: null },
    });
    if (existing >= MAX_ATTACHMENTS_PER_REQUEST) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `A request can carry ${MAX_ATTACHMENTS_PER_REQUEST} files. Remove one before adding another.`,
      );
    }

    /*
     * The same bytes attached twice are the same row.
     *
     * `checksum` is already the dedupe key for inspection attachments; using
     * it here means a customer who submits the form twice, or retries after a
     * timeout, does not end up with two copies of the same drawing.
     */
    const duplicate = await prisma.attachment.findFirst({
      where: { requestId: id, checksum: body.checksum, deletedAt: null },
      select: { id: true, fileName: true, state: true, storageKey: true },
    });
    if (duplicate) {
      res.status(200).json({ data: { ...duplicate, duplicate: true } });
      return;
    }

    const attachment = await prisma.attachment.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        requestId: id,
        kind: 'DOCUMENT' as never,
        state: 'QUEUED' as never,
        fileName,
        mimeType: body.mimeType,
        sizeBytes: BigInt(body.sizeBytes),
        checksum: body.checksum,
      },
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, state: true },
    });

    await prisma.auditLog.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        userId: subject.userId,
        action: 'FILE_UPLOADED',
        entity: 'Attachment',
        entityId: attachment.id,
        metadata: { requestId: id, fileName, sizeBytes: body.sizeBytes },
        ipAddress: clientIp(req),
        requestId: req.requestId,
      },
    });

    res.status(201).json({ data: { ...attachment, sizeBytes: Number(attachment.sizeBytes) } });
  }),
);

/** What is attached to a request. */
router.get(
  '/:id/attachments',
  requireAuth,
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null, ...clientScope(subject) },
      select: { id: true },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    const attachments = await prisma.attachment.findMany({
      where: { requestId: id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        sizeBytes: true,
        state: true,
        storageKey: true,
        uploadedAt: true,
        createdAt: true,
      },
    });

    res.json({
      data: attachments.map((a) => ({
        ...a,
        sizeBytes: Number(a.sizeBytes),
        // The key itself is never useful to a caller and naming it invites
        // somebody to try fetching it directly.
        storageKey: undefined,
        uploaded: a.storageKey !== null,
      })),
    });
  }),
);

/**
 * Remove a file from a request.
 *
 * Only while the request is still open. Once it has been approved the file
 * belongs to an inspection, and deleting evidence from work in progress is not
 * something a customer does — the inspection's own rules govern it from then
 * on.
 */
router.delete(
  '/:id/attachments/:attachmentId',
  requireAuth,
  validate({ params: z.object({ id: schemas.ulid, attachmentId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id, attachmentId } = req.validated!.params as { id: string; attachmentId: string };

    const request = await prisma.inspectionRequest.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null, ...clientScope(subject) },
      select: { id: true, status: true },
    });
    if (!request) throw new AppError(ErrorCode.NOT_FOUND, 'That request was not found.');

    if (!['PENDING_APPROVAL', 'INFORMATION_REQUESTED'].includes(request.status)) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'This request has been decided. Its files are part of the record.',
      );
    }

    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, requestId: id, deletedAt: null },
      select: { id: true, fileName: true, storageKey: true },
    });
    if (!attachment) throw new AppError(ErrorCode.NOT_FOUND, 'That file was not found.');

    await prisma.attachment.update({
      where: { id: attachmentId },
      data: { deletedAt: new Date() },
    });

    // The object goes too: an unreferenced file is a bill with no purpose.
    if (attachment.storageKey) {
      await storage()
        .delete(attachment.storageKey)
        .catch(() => undefined);
    }

    await prisma.auditLog.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        userId: subject.userId,
        action: 'FILE_DELETED',
        entity: 'Attachment',
        entityId: attachmentId,
        metadata: { requestId: id, fileName: attachment.fileName },
        ipAddress: clientIp(req),
        requestId: req.requestId,
      },
    });

    res.status(204).end();
  }),
);

/** Counts for the customer's dashboard, in one query rather than six. */
router.get(
  '/meta/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const where = { orgId: subject.orgId, deletedAt: null, ...clientScope(subject) };

    const grouped = await prisma.inspectionRequest.groupBy({
      by: ['status'],
      where,
      _count: true,
    });

    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count]));

    // Inspections the customer can see, by status — what the request became.
    const inspectionWhere: Prisma.InspectionWhereInput = {
      orgId: subject.orgId,
      deletedAt: null,
      ...(subject.clientId ? { clientId: subject.clientId } : {}),
    };
    const inspections = await prisma.inspection.groupBy({
      by: ['status'],
      where: inspectionWhere,
      _count: true,
    });

    res.json({
      data: {
        requests: {
          pending: counts.PENDING_APPROVAL ?? 0,
          informationRequested: counts.INFORMATION_REQUESTED ?? 0,
          approved: counts.APPROVED ?? 0,
          rejected: counts.REJECTED ?? 0,
          cancelled: counts.CANCELLED ?? 0,
        },
        inspections: Object.fromEntries(inspections.map((g) => [g.status, g._count])),
      },
    });
  }),
);

export { router as inspectionRequestsRouter };
