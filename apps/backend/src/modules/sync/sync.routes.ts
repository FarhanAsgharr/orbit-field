/** Sync API surface. */

import { Router } from 'express';
import { z } from 'zod';
import { ConflictResolution, SyncEntity, SyncOperation } from '@orbit/types';
import { AppError, ErrorCode, Permission, mergeRecords } from '@orbit/shared';
import { prisma } from '../../db/prisma.js';
import { requireAuth, requireDevice, requirePermission } from '../../middleware/auth.js';
import { auth } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import { listConflicts, pull, push, type SyncActor } from './sync.service.js';

const router: Router = Router();

const operationSchema = z.object({
  id: z.string().length(26),
  entity: z.nativeEnum(SyncEntity),
  operation: z.nativeEnum(SyncOperation),
  entityId: z.string().length(26),
  // Free-form by necessity: the patch shape depends on the entity, and each
  // entity handler applies its own column whitelist before touching the
  // database. Validating it twice here would duplicate that logic and drift.
  patch: z.record(z.unknown()),
  baseVersion: z.number().int().nonnegative().nullable(),
  dependsOn: z.array(z.string().length(26)).max(50).default([]),
  clientTimestamp: z.string(),
  lamport: z.number().int().nonnegative(),
  deviceId: z.string().length(26),
  userId: z.string().length(26),
});

const pushBody = z.object({
    protocolVersion: z.number().int().positive(),
    deviceId: z.string().length(26),
    cursor: z.number().int().nonnegative(),
  operations: z.array(operationSchema).max(1000),
});

const pullQuery = z.object({
    protocolVersion: z.coerce.number().int().positive(),
    since: z.coerce.number().int().nonnegative(),
    limit: z.coerce.number().int().positive().max(2000).default(500),
    entities: z
      .string()
      .optional()
    .transform((v) => (v ? (v.split(',') as SyncEntity[]) : undefined)),
});

const resolveBody = z.object({
    operationId: z.string().length(26),
    strategy: z.nativeEnum(ConflictResolution),
    fieldChoices: z.record(z.enum(['LOCAL', 'SERVER'])).optional(),
  fieldValues: z.record(z.unknown()).optional(),
});

/** Assert that the device in the payload matches the authenticated session. */
function actorFor(req: Parameters<typeof auth>[0], claimedDeviceId?: string): SyncActor {
  const subject = auth(req);
  if (!subject.deviceId) {
    throw new AppError(ErrorCode.DEVICE_NOT_ENROLLED, 'Synchronisation requires an enrolled device.');
  }
  if (claimedDeviceId && claimedDeviceId !== subject.deviceId) {
    // A token is bound to one device; a payload naming a different one is
    // either a client bug or an attempt to push as another installation.
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'The device does not match this session.');
  }
  return { ...subject, deviceId: subject.deviceId };
}

router.post(
  '/push',
  requireAuth,
  requireDevice,
  requirePermission(Permission.SYNC_PUSH),
  validate({ body: pushBody }),
  asyncHandler(async (req, res) => {
    const body = (req.validated!.body as z.infer<typeof pushBody>);
    const actor = actorFor(req, body.deviceId);
    const result = await push(actor, body as never);
    res.json(result);
  }),
);

router.get(
  '/pull',
  requireAuth,
  requireDevice,
  requirePermission(Permission.SYNC_PULL),
  validate({ query: pullQuery }),
  asyncHandler(async (req, res) => {
    const query = req.validated!.query as z.infer<typeof pullQuery>;
    const actor = actorFor(req);
    const result = await pull(actor, { ...query, deviceId: actor.deviceId } as never);
    res.json(result);
  }),
);

/** Unresolved conflicts awaiting a decision. */
router.get(
  '/conflicts',
  requireAuth,
  requirePermission(Permission.CONFLICT_RESOLVE),
  asyncHandler(async (req, res) => {
    const actor = actorFor(req);
    res.json({ data: await listConflicts(actor) });
  }),
);

/**
 * Apply a resolution.
 *
 * The merged record is written under a fresh version, and the conflict row is
 * closed with an audit trail of who decided what — a resolution is itself a
 * consequential act and must be attributable.
 */
router.post(
  '/conflicts/resolve',
  requireAuth,
  requirePermission(Permission.CONFLICT_RESOLVE),
  validate({ body: resolveBody }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as z.infer<typeof resolveBody>;
    const actor = actorFor(req);

    const record = await prisma.syncConflictRecord.findFirst({
      where: { operationId: body.operationId, orgId: actor.orgId },
    });
    if (!record) throw new AppError(ErrorCode.NOT_FOUND, 'That conflict was not found.');
    if (record.resolvedAt) {
      throw new AppError(ErrorCode.CONFLICT, 'That conflict has already been resolved.');
    }

    const merged = mergeRecords({
      diffs: record.diffs as never,
      local: record.localRecord as never,
      server: record.serverRecord as never,
      strategy: body.strategy,
      fieldChoices: body.fieldChoices,
      fieldValues: body.fieldValues as never,
    });

    if (merged.unresolved.length > 0) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'Every conflicting field must be decided before the merge can be applied.',
        { fields: Object.fromEntries(merged.unresolved.map((p) => [p, 'A choice is required.'])) },
      );
    }

    await prisma.syncConflictRecord.update({
      where: { id: record.id },
      data: {
        resolvedAt: new Date(),
        resolvedById: actor.userId,
        resolutionStrategy: body.strategy,
        resolvedRecord: merged.merged as never,
      },
    });

    await prisma.auditLog.create({
      data: {
        id: req.requestId,
        orgId: actor.orgId,
        userId: actor.userId,
        deviceId: actor.deviceId,
        action: 'CONFLICT_RESOLVED',
        entity: record.entity,
        entityId: record.entityId,
        metadata: {
          strategy: body.strategy,
          tookLocal: merged.tookLocal,
          tookServer: merged.tookServer,
        },
        requestId: req.requestId,
      },
    });

    // The device replays the operation against the merged record, which now
    // carries the server's current version — so the replay applies cleanly.
    res.json({ data: { resolved: true, merged: merged.merged } });
  }),
);

/** Sync history for this device, for in-app diagnostics. */
router.get(
  '/sessions',
  requireAuth,
  requireDevice,
  asyncHandler(async (req, res) => {
    const actor = actorFor(req);
    const sessions = await prisma.syncSession.findMany({
      where: { deviceId: actor.deviceId },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    res.json({ data: sessions });
  }),
);

export { router as syncRouter };
