/**
 * Audit and activity logs, plus organisation settings.
 *
 * Audit logs are append-only by policy: there is deliberately no endpoint to
 * edit or delete one. A log an administrator can rewrite is not an audit trail.
 */

import { AppError, ErrorCode, Permission } from '@orbit/shared';
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
} from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';

const router: Router = Router();

router.get(
  '/audit-logs',
  requireAuth,
  requirePermission(Permission.AUDIT_READ),
  validate({
    query: paginationSchema.extend({
      action: csvArray,
      entity: z.string().max(40).optional(),
      entityId: schemas.ulid.optional(),
      userId: schemas.ulid.optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as {
      page: number;
      pageSize: number;
      action?: string[];
      entity?: string;
      entityId?: string;
      userId?: string;
      from?: string;
      to?: string;
    };

    const where: Prisma.AuditLogWhereInput = {
      orgId: subject.orgId,
      ...(q.action?.length ? { action: { in: q.action } } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(dateRange(q.from, q.to) ? { createdAt: dateRange(q.from, q.to) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginationArgs(q),
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ data: paginate(items, total, q) });
  }),
);

/**
 * Sync activity across the fleet.
 *
 * The first place support looks when someone reports "it isn't syncing" —
 * it answers whether the device has been in contact at all.
 */
router.get(
  '/sync-sessions',
  requireAuth,
  requirePermission(Permission.AUDIT_READ),
  validate({
    query: paginationSchema.extend({
      deviceId: schemas.ulid.optional(),
      userId: schemas.ulid.optional(),
      outcome: z.string().max(20).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as {
      page: number;
      pageSize: number;
      deviceId?: string;
      userId?: string;
      outcome?: string;
      from?: string;
      to?: string;
    };

    const where: Prisma.SyncSessionWhereInput = {
      orgId: subject.orgId,
      ...(q.deviceId ? { deviceId: q.deviceId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(dateRange(q.from, q.to) ? { startedAt: dateRange(q.from, q.to) } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.syncSession.findMany({
        where,
        include: {
          device: { select: { id: true, name: true, platform: true, appVersion: true } },
          user: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { startedAt: 'desc' },
        ...paginationArgs(q),
      }),
      prisma.syncSession.count({ where }),
    ]);

    res.json({ data: paginate(items, total, q) });
  }),
);

/** Fleet-wide sync health: which devices are behind, and by how much. */
router.get(
  '/sync-health',
  requireAuth,
  requirePermission(Permission.AUDIT_READ),
  asyncHandler(async (req, res) => {
    const subject = auth(req);

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: subject.orgId },
      select: { syncSequence: true },
    });

    const devices = await prisma.device.findMany({
      where: { orgId: subject.orgId, deletedAt: null, revokedAt: null },
      select: {
        id: true,
        name: true,
        platform: true,
        appVersion: true,
        lastSyncAt: true,
        lastSeenAt: true,
        lastSyncCursor: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { lastSyncAt: 'desc' },
      take: 500,
    });

    const [unresolvedConflicts, pendingUploads] = await Promise.all([
      prisma.syncConflictRecord.count({ where: { orgId: subject.orgId, resolvedAt: null } }),
      prisma.attachment.count({
        where: {
          orgId: subject.orgId,
          deletedAt: null,
          state: { in: ['QUEUED', 'UPLOADING', 'FAILED'] },
        },
      }),
    ]);

    const head = Number(org.syncSequence);
    const staleThreshold = Date.now() - 24 * 3_600_000;

    res.json({
      data: {
        serverCursor: head,
        unresolvedConflicts,
        pendingUploads,
        devices: devices.map((device) => {
          const cursor = Number(device.lastSyncCursor);
          return {
            id: device.id,
            name: device.name,
            platform: device.platform,
            appVersion: device.appVersion,
            userName: `${device.user.firstName} ${device.user.lastName}`,
            lastSyncAt: device.lastSyncAt,
            lastSeenAt: device.lastSeenAt,
            cursor,
            // How far behind the server this device is, in changes.
            behind: Math.max(0, head - cursor),
            // Not an error on its own — a device can legitimately be off for a
            // week — but it is what an operator wants sorted to the top.
            stale: !device.lastSyncAt || device.lastSyncAt.getTime() < staleThreshold,
          };
        }),
      },
    });
  }),
);

/** Organisation profile and settings. */
router.get(
  '/organization',
  requireAuth,
  requirePermission(Permission.ORG_READ),
  asyncHandler(async (req, res) => {
    const subject = auth(req);

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: subject.orgId },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        timezone: true,
        locale: true,
        currency: true,
        settings: true,
        numberPrefix: true,
        isActive: true,
        createdAt: true,
        _count: {
          select: { users: true, projects: true, sites: true, inspections: true, devices: true },
        },
      },
    });

    res.json({ data: org });
  }),
);

router.patch(
  '/organization',
  requireAuth,
  requirePermission(Permission.ORG_SETTINGS_UPDATE),
  validate({
    body: z.object({
      name: z.string().min(1).max(200).trim().optional(),
      logoUrl: z.string().url().max(500).nullable().optional(),
      timezone: z.string().max(64).optional(),
      locale: z.string().max(16).optional(),
      currency: z.string().length(3).optional(),
      numberPrefix: z
        .string()
        .min(1)
        .max(8)
        .regex(/^[A-Z0-9-]+$/)
        .optional(),
      settings: z
        .object({
          requireGpsOnSubmit: z.boolean().optional(),
          gpsAccuracyThresholdMeters: z.number().int().positive().max(10_000).optional(),
          rejectMockedLocations: z.boolean().optional(),
          sessionIdleTimeoutMinutes: z.number().int().positive().max(1440).optional(),
          deviceBindingEnabled: z.boolean().optional(),
          maxDevicesPerUser: z.number().int().positive().max(50).optional(),
          localMediaRetentionDays: z.number().int().positive().max(3650).optional(),
          wifiOnlyMediaSync: z.boolean().optional(),
          photoCompressionQuality: z.number().min(0.1).max(1).optional(),
          photoWatermarkEnabled: z.boolean().optional(),
          brandColor: z
            .string()
            .regex(/^#[0-9A-Fa-f]{6}$/)
            .nullable()
            .optional(),
          reportFooterText: z.string().max(500).nullable().optional(),
          passwordPolicy: z
            .object({
              minLength: z.number().int().min(8).max(128).optional(),
              requireUppercase: z.boolean().optional(),
              requireLowercase: z.boolean().optional(),
              requireNumber: z.boolean().optional(),
              requireSymbol: z.boolean().optional(),
              historyDepth: z.number().int().min(0).max(24).optional(),
              maxAgeDays: z.number().int().min(0).max(3650).optional(),
            })
            .optional(),
        })
        .optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as Record<string, unknown>;

    const current = await prisma.organization.findUniqueOrThrow({
      where: { id: subject.orgId },
      select: { settings: true },
    });

    // Settings are merged, not replaced. A PATCH that sent only
    // `wifiOnlyMediaSync` must not silently wipe the password policy.
    const mergedSettings = body.settings
      ? {
          ...((current.settings ?? {}) as Record<string, unknown>),
          ...(body.settings as Record<string, unknown>),
          ...(typeof (body.settings as Record<string, unknown>).passwordPolicy === 'object'
            ? {
                passwordPolicy: {
                  ...(((current.settings ?? {}) as Record<string, Record<string, unknown>>)
                    .passwordPolicy ?? {}),
                  ...((body.settings as Record<string, Record<string, unknown>>).passwordPolicy ??
                    {}),
                },
              }
            : {}),
        }
      : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.update({
        where: { id: subject.orgId },
        data: {
          ...(body.name !== undefined ? { name: body.name as string } : {}),
          ...(body.logoUrl !== undefined ? { logoUrl: body.logoUrl as string | null } : {}),
          ...(body.timezone !== undefined ? { timezone: body.timezone as string } : {}),
          ...(body.locale !== undefined ? { locale: body.locale as string } : {}),
          ...(body.currency !== undefined ? { currency: body.currency as string } : {}),
          ...(body.numberPrefix !== undefined ? { numberPrefix: body.numberPrefix as string } : {}),
          ...(mergedSettings ? { settings: mergedSettings as Prisma.InputJsonValue } : {}),
        },
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'SETTINGS_CHANGED',
          entity: 'Organization',
          entityId: subject.orgId,
          changes: { after: body } as never,
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return org;
    });

    res.json({ data: updated });
  }),
);

/** Unresolved conflicts across the fleet, for the sync monitoring screen. */
router.get(
  '/conflicts',
  requireAuth,
  requirePermission(Permission.CONFLICT_RESOLVE),
  validate({
    query: paginationSchema.extend({ resolved: z.coerce.boolean().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as { page: number; pageSize: number; resolved?: boolean };

    const where: Prisma.SyncConflictRecordWhereInput = {
      orgId: subject.orgId,
      ...(q.resolved === undefined
        ? {}
        : q.resolved
          ? { resolvedAt: { not: null } }
          : { resolvedAt: null }),
    };

    const [items, total] = await Promise.all([
      prisma.syncConflictRecord.findMany({
        where,
        include: { user: { select: { id: true, firstName: true, lastName: true } } },
        orderBy: { detectedAt: 'desc' },
        ...paginationArgs(q),
      }),
      prisma.syncConflictRecord.count({ where }),
    ]);

    res.json({ data: paginate(items, total, q) });
  }),
);

export { router as adminRouter, AppError, ErrorCode };
