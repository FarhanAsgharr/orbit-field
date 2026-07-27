/**
 * Device management.
 *
 * A device is a security boundary, not a convenience record: it holds a refresh
 * token, an offline replica of inspection data, and possibly unsynced work.
 * Revoking one therefore does two things that must happen together — kill its
 * tokens, and mark it revoked so `requireAuth` rejects it even while an
 * unexpired access token is still in flight.
 */

import { AppError, can, ErrorCode, Permission } from '@orbit/shared';
import { ulid } from '@orbit/utils';
import type { NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { revokeDeviceTokens } from '../../lib/tokens.js';
import { requireAuth } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import { notifyDeviceRevoked } from '../notifications/push.service.js';

const router: Router = Router();

/**
 * Device management is a staff surface. Customers do not get one.
 *
 * The endpoints below already narrow to the caller's own devices unless they
 * hold `device:read`, so a client reaching them saw only their own browser
 * sessions and nothing else — not a disclosure, but not something a customer
 * portal has any use for either. It is closed here rather than left to be
 * harmless, because "harmless today" is a property of the current scoping
 * rather than a decision anyone made, and the Client Portal deliberately has
 * no device screen to reach it from.
 *
 * Applied to the whole router rather than per-route so a device endpoint added
 * later is closed by default.
 */
router.use(requireAuth, (req, _res, next: NextFunction): void => {
  if (auth(req).clientId) {
    next(
      new AppError(
        ErrorCode.PERMISSION_DENIED,
        'Device management is not part of the client portal.',
      ),
    );
    return;
  }
  next();
});

/** Shape returned to clients. Never exposes the biometric public key. */
const deviceSelect = {
  id: true,
  userId: true,
  name: true,
  platform: true,
  osVersion: true,
  appVersion: true,
  model: true,
  installationId: true,
  lastSeenAt: true,
  lastSyncAt: true,
  lastSyncCursor: true,
  revokedAt: true,
  revokedReason: true,
  createdAt: true,
  biometricEnrolledAt: true,
} as const;

/**
 * List devices.
 *
 * Own devices by default. Seeing everyone's requires `device:read`, which
 * supervisors and above hold — an inspector must not be able to enumerate the
 * fleet.
 */
router.get(
  '/',
  requireAuth,
  validate({
    query: z.object({
      userId: schemas.ulid.optional(),
      includeRevoked: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const query = req.validated!.query as { userId?: string; includeRevoked: boolean };

    const canSeeOthers = can(subject, Permission.DEVICE_READ);
    const targetUserId = query.userId ?? subject.userId;

    if (targetUserId !== subject.userId && !canSeeOthers) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You can only view your own devices.');
    }

    const devices = await prisma.device.findMany({
      where: {
        orgId: subject.orgId,
        userId: targetUserId,
        deletedAt: null,
        ...(query.includeRevoked ? {} : { revokedAt: null }),
      },
      select: deviceSelect,
      orderBy: { lastSeenAt: 'desc' },
    });

    res.json({ data: devices });
  }),
);

/** Rename a device, so a user with three phones can tell them apart. */
router.patch(
  '/:deviceId',
  requireAuth,
  validate({
    params: z.object({ deviceId: schemas.ulid }),
    body: z.object({ name: z.string().min(1).max(120).trim() }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { deviceId } = req.validated!.params as { deviceId: string };
    const { name } = req.validated!.body as { name: string };

    const device = await prisma.device.findFirst({
      where: { id: deviceId, orgId: subject.orgId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!device) throw new AppError(ErrorCode.NOT_FOUND, 'That device was not found.');

    if (device.userId !== subject.userId && !can(subject, Permission.DEVICE_REVOKE)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You can only rename your own devices.');
    }

    const updated = await prisma.device.update({
      where: { id: deviceId },
      data: { name },
      select: deviceSelect,
    });

    res.json({ data: updated });
  }),
);

/**
 * Revoke a device.
 *
 * Deliberately a soft revoke rather than a delete. The row is what lets an
 * administrator see that a lost phone was revoked and when — deleting it
 * destroys exactly the audit trail a security incident needs.
 */
router.delete(
  '/:deviceId',
  requireAuth,
  validate({
    params: z.object({ deviceId: schemas.ulid }),
    body: z.object({ reason: z.string().max(200).optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { deviceId } = req.validated!.params as { deviceId: string };
    const reason = (req.validated!.body as { reason?: string } | undefined)?.reason;

    const device = await prisma.device.findFirst({
      where: { id: deviceId, orgId: subject.orgId, deletedAt: null },
      select: { id: true, userId: true, name: true, revokedAt: true },
    });
    if (!device) throw new AppError(ErrorCode.NOT_FOUND, 'That device was not found.');

    const isOwn = device.userId === subject.userId;
    if (!isOwn && !can(subject, Permission.DEVICE_REVOKE)) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to revoke this device.',
      );
    }
    if (device.revokedAt) {
      throw new AppError(ErrorCode.CONFLICT, 'That device is already revoked.');
    }

    await prisma.$transaction(async (tx) => {
      await tx.device.update({
        where: { id: deviceId },
        data: {
          revokedAt: new Date(),
          revokedReason: reason ?? (isOwn ? 'Revoked by user' : 'Revoked by administrator'),
          pushToken: null, // stop notifications reaching a device we no longer trust
        },
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          deviceId: subject.deviceId,
          action: 'DEVICE_REVOKED',
          entity: 'Device',
          entityId: deviceId,
          metadata: {
            deviceName: device.name,
            targetUserId: device.userId,
            reason: reason ?? null,
          },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });
    });

    // Outside the transaction: token revocation is idempotent, and a failure
    // here must not roll back the device revocation itself.
    await revokeDeviceTokens(deviceId, reason ?? 'device revoked');

    // Only worth telling them when somebody else did it — a user who revoked
    // their own device does not need a push about it.
    if (!isOwn) {
      void notifyDeviceRevoked({
        orgId: subject.orgId,
        userId: device.userId,
        deviceName: device.name,
      });
    }

    res.status(204).end();
  }),
);

/**
 * Register or update a push token.
 *
 * Tokens rotate whenever the OS decides to, so this is called on every launch.
 * The same token can be reassigned between devices when a user restores a
 * backup onto new hardware, so any prior holder is cleared first — otherwise
 * two device rows claim one token and notifications go to the wrong person.
 */
router.post(
  '/:deviceId/push-token',
  requireAuth,
  validate({
    params: z.object({ deviceId: schemas.ulid }),
    body: z.object({ pushToken: z.string().min(10).max(400) }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { deviceId } = req.validated!.params as { deviceId: string };
    const { pushToken } = req.validated!.body as { pushToken: string };

    const device = await prisma.device.findFirst({
      where: { id: deviceId, orgId: subject.orgId, userId: subject.userId, deletedAt: null },
      select: { id: true, revokedAt: true },
    });
    if (!device) throw new AppError(ErrorCode.NOT_FOUND, 'That device was not found.');
    if (device.revokedAt)
      throw new AppError(ErrorCode.DEVICE_REVOKED, 'This device has been revoked.');

    await prisma.$transaction(async (tx) => {
      await tx.device.updateMany({
        where: { pushToken, NOT: { id: deviceId } },
        data: { pushToken: null },
      });
      await tx.device.update({ where: { id: deviceId }, data: { pushToken } });
    });

    res.status(204).end();
  }),
);

/** Active sessions for a device, so a user can see where they are signed in. */
router.get(
  '/:deviceId/sessions',
  requireAuth,
  validate({ params: z.object({ deviceId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { deviceId } = req.validated!.params as { deviceId: string };

    const device = await prisma.device.findFirst({
      where: { id: deviceId, orgId: subject.orgId, deletedAt: null },
      select: { userId: true },
    });
    if (!device) throw new AppError(ErrorCode.NOT_FOUND, 'That device was not found.');
    if (device.userId !== subject.userId && !can(subject, Permission.DEVICE_READ)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You can only view your own sessions.');
    }

    const sessions = await prisma.refreshToken.findMany({
      where: { deviceId, revokedAt: null, expiresAt: { gt: new Date() } },
      // Never return the token hash — it is not secret-equivalent, but there is
      // no reason for a client to ever see it.
      select: {
        id: true,
        familyId: true,
        createdAt: true,
        expiresAt: true,
        usedAt: true,
        ipAddress: true,
        userAgent: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ data: sessions });
  }),
);

/** Sign a device out without revoking it — tokens die, enrolment survives. */
router.post(
  '/:deviceId/logout',
  requireAuth,
  validate({ params: z.object({ deviceId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { deviceId } = req.validated!.params as { deviceId: string };

    const device = await prisma.device.findFirst({
      where: { id: deviceId, orgId: subject.orgId, deletedAt: null },
      select: { userId: true },
    });
    if (!device) throw new AppError(ErrorCode.NOT_FOUND, 'That device was not found.');
    if (device.userId !== subject.userId && !can(subject, Permission.DEVICE_REVOKE)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You cannot sign out this device.');
    }

    await revokeDeviceTokens(deviceId, 'signed out remotely');
    res.status(204).end();
  }),
);

export { router as devicesRouter };
