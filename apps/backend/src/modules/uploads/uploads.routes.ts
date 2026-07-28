/**
 * Chunked resumable upload endpoints.
 *
 * The server half of the mobile uploader. Contract, in the order a client uses it:
 *
 *   POST /uploads                      open or resume a session
 *   GET  /uploads/:uploadId            what has the server actually got?
 *   POST /uploads/:uploadId/chunks/:i  send one chunk (idempotent)
 *   POST /uploads/:uploadId/complete   assemble, verify checksum, publish
 *
 * The server is the authority on which chunks it holds. A client that asks
 * rather than assuming is what makes resume correct after a crash, and chunk
 * writes are idempotent so a client that re-sends after a lost ack is harmless.
 */

import { createHash } from 'node:crypto';

import { AppError, can, ErrorCode, Permission } from '@orbit/shared';
import { AttachmentState, type UploadSession } from '@orbit/types';
import { ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { requireAuth, requireDevice, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { uploadLimiter } from '../../middleware/rate-limit.js';
import { schemas, validate } from '../../middleware/validate.js';
import { dispositionFor, validateContent } from '../client-portal/attachment-rules.js';
import { attachmentKey, storage } from './storage.js';

const router: Router = Router();

/**
 * Who may put bytes against an attachment.
 *
 * `INSPECTION_UPDATE` is the right test for staff and for devices: uploading a
 * photograph is part of editing an inspection. It is the wrong test for a
 * customer, who must never edit an inspection and yet must be able to send the
 * drawing that accompanies their request.
 *
 * So the gate asks the question the endpoint actually cares about. A client is
 * admitted here and then narrowed by `attachmentScope` in the handler, which
 * restricts them to files hanging off their own request or their own
 * inspection — being let through this door does not decide which files they
 * reach.
 */
const requireUploadAccess = asyncHandler(async (req, _res, next) => {
  const subject = auth(req);
  if (subject.clientId || can(subject, Permission.INSPECTION_UPDATE)) return next();
  throw new AppError(
    ErrorCode.PERMISSION_DENIED,
    'You do not have permission to upload against this record.',
  );
});

/**
 * Narrow an attachment lookup to what this caller may reach.
 *
 * Staff are unaffected. A customer may reach a file only through something of
 * theirs — a request they raised, or an inspection carried out for their
 * company. Without this the endpoint scopes by organisation alone, and any
 * client account could read every file in the installation by guessing ids.
 */
function attachmentScope(subject: ReturnType<typeof auth>): Prisma.AttachmentWhereInput {
  if (!subject.clientId) return {};
  return {
    OR: [
      { request: { clientId: subject.clientId } },
      { inspection: { clientId: subject.clientId } },
    ],
  };
}

/** Chunk payloads are base64 in JSON; the ceiling accounts for that inflation. */
const MAX_CHUNK_BASE64_BYTES = Math.ceil((env.UPLOAD_CHUNK_SIZE_BYTES * 4) / 3) + 1024;

function toSession(row: {
  attachmentId: string;
  id: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  expiresAt: Date;
}): UploadSession {
  return {
    attachmentId: row.attachmentId,
    uploadId: row.id,
    chunkSize: row.chunkSize,
    totalChunks: row.totalChunks,
    receivedChunks: [...row.receivedChunks].sort((a, b) => a - b),
    expiresAt: row.expiresAt.toISOString() as UploadSession['expiresAt'],
  };
}

/**
 * Open or resume an upload session.
 *
 * Idempotent per attachment: calling it twice returns the same session with the
 * chunks already received, which is exactly what a resuming client needs.
 */
router.post(
  '/',
  requireAuth,
  requireDevice,
  requireUploadAccess,
  uploadLimiter,
  validate({
    body: z.object({
      attachmentId: schemas.ulid,
      sizeBytes: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
      checksum: z.string().regex(/^[a-f0-9]{64}$/i, 'Checksum must be a SHA-256 hex digest'),
      chunkSize: z.number().int().positive().max(env.UPLOAD_CHUNK_SIZE_BYTES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as {
      attachmentId: string;
      sizeBytes: number;
      checksum: string;
      chunkSize?: number;
    };

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: body.attachmentId,
        orgId: subject.orgId,
        deletedAt: null,
        ...attachmentScope(subject),
      },
      select: {
        id: true,
        fileName: true,
        checksum: true,
        state: true,
        storageKey: true,
        sizeBytes: true,
      },
    });
    if (!attachment) {
      throw new AppError(
        ErrorCode.NOT_FOUND,
        'That attachment record was not found. Sync it before uploading.',
      );
    }

    // Already uploaded — tell the client it is done rather than re-transferring
    // megabytes it does not need to.
    if (attachment.state === AttachmentState.UPLOADED && attachment.storageKey) {
      res.status(200).json({
        data: {
          attachmentId: attachment.id,
          uploadId: 'already-complete',
          chunkSize: env.UPLOAD_CHUNK_SIZE_BYTES,
          totalChunks: 0,
          receivedChunks: [],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          complete: true,
          storageKey: attachment.storageKey,
        },
      });
      return;
    }

    // Content-addressed dedupe: if another attachment in this org already holds
    // these exact bytes, point at them instead of uploading again.
    const duplicate = await prisma.attachment.findFirst({
      where: {
        orgId: subject.orgId,
        checksum: body.checksum,
        state: AttachmentState.UPLOADED,
        storageKey: { not: null },
        NOT: { id: attachment.id },
        deletedAt: null,
      },
      select: { storageKey: true },
    });

    if (duplicate?.storageKey) {
      await prisma.attachment.update({
        where: { id: attachment.id },
        data: {
          state: AttachmentState.UPLOADED,
          storageKey: duplicate.storageKey,
          uploadedAt: new Date(),
        },
      });
      logger.info({ attachmentId: attachment.id, checksum: body.checksum }, 'upload deduplicated');
      res.status(200).json({
        data: {
          attachmentId: attachment.id,
          uploadId: 'deduplicated',
          chunkSize: env.UPLOAD_CHUNK_SIZE_BYTES,
          totalChunks: 0,
          receivedChunks: [],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          complete: true,
          storageKey: duplicate.storageKey,
        },
      });
      return;
    }

    const existing = await prisma.uploadSession.findUnique({
      where: { attachmentId: attachment.id },
    });

    if (existing && existing.expiresAt.getTime() > Date.now() && !existing.completedAt) {
      res.status(200).json({ data: toSession({ ...existing, id: existing.id }) });
      return;
    }

    // Replace an expired or completed session rather than leaving a stale row.
    if (existing) {
      await storage()
        .discard(existing.id)
        .catch(() => undefined);
      await prisma.uploadSession.delete({ where: { id: existing.id } }).catch(() => undefined);
    }

    const chunkSize = body.chunkSize ?? env.UPLOAD_CHUNK_SIZE_BYTES;
    const totalChunks = Math.max(1, Math.ceil(body.sizeBytes / chunkSize));

    const session = await prisma.uploadSession.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        attachmentId: attachment.id,
        deviceId: subject.deviceId!,
        chunkSize,
        totalChunks,
        totalBytes: BigInt(body.sizeBytes),
        receivedChunks: [],
        expiresAt: new Date(Date.now() + env.UPLOAD_SESSION_TTL_HOURS * 3_600_000),
      },
    });

    await prisma.attachment.update({
      where: { id: attachment.id },
      data: { state: AttachmentState.UPLOADING, checksum: body.checksum },
    });

    res.status(201).json({ data: toSession(session) });
  }),
);

/** Session state — the resume point. */
router.get(
  '/:uploadId',
  requireAuth,
  requireDevice,
  validate({ params: z.object({ uploadId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { uploadId } = req.validated!.params as { uploadId: string };

    const session = await prisma.uploadSession.findFirst({
      where: { id: uploadId, orgId: subject.orgId },
    });
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, 'That upload session was not found.');

    if (session.expiresAt.getTime() < Date.now()) {
      // 410 rather than 404: the client should open a fresh session, not treat
      // this as a permanent failure.
      throw new AppError(
        ErrorCode.UPLOAD_SESSION_EXPIRED,
        'That upload session has expired. Start a new one.',
      );
    }

    res.json({ data: toSession(session) });
  }),
);

/**
 * Receive one chunk.
 *
 * Idempotent: re-sending a chunk the server already holds is a no-op that
 * returns the same acknowledgement. A client that lost the response and retried
 * therefore converges rather than corrupting the assembly.
 */
router.post(
  '/:uploadId/chunks/:index',
  requireAuth,
  requireDevice,
  uploadLimiter,
  validate({
    params: z.object({
      uploadId: schemas.ulid,
      index: z.coerce.number().int().nonnegative(),
    }),
    body: z.object({
      data: z.string().max(MAX_CHUNK_BASE64_BYTES),
      /** Optional per-chunk digest; when present the server verifies it. */
      checksum: z
        .string()
        .regex(/^[a-f0-9]{64}$/i)
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { uploadId, index } = req.validated!.params as { uploadId: string; index: number };
    const body = req.validated!.body as { data: string; checksum?: string };

    const session = await prisma.uploadSession.findFirst({
      where: { id: uploadId, orgId: subject.orgId },
    });
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, 'That upload session was not found.');
    if (session.completedAt) {
      throw new AppError(ErrorCode.CONFLICT, 'That upload has already been completed.');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      throw new AppError(
        ErrorCode.UPLOAD_SESSION_EXPIRED,
        'That upload session has expired. Start a new one.',
      );
    }
    if (index >= session.totalChunks) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Chunk index ${index} is outside this upload (0–${session.totalChunks - 1}).`,
      );
    }

    // Already have it. Return the current state so the client can skip ahead.
    if (session.receivedChunks.includes(index)) {
      res.json({
        data: {
          uploadId,
          chunkIndex: index,
          receivedChunks: [...session.receivedChunks].sort((a, b) => a - b),
          complete: session.receivedChunks.length === session.totalChunks,
        },
      });
      return;
    }

    const buffer = Buffer.from(body.data, 'base64');

    if (buffer.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'The chunk payload was empty.');
    }
    if (buffer.length > session.chunkSize) {
      throw new AppError(
        ErrorCode.PAYLOAD_TOO_LARGE,
        `Chunk exceeds the agreed size of ${session.chunkSize} bytes.`,
      );
    }

    if (body.checksum) {
      const actual = createHash('sha256').update(buffer).digest('hex');
      if (actual !== body.checksum.toLowerCase()) {
        // A corrupt chunk must be rejected here, not discovered at assembly —
        // by then the client has sent everything else for nothing.
        throw new AppError(
          ErrorCode.CHECKSUM_MISMATCH,
          'The chunk did not match its checksum. Re-send it.',
        );
      }
    }

    await storage().putChunk(uploadId, index, buffer);

    // The chunk is durable in storage before the database records it. The
    // reverse order would let a crash leave the session claiming a chunk that
    // does not exist, which is unrecoverable without a full re-upload.
    const updated = await prisma.uploadSession.update({
      where: { id: uploadId },
      data: { receivedChunks: { push: index } },
    });

    res.json({
      data: {
        uploadId,
        chunkIndex: index,
        receivedChunks: [...updated.receivedChunks].sort((a, b) => a - b),
        complete: updated.receivedChunks.length === updated.totalChunks,
      },
    });
  }),
);

/**
 * Finalise.
 *
 * Assembles the chunks and verifies the whole-file checksum against what the
 * client declared when it opened the session. A mismatch fails the upload and
 * keeps the session open so the client can re-send, rather than publishing
 * corrupt evidence.
 */
router.post(
  '/:uploadId/complete',
  requireAuth,
  requireDevice,
  validate({
    params: z.object({ uploadId: schemas.ulid }),
    body: z.object({ checksum: z.string().regex(/^[a-f0-9]{64}$/i) }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { uploadId } = req.validated!.params as { uploadId: string };
    const { checksum } = req.validated!.body as { checksum: string };

    const session = await prisma.uploadSession.findFirst({
      where: { id: uploadId, orgId: subject.orgId },
      include: {
        attachment: { select: { id: true, fileName: true, storageKey: true, mimeType: true } },
      },
    });
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, 'That upload session was not found.');

    if (session.completedAt && session.attachment.storageKey) {
      res.json({ data: { storageKey: session.attachment.storageKey, alreadyComplete: true } });
      return;
    }

    const missing: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.receivedChunks.includes(i)) missing.push(i);
    }
    if (missing.length > 0) {
      throw new AppError(
        ErrorCode.UPLOAD_INCOMPLETE,
        `${missing.length} chunk${missing.length === 1 ? '' : 's'} still missing.`,
        { fields: { missingChunks: missing.slice(0, 50).join(',') } },
      );
    }

    await prisma.attachment.update({
      where: { id: session.attachmentId },
      data: { state: AttachmentState.FINALIZING },
    });

    const key = attachmentKey(subject.orgId, session.attachmentId, session.attachment.fileName);

    let result: { key: string; sizeBytes: number; checksum: string };
    try {
      result = await storage().finalise(uploadId, session.totalChunks, key);
    } catch (err) {
      await prisma.attachment.update({
        where: { id: session.attachmentId },
        data: {
          state: AttachmentState.FAILED,
          lastUploadError: err instanceof Error ? err.message : 'Assembly failed',
        },
      });
      throw new AppError(
        ErrorCode.STORAGE_UNAVAILABLE,
        'The upload could not be assembled. Please retry.',
        { cause: err },
      );
    }

    /*
     * Look at the bytes, now that they exist.
     *
     * The declaration was the client's claim about the file. This is the only
     * point where the assembled content itself is examined — a renamed
     * executable passes every earlier check, because every earlier check reads
     * only what the client said.
     *
     * Request attachments come from outside the organisation, so they are the
     * ones that matter; a device's own photograph is checked too because the
     * cost is one buffer read of what is already in memory.
     */
    try {
      const head = (await storage().read(result.key)).subarray(0, 16);
      validateContent(head, session.attachment.mimeType);
    } catch (err) {
      await storage()
        .delete(result.key)
        .catch(() => undefined);
      await prisma.attachment.update({
        where: { id: session.attachmentId },
        data: { state: AttachmentState.FAILED, lastUploadError: 'Rejected content' },
      });
      throw err;
    }

    if (result.checksum !== checksum.toLowerCase()) {
      // The assembled bytes are not what the client hashed. Discard and let it
      // start over — publishing this would put corrupt evidence on record.
      await storage()
        .delete(result.key)
        .catch(() => undefined);
      await prisma.attachment.update({
        where: { id: session.attachmentId },
        data: {
          state: AttachmentState.FAILED,
          lastUploadError: 'Checksum mismatch after assembly',
        },
      });
      logger.warn(
        { attachmentId: session.attachmentId, expected: checksum, actual: result.checksum },
        'upload checksum mismatch',
      );
      throw new AppError(
        ErrorCode.CHECKSUM_MISMATCH,
        'The uploaded file did not match its checksum. Please re-upload.',
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.attachment.update({
        where: { id: session.attachmentId },
        data: {
          state: AttachmentState.UPLOADED,
          storageKey: result.key,
          sizeBytes: BigInt(result.sizeBytes),
          uploadedAt: new Date(),
          lastUploadError: null,
        },
      });
      await tx.uploadSession.update({
        where: { id: uploadId },
        data: { completedAt: new Date() },
      });
    });

    // Chunks are no longer needed. Failure to clean up is not worth failing the
    // request over — the expiry sweeper will catch it.
    await storage()
      .discard(uploadId)
      .catch(() => undefined);

    res.json({
      data: { storageKey: result.key, sizeBytes: result.sizeBytes, checksum: result.checksum },
    });
  }),
);

/** Abandon an upload and free its chunks. */
router.delete(
  '/:uploadId',
  requireAuth,
  requireDevice,
  validate({ params: z.object({ uploadId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { uploadId } = req.validated!.params as { uploadId: string };

    const session = await prisma.uploadSession.findFirst({
      where: { id: uploadId, orgId: subject.orgId },
    });
    if (!session) throw new AppError(ErrorCode.NOT_FOUND, 'That upload session was not found.');

    await storage()
      .discard(uploadId)
      .catch(() => undefined);
    await prisma.uploadSession.delete({ where: { id: uploadId } });
    await prisma.attachment.update({
      where: { id: session.attachmentId },
      data: { state: AttachmentState.QUEUED },
    });

    res.status(204).end();
  }),
);

/** Stream a stored attachment back. */
router.get(
  '/attachments/:attachmentId/content',
  requireAuth,
  requirePermission(Permission.INSPECTION_READ),
  validate({ params: z.object({ attachmentId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { attachmentId } = req.validated!.params as { attachmentId: string };

    const attachment = await prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        orgId: subject.orgId,
        deletedAt: null,
        ...attachmentScope(subject),
      },
      select: { storageKey: true, mimeType: true, fileName: true, sizeBytes: true },
    });
    if (!attachment?.storageKey) {
      throw new AppError(ErrorCode.NOT_FOUND, 'That file has not been uploaded yet.');
    }

    const bytes = await storage().read(attachment.storageKey);

    /*
     * Only a handful of types are rendered inline; everything else is sent as
     * an opaque download. A stored `.txt` that is really HTML is inert that
     * way — served as its declared type on the API's own origin it would not
     * be.
     */
    const { contentType, inline } = dispositionFor(attachment.mimeType);

    // Reading somebody's evidence is worth recording, and cheap next to the
    // storage read that just happened.
    void prisma.auditLog
      .create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'FILE_DOWNLOADED',
          entity: 'Attachment',
          entityId: attachmentId,
          metadata: { fileName: attachment.fileName },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      })
      .catch(() => undefined);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(attachment.fileName)}"`,
    );
    // Attachments are immutable once uploaded, so they cache indefinitely.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  }),
);

/** Sweep expired sessions. Called by the maintenance timer. */
export async function pruneExpiredUploads(): Promise<number> {
  const expired = await prisma.uploadSession.findMany({
    where: { expiresAt: { lt: new Date() }, completedAt: null },
    select: { id: true, attachmentId: true },
  });

  for (const session of expired) {
    await storage()
      .discard(session.id)
      .catch(() => undefined);
    await prisma.attachment
      .update({ where: { id: session.attachmentId }, data: { state: AttachmentState.QUEUED } })
      .catch(() => undefined);
  }

  const { count } = await prisma.uploadSession.deleteMany({
    where: { id: { in: expired.map((s) => s.id) } },
  });
  return count;
}

export { router as uploadsRouter };
