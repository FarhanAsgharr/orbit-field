/**
 * Template authoring API.
 *
 * The central rule this enforces: **a published version is immutable.** Editing
 * a published template creates a new draft version; the old one is retired but
 * never altered. That is what guarantees an inspection started three weeks ago
 * in a basement still renders the exact questions it was started with, and that
 * a report produced from it remains reproducible years later.
 *
 * Consequently there is no `PATCH /templates/:id/versions/:versionId` for a
 * published version. Attempting it is a 409, not a silent no-op.
 */

import { AppError, ErrorCode, Permission } from '@orbit/shared';
import { FieldType, SyncEntity, SyncOperation } from '@orbit/types';
import { ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import {
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
import { recordChange } from '../sync/change-log.js';
import { validateDefinition } from './definition.schema.js';

const router: Router = Router();

const SORTABLE = ['name', 'createdAt', 'updatedAt', 'category'] as const;

const listQuery = paginationSchema.extend({
  search: z.string().max(200).optional(),
  category: z.string().max(120).optional(),
  discipline: z.string().max(120).optional(),
  includeArchived: z.coerce.boolean().default(false),
  sortBy: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

/** List templates with their active version summary. */
router.get(
  '/',
  requireAuth,
  requirePermission(Permission.TEMPLATE_READ),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as z.infer<typeof listQuery>;

    const where: Prisma.TemplateWhereInput = {
      orgId: subject.orgId,
      deletedAt: null,
      ...(q.includeArchived ? {} : { isArchived: false }),
      ...(q.category ? { category: q.category } : {}),
      ...(q.discipline ? { discipline: q.discipline } : {}),
      ...(q.search
        ? { OR: [{ name: searchFilter(q.search) }, { description: searchFilter(q.search) }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.template.findMany({
        where,
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          versions: {
            select: {
              id: true,
              version: true,
              publishedAt: true,
              retiredAt: true,
              changeNote: true,
            },
            orderBy: { version: 'desc' },
            take: 5,
          },
          _count: { select: { inspections: true, versions: true } },
        },
        orderBy: sortArgs(q.sortBy, q.sortDir, SORTABLE, 'updatedAt'),
        ...paginationArgs(q),
      }),
      prisma.template.count({ where }),
    ]);

    res.json({ data: paginate(items, total, q) });
  }),
);

/** Full template with the requested version's definition. */
router.get(
  '/:id',
  requireAuth,
  requirePermission(Permission.TEMPLATE_READ),
  validate({
    params: z.object({ id: schemas.ulid }),
    query: z.object({ versionId: schemas.ulid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { versionId } = req.validated!.query as { versionId?: string };

    const template = await prisma.template.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        versions: {
          select: {
            id: true,
            version: true,
            publishedAt: true,
            retiredAt: true,
            changeNote: true,
            createdAt: true,
          },
          orderBy: { version: 'desc' },
        },
      },
    });
    if (!template) throw new AppError(ErrorCode.NOT_FOUND, 'That template was not found.');

    // Default to the active version — what an inspector would actually get.
    const targetVersionId = versionId ?? template.activeVersionId ?? template.versions[0]?.id;
    const version = targetVersionId
      ? await prisma.templateVersion.findFirst({
          where: { id: targetVersionId, templateId: id, deletedAt: null },
        })
      : null;

    res.json({ data: { ...template, version } });
  }),
);

const definitionBody = z.object({
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  discipline: z.string().max(120).nullable().optional(),
  defaultPriority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
  definition: z.unknown(),
  scoring: z
    .object({
      enabled: z.boolean().default(true),
      passThreshold: z.number().min(0).max(100).default(80),
      observationThreshold: z.number().min(0).max(100).default(60),
      criticalFailureForcesFail: z.boolean().default(true),
      excludeNotApplicable: z.boolean().default(true),
    })
    .optional(),
  requiredSignatures: z.array(z.string().max(40)).max(10).default([]),
  changeNote: z.string().max(1000).optional(),
});

/** Create a template with its first draft version. */
router.post(
  '/',
  requireAuth,
  requirePermission(Permission.TEMPLATE_WRITE),
  validate({ body: definitionBody }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as z.infer<typeof definitionBody>;

    // The definition is validated structurally before it touches the database —
    // a malformed section tree would render as a blank checklist in the field,
    // which is far worse than a rejected save.
    const validation = validateDefinition(body.definition);
    if (!validation.ok) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'The checklist definition is not valid.', {
        fields: validation.errors,
      });
    }

    const templateId = ulid();
    const versionId = ulid();

    const created = await prisma.$transaction(async (tx) => {
      const template = await tx.template.create({
        data: {
          id: templateId,
          orgId: subject.orgId,
          name: body.name,
          description: body.description ?? null,
          category: body.category ?? null,
          discipline: body.discipline ?? null,
          defaultPriority: body.defaultPriority,
          createdById: subject.userId,
        },
      });

      await tx.templateVersion.create({
        data: {
          id: versionId,
          templateId,
          orgId: subject.orgId,
          version: 1,
          definition: validation.normalised as Prisma.InputJsonValue,
          scoring: (body.scoring ?? {}) as Prisma.InputJsonValue,
          requiredSignatures: body.requiredSignatures,
          changeNote: body.changeNote ?? 'Initial draft.',
          // Deliberately unpublished: a new template must be explicitly
          // released before inspectors can start work on it.
          publishedAt: null,
        },
      });

      return template;
    });

    res.status(201).json({ data: { ...created, draftVersionId: versionId } });
  }),
);

/** Update template metadata. Does not touch any version's questions. */
router.patch(
  '/:id',
  requireAuth,
  requirePermission(Permission.TEMPLATE_WRITE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      name: z.string().min(1).max(200).trim().optional(),
      description: z.string().max(2000).nullable().optional(),
      category: z.string().max(120).nullable().optional(),
      discipline: z.string().max(120).nullable().optional(),
      defaultPriority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).optional(),
      isArchived: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = req.validated!.body as Record<string, unknown>;

    const existing = await prisma.template.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'That template was not found.');

    const updated = await prisma.template.update({
      where: { id },
      data: body as Prisma.TemplateUncheckedUpdateInput,
    });

    res.json({ data: updated });
  }),
);

/**
 * Create a new draft version.
 *
 * The only way to change a published template's questions. Copies the source
 * version's definition as a starting point so an author edits rather than
 * retypes.
 */
router.post(
  '/:id/versions',
  requireAuth,
  requirePermission(Permission.TEMPLATE_WRITE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      fromVersionId: schemas.ulid.optional(),
      definition: z.unknown().optional(),
      scoring: z.record(z.unknown()).optional(),
      requiredSignatures: z.array(z.string().max(40)).max(10).optional(),
      changeNote: z.string().max(1000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = req.validated!.body as {
      fromVersionId?: string;
      definition?: unknown;
      scoring?: Record<string, unknown>;
      requiredSignatures?: string[];
      changeNote?: string;
    };

    const template = await prisma.template.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!template) throw new AppError(ErrorCode.NOT_FOUND, 'That template was not found.');

    const source = body.fromVersionId
      ? await prisma.templateVersion.findFirst({
          where: { id: body.fromVersionId, templateId: id, deletedAt: null },
        })
      : template.versions[0];

    if (!source && !body.definition) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'A definition or a source version is required.',
      );
    }

    const definition = body.definition ?? source?.definition;
    const validation = validateDefinition(definition);
    if (!validation.ok) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'The checklist definition is not valid.', {
        fields: validation.errors,
      });
    }

    const nextVersion = (template.versions[0]?.version ?? 0) + 1;
    const versionId = ulid();

    const created = await prisma.templateVersion.create({
      data: {
        id: versionId,
        templateId: id,
        orgId: subject.orgId,
        version: nextVersion,
        definition: validation.normalised as Prisma.InputJsonValue,
        scoring: (body.scoring ?? source?.scoring ?? {}) as Prisma.InputJsonValue,
        requiredSignatures: body.requiredSignatures ?? source?.requiredSignatures ?? [],
        changeNote: body.changeNote ?? `Draft from v${source?.version ?? 0}.`,
        publishedAt: null,
      },
    });

    res.status(201).json({ data: created });
  }),
);

/** Edit a draft version. Published versions are immutable and return 409. */
router.patch(
  '/:id/versions/:versionId',
  requireAuth,
  requirePermission(Permission.TEMPLATE_WRITE),
  validate({
    params: z.object({ id: schemas.ulid, versionId: schemas.ulid }),
    body: z.object({
      definition: z.unknown().optional(),
      scoring: z.record(z.unknown()).optional(),
      requiredSignatures: z.array(z.string().max(40)).max(10).optional(),
      changeNote: z.string().max(1000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id, versionId } = req.validated!.params as { id: string; versionId: string };
    const body = req.validated!.body as {
      definition?: unknown;
      scoring?: Record<string, unknown>;
      requiredSignatures?: string[];
      changeNote?: string;
    };

    const version = await prisma.templateVersion.findFirst({
      where: { id: versionId, templateId: id, orgId: subject.orgId, deletedAt: null },
    });
    if (!version) throw new AppError(ErrorCode.NOT_FOUND, 'That template version was not found.');

    if (version.publishedAt) {
      // The whole immutability guarantee lives on this check.
      throw new AppError(
        ErrorCode.CONFLICT,
        'Published versions cannot be edited. Create a new draft version instead.',
      );
    }

    const data: Prisma.TemplateVersionUncheckedUpdateInput = {};

    if (body.definition !== undefined) {
      const validation = validateDefinition(body.definition);
      if (!validation.ok) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The checklist definition is not valid.', {
          fields: validation.errors,
        });
      }
      data.definition = validation.normalised as Prisma.InputJsonValue;
    }
    if (body.scoring !== undefined) data.scoring = body.scoring as Prisma.InputJsonValue;
    if (body.requiredSignatures !== undefined) data.requiredSignatures = body.requiredSignatures;
    if (body.changeNote !== undefined) data.changeNote = body.changeNote;

    const updated = await prisma.templateVersion.update({ where: { id: versionId }, data });
    res.json({ data: updated });
  }),
);

/**
 * Publish a draft.
 *
 * Retires the previously active version and points the template at this one.
 * In-flight inspections keep their pinned version — they are unaffected by
 * design, which is the entire reason versions exist.
 */
router.post(
  '/:id/versions/:versionId/publish',
  requireAuth,
  requirePermission(Permission.TEMPLATE_PUBLISH),
  validate({ params: z.object({ id: schemas.ulid, versionId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id, versionId } = req.validated!.params as { id: string; versionId: string };

    const version = await prisma.templateVersion.findFirst({
      where: { id: versionId, templateId: id, orgId: subject.orgId, deletedAt: null },
    });
    if (!version) throw new AppError(ErrorCode.NOT_FOUND, 'That template version was not found.');
    if (version.publishedAt) {
      throw new AppError(ErrorCode.CONFLICT, 'That version is already published.');
    }

    const validation = validateDefinition(version.definition);
    if (!validation.ok) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This version cannot be published while its definition is invalid.',
        {
          fields: validation.errors,
        },
      );
    }
    // A checklist with no questions would render as a blank form to an
    // inspector standing on site. Refuse rather than ship it.
    if (validation.fieldCount === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'A template must contain at least one question before it can be published.',
      );
    }

    const published = await prisma.$transaction(async (tx) => {
      const template = await tx.template.findUniqueOrThrow({
        where: { id },
        select: { activeVersionId: true },
      });

      if (template.activeVersionId && template.activeVersionId !== versionId) {
        await tx.templateVersion.update({
          where: { id: template.activeVersionId },
          data: { retiredAt: new Date() },
        });
      }

      const row = await tx.templateVersion.update({
        where: { id: versionId },
        data: { publishedAt: new Date(), publishedById: subject.userId, retiredAt: null },
      });

      const parent = await tx.template.update({
        where: { id },
        data: { activeVersionId: versionId },
      });

      // Devices need this to appear in their delta, or inspectors will never
      // receive the new checklist.
      //
      // The display fields travel with the version deliberately. A device holds
      // `template_versions` and no `templates` table, so it has nothing to join
      // against — sending the bare version row leaves `name` null and the
      // device rejects the whole delta on a NOT NULL constraint, which stops
      // every later entity in that pull as well.
      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.TEMPLATE_VERSION,
        operation: SyncOperation.CREATE,
        entityId: versionId,
        version: row.version,
        row: {
          ...row,
          name: parent.name,
          description: parent.description,
          category: parent.category,
          discipline: parent.discipline,
        },
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'SETTINGS_CHANGED',
          entity: 'TemplateVersion',
          entityId: versionId,
          metadata: { templateId: id, version: row.version, action: 'published' },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      return row;
    });

    res.json({ data: published });
  }),
);

/** Clone a whole template, including its active definition, as a new draft. */
router.post(
  '/:id/clone',
  requireAuth,
  requirePermission(Permission.TEMPLATE_WRITE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ name: z.string().min(1).max(200).trim().optional() }).optional(),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const name = (req.validated!.body as { name?: string } | undefined)?.name;

    const source = await prisma.template.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!source) throw new AppError(ErrorCode.NOT_FOUND, 'That template was not found.');

    const sourceVersion = source.activeVersionId
      ? await prisma.templateVersion.findUnique({ where: { id: source.activeVersionId } })
      : source.versions[0];

    const templateId = ulid();
    const versionId = ulid();

    const clone = await prisma.$transaction(async (tx) => {
      const template = await tx.template.create({
        data: {
          id: templateId,
          orgId: subject.orgId,
          name: name ?? `${source.name} (copy)`,
          description: source.description,
          category: source.category,
          discipline: source.discipline,
          defaultPriority: source.defaultPriority,
          createdById: subject.userId,
        },
      });

      await tx.templateVersion.create({
        data: {
          id: versionId,
          templateId,
          orgId: subject.orgId,
          version: 1,
          definition: (sourceVersion?.definition ?? { sections: [] }) as Prisma.InputJsonValue,
          scoring: (sourceVersion?.scoring ?? {}) as Prisma.InputJsonValue,
          requiredSignatures: sourceVersion?.requiredSignatures ?? [],
          changeNote: `Cloned from "${source.name}".`,
          publishedAt: null,
        },
      });

      return template;
    });

    res.status(201).json({ data: { ...clone, draftVersionId: versionId } });
  }),
);

/**
 * Export a template as a portable document.
 *
 * Ids are stripped: importing into another organisation must mint fresh ones,
 * or the two installations end up sharing primary keys.
 */
router.get(
  '/:id/export',
  requireAuth,
  requirePermission(Permission.TEMPLATE_READ),
  validate({
    params: z.object({ id: schemas.ulid }),
    query: z.object({ versionId: schemas.ulid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { versionId } = req.validated!.query as { versionId?: string };

    const template = await prisma.template.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
    });
    if (!template) throw new AppError(ErrorCode.NOT_FOUND, 'That template was not found.');

    const version = await prisma.templateVersion.findFirst({
      where: {
        id: versionId ?? template.activeVersionId ?? undefined,
        templateId: id,
        deletedAt: null,
      },
    });
    if (!version)
      throw new AppError(ErrorCode.NOT_FOUND, 'That template has no version to export.');

    const document = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      template: {
        name: template.name,
        description: template.description,
        category: template.category,
        discipline: template.discipline,
        defaultPriority: template.defaultPriority,
      },
      version: {
        definition: version.definition,
        scoring: version.scoring,
        requiredSignatures: version.requiredSignatures,
        sourceVersion: version.version,
      },
    };

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${template.name.replace(/[^\w-]+/g, '-')}.orbit-template.json"`,
    );
    res.json(document);
  }),
);

/** Import a previously exported template. Always lands as an unpublished draft. */
router.post(
  '/import',
  requireAuth,
  requirePermission(Permission.TEMPLATE_WRITE),
  validate({
    body: z.object({
      formatVersion: z.number().int().positive(),
      template: z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
        category: z.string().max(120).nullable().optional(),
        discipline: z.string().max(120).nullable().optional(),
        defaultPriority: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
      }),
      version: z.object({
        definition: z.unknown(),
        scoring: z.record(z.unknown()).optional(),
        requiredSignatures: z.array(z.string().max(40)).max(10).default([]),
      }),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as {
      formatVersion: number;
      template: {
        name: string;
        description?: string | null;
        category?: string | null;
        discipline?: string | null;
        defaultPriority: string;
      };
      version: {
        definition: unknown;
        scoring?: Record<string, unknown>;
        requiredSignatures: string[];
      };
    };

    if (body.formatVersion !== 1) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Unsupported template format version ${body.formatVersion}. This server understands version 1.`,
      );
    }

    // Imported definitions come from outside this installation, so they get the
    // same structural validation as hand-authored ones — arguably more
    // important, since nobody here reviewed them.
    const validation = validateDefinition(body.version.definition, { remintIds: true });
    if (!validation.ok) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'The imported checklist definition is not valid.',
        {
          fields: validation.errors,
        },
      );
    }

    const templateId = ulid();
    const versionId = ulid();

    const created = await prisma.$transaction(async (tx) => {
      const template = await tx.template.create({
        data: {
          id: templateId,
          orgId: subject.orgId,
          name: body.template.name,
          description: body.template.description ?? null,
          category: body.template.category ?? null,
          discipline: body.template.discipline ?? null,
          defaultPriority: body.template.defaultPriority as never,
          createdById: subject.userId,
        },
      });

      await tx.templateVersion.create({
        data: {
          id: versionId,
          templateId,
          orgId: subject.orgId,
          version: 1,
          definition: validation.normalised as Prisma.InputJsonValue,
          scoring: (body.version.scoring ?? {}) as Prisma.InputJsonValue,
          requiredSignatures: body.version.requiredSignatures,
          changeNote: 'Imported.',
          publishedAt: null,
        },
      });

      return template;
    });

    res.status(201).json({
      data: { ...created, draftVersionId: versionId, fieldCount: validation.fieldCount },
    });
  }),
);

/**
 * Archive a template.
 *
 * Never a hard delete while inspections reference it — destroying the
 * definition would make every historical report unreproducible.
 */
router.delete(
  '/:id',
  requireAuth,
  requirePermission(Permission.TEMPLATE_DELETE),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const template = await prisma.template.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: { _count: { select: { inspections: true } } },
    });
    if (!template) throw new AppError(ErrorCode.NOT_FOUND, 'That template was not found.');

    if (template._count.inspections > 0) {
      await prisma.template.update({ where: { id }, data: { isArchived: true } });
      res.json({
        data: {
          archived: true,
          deleted: false,
          reason: `Archived rather than deleted: ${template._count.inspections} inspection(s) reference it and their reports must stay reproducible.`,
        },
      });
      return;
    }

    await prisma.template.update({
      where: { id },
      data: { deletedAt: new Date(), isArchived: true },
    });
    res.json({ data: { archived: true, deleted: true } });
  }),
);

export { FieldType, router as templatesRouter };
