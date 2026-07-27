/**
 * Reports API.
 *
 * One endpoint shape across every report and every format: choose a dataset,
 * choose a format, get a file. That uniformity is what makes batch export and
 * scheduled reports possible without a special case per combination.
 *
 * Generation is synchronous and bounded — datasets cap at 20,000 rows and the
 * work is a single indexed query plus in-memory rendering. Anything larger
 * belongs in a job queue, and the row cap is what keeps that boundary honest
 * rather than letting a request quietly take four minutes.
 */

import { AppError, can, ErrorCode, Permission } from '@orbit/shared';
import { ulid } from '@orbit/utils';
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { paginate, paginationArgs, paginationSchema } from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import {
  DATASET_KEYS,
  DATASET_LOADERS,
  DATASET_PERMISSION,
  type DatasetContext,
  type DatasetKey,
  DATASETS,
  type PreparedDataset,
} from './datasets.js';
import { buildWorkbook, sheet } from './excel.service.js';
import { buildPdfReport, section } from './pdf.service.js';

const router: Router = Router();

const FORMATS = ['pdf', 'csv', 'xlsx'] as const;
type Format = (typeof FORMATS)[number];

const CONTENT_TYPE: Record<Format, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const exportQuery = z.object({
  format: z.enum(FORMATS).default('xlsx'),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  projectId: z.string().optional(),
  siteId: z.string().optional(),
  templateId: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().positive().max(20_000).optional(),
});

function resolveRange(q: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'The start of the range must be before its end.',
    );
  }
  return { from, to };
}

function filename(stem: string, range: { from: Date; to: Date }, format: Format): string {
  const safe = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${safe}-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}.${format}`;
}

/** Org branding and identity, shared by every renderer. */
async function reportContext(orgId: string, userId: string) {
  const [org, user] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { name: true, settings: true },
    }),
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { firstName: true, lastName: true },
    }),
  ]);

  const settings = (org.settings ?? {}) as { reportFooterText?: string | null };

  return {
    organisation: org.name,
    generatedBy: `${user.firstName} ${user.lastName}`,
    generatedAt: new Date(),
    footerText: settings.reportFooterText ?? null,
  };
}

/** Record what was exported. An export is a data-egress event worth an audit trail. */
async function recordExport(input: {
  orgId: string;
  userId: string;
  requestId: string;
  ip: string | null;
  datasets: string[];
  format: string;
  rows: number;
  bytes: number;
}): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        id: ulid(),
        orgId: input.orgId,
        userId: input.userId,
        action: 'REPORT_EXPORTED',
        entity: 'Report',
        metadata: {
          datasets: input.datasets,
          format: input.format,
          rows: input.rows,
          bytes: input.bytes,
        },
        ipAddress: input.ip,
        requestId: input.requestId,
      },
    })
    .catch((err) => logger.error({ err }, 'failed to record export'));
}

/** Datasets the caller is permitted to export. */
function permittedDatasets(
  subject: ReturnType<typeof auth>,
  requested: DatasetKey[],
): DatasetKey[] {
  return requested.filter((key) => can(subject, DATASET_PERMISSION[key]));
}

/** What can be exported, and what this caller may reach. */
router.get(
  '/datasets',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    res.json({
      data: DATASET_KEYS.map((key) => ({
        key,
        name: DATASETS[key].name,
        description: DATASETS[key].subtitle ?? null,
        formats: FORMATS,
        available: can(subject, DATASET_PERMISSION[key]),
        requiredPermission: DATASET_PERMISSION[key],
      })),
    });
  }),
);

/**
 * Export a single dataset in any format.
 *
 * `GET` rather than `POST` so the console can hand the URL straight to the
 * browser's download machinery instead of buffering a large file into a blob.
 */
router.get(
  '/export/:dataset',
  requireAuth,
  validate({
    params: z.object({ dataset: z.enum(DATASET_KEYS as [DatasetKey, ...DatasetKey[]]) }),
    query: exportQuery,
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { dataset } = req.validated!.params as { dataset: DatasetKey };
    const q = req.validated!.query as z.infer<typeof exportQuery>;

    if (!can(subject, DATASET_PERMISSION[dataset])) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        `You do not have permission to export ${DATASETS[dataset].name.toLowerCase()}.`,
      );
    }

    const range = resolveRange(q);
    const spec = DATASETS[dataset];

    const ctx: DatasetContext = {
      orgId: subject.orgId,
      from: range.from,
      to: range.to,
      // Without org-wide analytics a user exports only their own work.
      scopeToUserId:
        dataset === 'inspections' && !can(subject, Permission.INSPECTION_READ_ALL)
          ? subject.userId
          : undefined,
      projectIds: q.projectId ? [q.projectId] : undefined,
      siteIds: q.siteId ? [q.siteId] : undefined,
      templateIds: q.templateId ? [q.templateId] : undefined,
      search: q.search,
      limit: q.limit,
    };

    const prepared = await DATASET_LOADERS[dataset](ctx);
    const context = await reportContext(subject.orgId, subject.userId);
    const name = filename(spec.name, range, q.format);

    let body: Buffer | string;

    if (q.format === 'csv') {
      body = prepared.csv();
    } else if (q.format === 'xlsx') {
      body = await buildWorkbook({ ...context, title: spec.name, from: range.from, to: range.to }, [
        prepared.sheet,
      ]);
    } else {
      body = await buildPdfReport(
        { ...context, title: spec.name, subtitle: spec.subtitle, from: range.from, to: range.to },
        [prepared.section],
      );
    }

    const bytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, 'utf8');

    await recordExport({
      orgId: subject.orgId,
      userId: subject.userId,
      requestId: req.requestId,
      ip: clientIp(req),
      datasets: [dataset],
      format: q.format,
      rows: prepared.count,
      bytes,
    });

    res.setHeader('Content-Type', CONTENT_TYPE[q.format]);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(bytes));
    // An export is a point-in-time snapshot; caching it would serve stale data
    // to the next person who clicks the same link.
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }),
);

/**
 * Batch export.
 *
 * Several datasets into one workbook — the format compliance teams actually
 * want, because a month-end pack is one file with tabs, not six attachments.
 * Only meaningful for xlsx and pdf; CSV has no notion of multiple sheets.
 */
router.get(
  '/batch',
  requireAuth,
  validate({
    query: exportQuery.extend({
      datasets: z
        .string()
        .transform(
          (v) =>
            v
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean) as DatasetKey[],
        )
        .refine((keys) => keys.length > 0 && keys.every((k) => DATASET_KEYS.includes(k)), {
          message: `datasets must be a comma-separated subset of: ${DATASET_KEYS.join(', ')}`,
        }),
      format: z.enum(['pdf', 'xlsx']).default('xlsx'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as z.infer<typeof exportQuery> & {
      datasets: DatasetKey[];
      format: 'pdf' | 'xlsx';
    };

    const allowed = permittedDatasets(subject, q.datasets);
    if (allowed.length === 0) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to export any of the requested data.',
      );
    }

    const range = resolveRange(q);
    const context = await reportContext(subject.orgId, subject.userId);

    const loaded: PreparedDataset[] = await Promise.all(
      allowed.map((key) =>
        DATASET_LOADERS[key]({
          orgId: subject.orgId,
          from: range.from,
          to: range.to,
          scopeToUserId:
            key === 'inspections' && !can(subject, Permission.INSPECTION_READ_ALL)
              ? subject.userId
              : undefined,
          limit: q.limit,
        }),
      ),
    );

    const totalRows = loaded.reduce((sum, l) => sum + l.count, 0);
    const name = filename('orbit-field-export', range, q.format);

    const body =
      q.format === 'xlsx'
        ? await buildWorkbook(
            { ...context, title: 'Orbit Field export', from: range.from, to: range.to },
            loaded.map((d) => d.sheet),
          )
        : await buildPdfReport(
            { ...context, title: 'Orbit Field export', from: range.from, to: range.to },
            loaded.map((d) => d.section),
          );

    await recordExport({
      orgId: subject.orgId,
      userId: subject.userId,
      requestId: req.requestId,
      ip: clientIp(req),
      datasets: allowed,
      format: q.format,
      rows: totalRows,
      bytes: body.length,
    });

    res.setHeader('Content-Type', CONTENT_TYPE[q.format]);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'no-store');
    // Tells the console which datasets were dropped for lack of permission,
    // so it can say so rather than silently returning a thinner file.
    res.setHeader('X-Orbit-Datasets', allowed.join(','));
    res.send(body);
  }),
);

/**
 * Summary report.
 *
 * The month-end pack: headline figures, inspector throughput, and where
 * failures concentrate, in one PDF an operations manager forwards without
 * editing.
 */
router.get(
  '/summary',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ),
  validate({ query: exportQuery.extend({ format: z.enum(['pdf', 'xlsx']).default('pdf') }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as z.infer<typeof exportQuery> & { format: 'pdf' | 'xlsx' };
    const range = resolveRange(q);
    const context = await reportContext(subject.orgId, subject.userId);

    const scoped = !can(subject, Permission.ANALYTICS_READ_ALL);
    const where = {
      orgId: subject.orgId,
      deletedAt: null,
      createdAt: { gte: range.from, lte: range.to },
      ...(scoped ? { assignedToId: subject.userId } : {}),
    };

    const [byStatus, byOutcome, aggregate] = await Promise.all([
      prisma.inspection.groupBy({ by: ['status'], where, _count: true }),
      prisma.inspection.groupBy({ by: ['outcome'], where, _count: true }),
      prisma.inspection.aggregate({ where, _count: true, _avg: { score: true } }),
    ]);

    const statusCounts = Object.fromEntries(byStatus.map((r) => [r.status, r._count]));
    const outcomeCounts = Object.fromEntries(byOutcome.map((r) => [r.outcome, r._count]));
    const total = aggregate._count;
    const completed =
      (statusCounts.APPROVED ?? 0) +
      (statusCounts.SUBMITTED ?? 0) +
      (statusCounts.UNDER_REVIEW ?? 0);
    const failed = outcomeCounts.FAIL ?? 0;
    const scored = (outcomeCounts.PASS ?? 0) + (outcomeCounts.PASS_WITH_OBSERVATIONS ?? 0) + failed;

    const completionRate = total > 0 ? Math.round((completed / total) * 1000) / 10 : 0;
    const failureRate = scored > 0 ? Math.round((failed / scored) * 1000) / 10 : 0;

    const ctx: DatasetContext = { orgId: subject.orgId, from: range.from, to: range.to };
    const [inspectors, sites] = await Promise.all([
      DATASET_LOADERS.inspectors(ctx),
      DATASET_LOADERS.sites(ctx),
    ]);

    const tone = (value: 'ok' | 'warn' | 'danger'): 'ok' | 'warn' | 'danger' => value;

    const highlights = [
      { label: 'Inspections', value: total.toLocaleString('en-GB') },
      {
        label: 'Completion rate',
        value: `${completionRate}%`,
        tone: tone(completionRate >= 80 ? 'ok' : completionRate >= 50 ? 'warn' : 'danger'),
      },
      {
        label: 'Failure rate',
        value: `${failureRate}%`,
        tone: tone(failureRate > 20 ? 'danger' : failureRate > 10 ? 'warn' : 'ok'),
      },
      {
        label: 'Average score',
        value:
          aggregate._avg.score !== null ? `${Math.round(aggregate._avg.score * 10) / 10}%` : '—',
      },
    ];

    const name = filename('orbit-field-summary', range, q.format);

    const body =
      q.format === 'pdf'
        ? await buildPdfReport(
            {
              ...context,
              title: 'Inspection summary',
              subtitle: scoped ? 'Your inspections' : 'All inspections across the organisation',
              from: range.from,
              to: range.to,
            },
            [
              // Highlights ride on the sites section so the headline figures
              // appear on the first page rather than needing a section of
              // their own with no table under it.
              {
                ...sites.section,
                heading: 'Overview',
                description: 'Headline figures for the reporting period.',
                highlights,
              },
              ...(scoped || inspectors.count === 0 ? [] : [inspectors.section]),
            ],
          )
        : await buildWorkbook(
            { ...context, title: 'Inspection summary', from: range.from, to: range.to },
            [sites.sheet, inspectors.sheet],
          );

    await recordExport({
      orgId: subject.orgId,
      userId: subject.userId,
      requestId: req.requestId,
      ip: clientIp(req),
      datasets: ['summary'],
      format: q.format,
      rows: sites.count + inspectors.count,
      bytes: body.length,
    });

    res.setHeader('Content-Type', CONTENT_TYPE[q.format]);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }),
);

/** Single-inspection report, generated server-side for the console and email. */
router.get(
  '/inspection/:id',
  requireAuth,
  requirePermission(Permission.REPORT_GENERATE),
  validate({
    params: z.object({ id: schemas.ulid }),
    query: z.object({ format: z.enum(['pdf', 'xlsx']).default('pdf') }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { format } = req.validated!.query as { format: 'pdf' | 'xlsx' };

    const inspection = await prisma.inspection.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      include: {
        template: { select: { name: true } },
        templateVersion: { select: { version: true, definition: true } },
        site: { select: { name: true } },
        client: { select: { name: true } },
        assignedTo: { select: { firstName: true, lastName: true } },
        responses: { where: { deletedAt: null } },
        signatures: { where: { deletedAt: null } },
        _count: { select: { attachments: true } },
      },
    });

    if (!inspection) throw new AppError(ErrorCode.NOT_FOUND, 'That inspection was not found.');

    // Field labels live in the pinned template version, so answers can be
    // rendered against the questions the inspector actually saw.
    const definition = inspection.templateVersion.definition as {
      sections?: Array<{ title: string; fields?: Array<{ id: string; label: string }> }>;
    };
    const labels = new Map<string, string>();
    const collect = (
      fields: Array<{ id: string; label: string; followUps?: unknown }> = [],
    ): void => {
      for (const field of fields) {
        labels.set(field.id, field.label);
        collect((field.followUps ?? []) as Array<{ id: string; label: string }>);
      }
    };
    for (const section of definition.sections ?? []) collect(section.fields ?? []);

    interface AnswerRow {
      question: string;
      answer: string;
      comment: string;
      failed: boolean;
    }

    const answers: AnswerRow[] = inspection.responses.map((response) => ({
      question: labels.get(response.fieldId) ?? response.fieldId,
      answer:
        response.value === null || response.value === undefined
          ? 'Not answered'
          : typeof response.value === 'object'
            ? JSON.stringify(response.value)
            : String(response.value),
      comment: response.comment ?? '',
      failed: response.isFailure,
    }));

    const columns = [
      { header: 'Question', value: (r: AnswerRow) => r.question, width: 40 },
      {
        header: 'Answer',
        value: (r: AnswerRow) => r.answer,
        width: 24,
        signal: (r: AnswerRow) => (r.failed ? ('danger' as const) : null),
      },
      { header: 'Comment', value: (r: AnswerRow) => r.comment, width: 36 },
    ];

    const context = await reportContext(subject.orgId, subject.userId);
    const name = `${inspection.number}-report.${format}`;

    const body =
      format === 'pdf'
        ? await buildPdfReport(
            {
              ...context,
              title: `${inspection.number} — ${inspection.title}`,
              subtitle: [inspection.template?.name, inspection.site?.name, inspection.client?.name]
                .filter(Boolean)
                .join('   ·   '),
            },
            [
              section<AnswerRow>({
                heading: 'Checklist responses',
                columns,
                rows: answers,
                highlights: [
                  { label: 'Result', value: inspection.outcome.replace(/_/g, ' ') },
                  {
                    label: 'Score',
                    value: inspection.score !== null ? `${Math.round(inspection.score)}%` : '—',
                  },
                  {
                    label: 'Failed checks',
                    value: String(inspection.failedFields),
                    tone: inspection.failedFields > 0 ? 'danger' : 'ok',
                  },
                  { label: 'Attachments', value: String(inspection._count.attachments) },
                ],
              }),
            ],
          )
        : await buildWorkbook({ ...context, title: inspection.number }, [
            sheet<AnswerRow>({ name: 'Responses', columns, rows: answers }),
          ]);

    res.setHeader('Content-Type', CONTENT_TYPE[format]);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }),
);

/** Export history, from the audit trail. */
router.get(
  '/history',
  requireAuth,
  requirePermission(Permission.REPORT_READ),
  validate({ query: paginationSchema }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const page = req.validated!.query as z.infer<typeof paginationSchema>;

    const where = { orgId: subject.orgId, action: 'REPORT_EXPORTED' };

    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        ...paginationArgs(page),
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ data: paginate(items, total, page) });
  }),
);

export { router as reportsRouter };
