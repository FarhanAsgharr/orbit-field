/**
 * Reference data: clients, projects, sites, assets.
 *
 * These are replicated to devices, so every mutation writes a change-log entry.
 * Forgetting that would mean an inspector never receives a newly created site
 * and cannot file work against it.
 *
 * The four resources share a shape, so they share one generic builder rather
 * than four near-identical files that drift apart over time.
 */

import { Router, type Router as ExpressRouter } from 'express';
import { Prisma } from '@prisma/client';
import { z, type ZodTypeAny } from 'zod';
import { SyncEntity, SyncOperation } from '@orbit/types';
import { AppError, ErrorCode, type Permission } from '@orbit/shared';
import { ulid } from '@orbit/utils';
import { prisma } from '../../db/prisma.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import { paginate, paginationArgs, paginationSchema, searchFilter, sortArgs } from '../../lib/pagination.js';
import { recordChange } from '../sync/change-log.js';
import { Permission as P } from '@orbit/shared';

/** Prisma delegates share this surface; typing it avoids four casts per resource. */
interface Delegate {
  findMany: (args: unknown) => Promise<unknown[]>;
  findFirst: (args: unknown) => Promise<unknown>;
  count: (args: unknown) => Promise<number>;
  create: (args: unknown) => Promise<{ id: string; version: number } & Record<string, unknown>>;
  update: (args: unknown) => Promise<{ id: string; version: number } & Record<string, unknown>>;
}

interface ResourceConfig {
  name: string;
  entity: SyncEntity;
  delegate: () => Delegate;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  searchFields: string[];
  sortable: readonly string[];
  include?: unknown;
  permissions: { read: Permission; write: Permission; delete: Permission };
  /** Extra referential checks before a write is accepted. */
  verifyReferences?: (orgId: string, body: Record<string, unknown>) => Promise<string | null>;
}

function buildResourceRouter(config: ResourceConfig): ExpressRouter {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    requirePermission(config.permissions.read),
    validate({
      query: paginationSchema.extend({
        search: z.string().max(200).optional(),
        isActive: z.coerce.boolean().optional(),
        sortBy: z.string().optional(),
        sortDir: z.enum(['asc', 'desc']).optional(),
      }),
    }),
    asyncHandler(async (req, res) => {
      const subject = auth(req);
      const q = req.validated!.query as {
        page: number; pageSize: number; search?: string; isActive?: boolean;
        sortBy?: string; sortDir?: 'asc' | 'desc';
      };

      const where: Record<string, unknown> = {
        orgId: subject.orgId,
        deletedAt: null,
        ...(q.isActive !== undefined ? { isActive: q.isActive } : {}),
        ...(q.search
          ? { OR: config.searchFields.map((field) => ({ [field]: searchFilter(q.search) })) }
          : {}),
      };

      const [items, total] = await Promise.all([
        config.delegate().findMany({
          where,
          ...(config.include ? { include: config.include } : {}),
          orderBy: sortArgs(q.sortBy, q.sortDir, config.sortable, config.sortable[0]!),
          ...paginationArgs(q),
        }),
        config.delegate().count({ where }),
      ]);

      res.json({ data: paginate(items, total, q) });
    }),
  );

  router.get(
    '/:id',
    requireAuth,
    requirePermission(config.permissions.read),
    validate({ params: z.object({ id: schemas.ulid }) }),
    asyncHandler(async (req, res) => {
      const subject = auth(req);
      const { id } = req.validated!.params as { id: string };

      const record = await config.delegate().findFirst({
        where: { id, orgId: subject.orgId, deletedAt: null },
        ...(config.include ? { include: config.include } : {}),
      });
      if (!record) throw new AppError(ErrorCode.NOT_FOUND, `That ${config.name} was not found.`);

      res.json({ data: record });
    }),
  );

  router.post(
    '/',
    requireAuth,
    requirePermission(config.permissions.write),
    validate({ body: config.createSchema }),
    asyncHandler(async (req, res) => {
      const subject = auth(req);
      const body = req.validated!.body as Record<string, unknown>;

      if (config.verifyReferences) {
        const failure = await config.verifyReferences(subject.orgId, body);
        if (failure) throw new AppError(ErrorCode.VALIDATION_FAILED, failure);
      }

      const id = ulid();

      const created = await prisma.$transaction(async (tx) => {
        const delegate = (tx as unknown as Record<string, Delegate>)[config.name]!;
        const row = await delegate.create({
          data: { ...body, id, orgId: subject.orgId },
        });

        // Devices must learn about this, or an inspector cannot select it.
        await recordChange(tx, {
          orgId: subject.orgId,
          entity: config.entity,
          operation: SyncOperation.CREATE,
          entityId: id,
          version: row.version,
          row,
          projectId: (row.projectId as string | null) ?? null,
          actorUserId: subject.userId,
          actorDeviceId: subject.deviceId,
        });

        await tx.auditLog.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            userId: subject.userId,
            action: 'RECORD_CREATED',
            entity: config.entity,
            entityId: id,
            ipAddress: clientIp(req),
            requestId: req.requestId,
          },
        });

        return row;
      });

      res.status(201).json({ data: created });
    }),
  );

  router.patch(
    '/:id',
    requireAuth,
    requirePermission(config.permissions.write),
    validate({ params: z.object({ id: schemas.ulid }), body: config.updateSchema }),
    asyncHandler(async (req, res) => {
      const subject = auth(req);
      const { id } = req.validated!.params as { id: string };
      const body = req.validated!.body as Record<string, unknown>;

      const existing = await config.delegate().findFirst({
        where: { id, orgId: subject.orgId, deletedAt: null },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, `That ${config.name} was not found.`);

      if (config.verifyReferences) {
        const failure = await config.verifyReferences(subject.orgId, body);
        if (failure) throw new AppError(ErrorCode.VALIDATION_FAILED, failure);
      }

      const updated = await prisma.$transaction(async (tx) => {
        const delegate = (tx as unknown as Record<string, Delegate>)[config.name]!;
        const row = await delegate.update({
          where: { id },
          data: { ...body, version: { increment: 1 } },
        });

        await recordChange(tx, {
          orgId: subject.orgId,
          entity: config.entity,
          operation: SyncOperation.UPDATE,
          entityId: id,
          version: row.version,
          row,
          projectId: (row.projectId as string | null) ?? null,
          actorUserId: subject.userId,
          actorDeviceId: subject.deviceId,
        });

        return row;
      });

      res.json({ data: updated });
    }),
  );

  router.delete(
    '/:id',
    requireAuth,
    requirePermission(config.permissions.delete),
    validate({ params: z.object({ id: schemas.ulid }) }),
    asyncHandler(async (req, res) => {
      const subject = auth(req);
      const { id } = req.validated!.params as { id: string };

      const existing = await config.delegate().findFirst({
        where: { id, orgId: subject.orgId, deletedAt: null },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND, `That ${config.name} was not found.`);

      await prisma.$transaction(async (tx) => {
        const delegate = (tx as unknown as Record<string, Delegate>)[config.name]!;
        // Soft delete: the tombstone is how offline devices learn it is gone.
        const row = await delegate.update({
          where: { id },
          data: { deletedAt: new Date(), isActive: false, version: { increment: 1 } },
        });

        await recordChange(tx, {
          orgId: subject.orgId,
          entity: config.entity,
          operation: SyncOperation.DELETE,
          entityId: id,
          version: row.version,
          row: null,
          actorUserId: subject.userId,
          actorDeviceId: subject.deviceId,
        });

        await tx.auditLog.create({
          data: {
            id: ulid(),
            orgId: subject.orgId,
            userId: subject.userId,
            action: 'RECORD_DELETED',
            entity: config.entity,
            entityId: id,
            ipAddress: clientIp(req),
            requestId: req.requestId,
          },
        });
      });

      res.status(204).end();
    }),
  );

  return router;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const clientFields = {
  name: z.string().min(1).max(200).trim(),
  code: z.string().max(40).nullable().optional(),
  contactName: z.string().max(120).nullable().optional(),
  contactEmail: z.string().email().max(320).nullable().optional(),
  contactPhone: z.string().max(32).nullable().optional(),
  address: z.string().max(2000).nullable().optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
};

export const clientsRouter = buildResourceRouter({
  name: 'client',
  entity: SyncEntity.CLIENT,
  delegate: () => prisma.client as unknown as Delegate,
  createSchema: z.object(clientFields),
  updateSchema: z.object(clientFields).partial(),
  searchFields: ['name', 'code', 'contactName'],
  sortable: ['name', 'createdAt', 'updatedAt'],
  include: { _count: { select: { projects: true, sites: true, inspections: true } } },
  permissions: { read: P.CLIENT_READ, write: P.CLIENT_WRITE, delete: P.CLIENT_DELETE },
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectFields = {
  name: z.string().min(1).max(200).trim(),
  code: z.string().min(1).max(40).trim(),
  clientId: schemas.ulid.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  managerId: schemas.ulid.nullable().optional(),
  startDate: z.string().datetime({ offset: true }).nullable().optional(),
  endDate: z.string().datetime({ offset: true }).nullable().optional(),
  isActive: z.boolean().optional(),
};

export const projectsRouter = buildResourceRouter({
  name: 'project',
  entity: SyncEntity.PROJECT,
  delegate: () => prisma.project as unknown as Delegate,
  createSchema: z.object(projectFields),
  updateSchema: z.object(projectFields).partial(),
  searchFields: ['name', 'code', 'description'],
  sortable: ['name', 'code', 'createdAt', 'updatedAt'],
  include: {
    client: { select: { id: true, name: true } },
    manager: { select: { id: true, firstName: true, lastName: true } },
    _count: { select: { sites: true, inspections: true, members: true } },
  },
  permissions: { read: P.PROJECT_READ, write: P.PROJECT_WRITE, delete: P.PROJECT_DELETE },
  // Cross-tenant reference check: a caller must not be able to attach a project
  // to another organisation's client by guessing an id.
  verifyReferences: async (orgId, body) => {
    if (typeof body.clientId === 'string') {
      const client = await prisma.client.findFirst({
        where: { id: body.clientId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!client) return 'The referenced client does not exist.';
    }
    if (typeof body.managerId === 'string') {
      const manager = await prisma.user.findFirst({
        where: { id: body.managerId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!manager) return 'The referenced manager does not exist.';
    }
    if (typeof body.startDate === 'string' && typeof body.endDate === 'string') {
      if (Date.parse(body.startDate) > Date.parse(body.endDate)) {
        return 'The project start date cannot be after its end date.';
      }
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

const siteFields = {
  name: z.string().min(1).max(200).trim(),
  code: z.string().max(40).nullable().optional(),
  projectId: schemas.ulid.nullable().optional(),
  clientId: schemas.ulid.nullable().optional(),
  address: z.string().max(2000).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofenceRadiusMeters: z.number().int().positive().max(100_000).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  contactName: z.string().max(120).nullable().optional(),
  contactPhone: z.string().max(32).nullable().optional(),
  isActive: z.boolean().optional(),
};

export const sitesRouter = buildResourceRouter({
  name: 'site',
  entity: SyncEntity.SITE,
  delegate: () => prisma.site as unknown as Delegate,
  createSchema: z.object(siteFields),
  updateSchema: z.object(siteFields).partial(),
  searchFields: ['name', 'code', 'address'],
  sortable: ['name', 'createdAt', 'updatedAt'],
  include: {
    client: { select: { id: true, name: true } },
    project: { select: { id: true, name: true } },
    _count: { select: { inspections: true, assets: true } },
  },
  permissions: { read: P.SITE_READ, write: P.SITE_WRITE, delete: P.SITE_DELETE },
  verifyReferences: async (orgId, body) => {
    // A geofence radius without coordinates silently never applies, which reads
    // as "geofencing is broken" rather than "the site has no location".
    // An omitted coordinate arrives as `undefined`, an explicitly cleared one as
    // `null`. Both mean "no location", so both must block a geofence — checking
    // only for null let a radius be saved against a site that has no position,
    // where it silently never applies.
    if (body.geofenceRadiusMeters !== undefined && body.geofenceRadiusMeters !== null) {
      const hasLatitude = typeof body.latitude === 'number';
      const hasLongitude = typeof body.longitude === 'number';
      if (!hasLatitude || !hasLongitude) {
        return 'A geofence radius requires the site to have coordinates.';
      }
    }
    for (const [field, table] of [['clientId', 'client'], ['projectId', 'project']] as const) {
      const value = body[field];
      if (typeof value !== 'string') continue;
      const delegate = (prisma as unknown as Record<string, { findFirst: (a: unknown) => Promise<unknown> }>)[table]!;
      const exists = await delegate.findFirst({ where: { id: value, orgId, deletedAt: null }, select: { id: true } });
      if (!exists) return `The referenced ${table} does not exist.`;
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

const assetFields = {
  name: z.string().min(1).max(200).trim(),
  tag: z.string().min(1).max(120).trim(),
  siteId: schemas.ulid.nullable().optional(),
  parentAssetId: schemas.ulid.nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  manufacturer: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  serialNumber: z.string().max(120).nullable().optional(),
  installedAt: z.string().datetime({ offset: true }).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  isActive: z.boolean().optional(),
};

export const assetsRouter = buildResourceRouter({
  name: 'asset',
  entity: SyncEntity.ASSET,
  delegate: () => prisma.asset as unknown as Delegate,
  createSchema: z.object(assetFields),
  updateSchema: z.object(assetFields).partial(),
  searchFields: ['name', 'tag', 'serialNumber', 'model'],
  sortable: ['name', 'tag', 'createdAt', 'updatedAt'],
  include: { site: { select: { id: true, name: true } } },
  permissions: { read: P.ASSET_READ, write: P.ASSET_WRITE, delete: P.ASSET_WRITE },
  verifyReferences: async (orgId, body) => {
    if (typeof body.siteId === 'string') {
      const site = await prisma.site.findFirst({
        where: { id: body.siteId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!site) return 'The referenced site does not exist.';
    }
    if (typeof body.parentAssetId === 'string') {
      const parent = await prisma.asset.findFirst({
        where: { id: body.parentAssetId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) return 'The referenced parent asset does not exist.';
    }
    return null;
  },
});

export { Prisma };
