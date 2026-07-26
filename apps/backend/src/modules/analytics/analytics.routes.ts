/**
 * Analytics.
 *
 * Aggregation runs in Postgres, not in Node. Pulling 50,000 inspections across
 * the wire to count them in JavaScript is the classic way these endpoints become
 * the slowest thing in the product; `date_trunc` and `GROUP BY` are what the
 * database is for.
 *
 * Every query is scoped by `orgId` and parameterised. There is no string
 * interpolation of user input anywhere in this file — the only interpolated
 * value is the bucket unit, which is selected from a closed allowlist.
 */

import { AppError, can, ErrorCode, Permission } from '@orbit/shared';
import { toDisplayString } from '@orbit/utils';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { csvArray } from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';

const router: Router = Router();

const rangeQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  period: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']).default('DAILY'),
  projectId: csvArray,
  siteId: csvArray,
  templateId: csvArray,
  inspectorId: csvArray,
  timezone: z.string().max(64).default('UTC'),
});

type RangeQuery = z.infer<typeof rangeQuery>;

/** Postgres `date_trunc` unit per reporting period. Closed set — never user input. */
const BUCKET_UNIT: Record<string, string> = {
  DAILY: 'day',
  WEEKLY: 'week',
  MONTHLY: 'month',
  QUARTERLY: 'quarter',
  YEARLY: 'year',
};

function resolveRange(q: RangeQuery): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  // Default window is 30 days: long enough to show a trend, short enough that
  // the first load of a dashboard is not a table scan.
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'The start of the range must be before its end.',
    );
  }
  return { from, to };
}

/** Prisma filter shared by the non-raw queries. */
function baseFilter(
  subject: ReturnType<typeof auth>,
  q: RangeQuery,
  range: { from: Date; to: Date },
): Prisma.InspectionWhereInput {
  const where: Prisma.InspectionWhereInput = {
    orgId: subject.orgId,
    deletedAt: null,
    createdAt: { gte: range.from, lte: range.to },
    ...(q.projectId?.length ? { projectId: { in: q.projectId } } : {}),
    ...(q.siteId?.length ? { siteId: { in: q.siteId } } : {}),
    ...(q.templateId?.length ? { templateId: { in: q.templateId } } : {}),
    ...(q.inspectorId?.length ? { assignedToId: { in: q.inspectorId } } : {}),
  };

  // Without org-wide analytics permission a user only sees their own numbers.
  if (!can(subject, Permission.ANALYTICS_READ_ALL)) {
    where.assignedToId = subject.userId;
  }
  return where;
}

/**
 * Headline summary.
 *
 * One grouped query for the status counts plus a small number of targeted
 * aggregates, rather than a dozen round trips.
 */
router.get(
  '/summary',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery;
    const range = resolveRange(q);
    const where = baseFilter(subject, q, range);

    const [byStatus, byOutcome, aggregate, overdue, dueToday] = await Promise.all([
      prisma.inspection.groupBy({ by: ['status'], where, _count: true }),
      prisma.inspection.groupBy({ by: ['outcome'], where, _count: true }),
      prisma.inspection.aggregate({
        where,
        _count: true,
        _avg: { score: true },
      }),
      prisma.inspection.count({
        where: {
          ...where,
          dueAt: { lt: new Date() },
          status: { notIn: ['APPROVED', 'CANCELLED', 'ARCHIVED', 'SUBMITTED', 'UNDER_REVIEW'] },
        },
      }),
      prisma.inspection.count({
        where: {
          ...where,
          dueAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lt: new Date(new Date().setHours(24, 0, 0, 0)),
          },
          status: { notIn: ['APPROVED', 'CANCELLED', 'ARCHIVED'] },
        },
      }),
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

    // Average duration, computed in the database. Only inspections that both
    // started and completed contribute — an in-progress job has no duration.
    const duration = await prisma.$queryRaw<Array<{ avg_minutes: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM ("completedAt" - "startedAt")) / 60)::float AS avg_minutes
        FROM inspections
       WHERE "orgId" = ${subject.orgId}
         AND "deletedAt" IS NULL
         AND "startedAt" IS NOT NULL
         AND "completedAt" IS NOT NULL
         AND "createdAt" BETWEEN ${range.from} AND ${range.to}
    `;

    res.json({
      data: {
        range: { from: range.from.toISOString(), to: range.to.toISOString() },
        total,
        statusCounts,
        outcomeCounts,
        completed,
        failed,
        overdue,
        dueToday,
        // Guarded: a period with no work is 0%, not NaN.
        completionRate: total > 0 ? Math.round((completed / total) * 1000) / 10 : 0,
        failureRate: scored > 0 ? Math.round((failed / scored) * 1000) / 10 : 0,
        averageScore:
          aggregate._avg.score !== null ? Math.round(aggregate._avg.score * 10) / 10 : null,
        averageDurationMinutes:
          duration[0]?.avg_minutes != null ? Math.round(duration[0].avg_minutes) : null,
      },
    });
  }),
);

/** Time series bucketed by the requested period. */
router.get(
  '/trend',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery;
    const range = resolveRange(q);

    const unit = BUCKET_UNIT[q.period] ?? 'day';
    const scopeToSelf = !can(subject, Permission.ANALYTICS_READ_ALL);

    // `unit` and `timezone` are interpolated, so both are constrained: `unit`
    // comes from the closed map above, and an invalid timezone makes Postgres
    // raise rather than silently mis-bucket.
    const rows = await prisma.$queryRaw<
      Array<{ bucket: Date; total: bigint; completed: bigint; failed: bigint; passed: bigint }>
    >`
      SELECT date_trunc(${Prisma.raw(`'${unit}'`)}, "createdAt" AT TIME ZONE ${q.timezone}) AS bucket,
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE status IN ('APPROVED','SUBMITTED','UNDER_REVIEW'))::bigint AS completed,
             COUNT(*) FILTER (WHERE outcome = 'FAIL')::bigint AS failed,
             COUNT(*) FILTER (WHERE outcome IN ('PASS','PASS_WITH_OBSERVATIONS'))::bigint AS passed
        FROM inspections
       WHERE "orgId" = ${subject.orgId}
         AND "deletedAt" IS NULL
         AND "createdAt" BETWEEN ${range.from} AND ${range.to}
         AND (${!scopeToSelf} OR "assignedToId" = ${subject.userId})
       GROUP BY bucket
       ORDER BY bucket ASC
    `;

    res.json({
      data: rows.map((row) => ({
        bucket: row.bucket.toISOString(),
        total: Number(row.total),
        completed: Number(row.completed),
        failed: Number(row.failed),
        passed: Number(row.passed),
      })),
    });
  }),
);

/** Per-inspector performance. Requires org-wide analytics. */
router.get(
  '/inspectors',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ_ALL),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery;
    const range = resolveRange(q);

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        first_name: string;
        last_name: string;
        assigned: bigint;
        completed: bigint;
        failed: bigint;
        avg_score: number | null;
        avg_minutes: number | null;
        on_time: bigint;
        with_due: bigint;
      }>
    >`
      SELECT u.id AS user_id, u."firstName" AS first_name, u."lastName" AS last_name,
             COUNT(i.id)::bigint AS assigned,
             COUNT(i.id) FILTER (WHERE i.status IN ('APPROVED','SUBMITTED','UNDER_REVIEW'))::bigint AS completed,
             COUNT(i.id) FILTER (WHERE i.outcome = 'FAIL')::bigint AS failed,
             AVG(i.score)::float AS avg_score,
             AVG(EXTRACT(EPOCH FROM (i."completedAt" - i."startedAt")) / 60)::float AS avg_minutes,
             COUNT(i.id) FILTER (WHERE i."completedAt" IS NOT NULL AND i."dueAt" IS NOT NULL AND i."completedAt" <= i."dueAt")::bigint AS on_time,
             COUNT(i.id) FILTER (WHERE i."dueAt" IS NOT NULL AND i."completedAt" IS NOT NULL)::bigint AS with_due
        FROM users u
        LEFT JOIN inspections i
          ON i."assignedToId" = u.id
         AND i."deletedAt" IS NULL
         AND i."createdAt" BETWEEN ${range.from} AND ${range.to}
       WHERE u."orgId" = ${subject.orgId}
         AND u."deletedAt" IS NULL
         AND u.role IN ('INSPECTOR','TECHNICIAN','SUPERVISOR')
       GROUP BY u.id, u."firstName", u."lastName"
       HAVING COUNT(i.id) > 0
       ORDER BY assigned DESC
       LIMIT 200
    `;

    res.json({
      data: rows.map((row) => {
        const assigned = Number(row.assigned);
        const completed = Number(row.completed);
        const withDue = Number(row.with_due);
        return {
          userId: row.user_id,
          name: `${row.first_name} ${row.last_name}`,
          assigned,
          completed,
          failed: Number(row.failed),
          completionRate: assigned > 0 ? Math.round((completed / assigned) * 1000) / 10 : 0,
          averageScore: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null,
          averageDurationMinutes: row.avg_minutes != null ? Math.round(row.avg_minutes) : null,
          // Only meaningful where a due date existed; reported as null otherwise
          // rather than a misleading 100%.
          onTimeRate: withDue > 0 ? Math.round((Number(row.on_time) / withDue) * 1000) / 10 : null,
        };
      }),
    });
  }),
);

/** Per-site statistics, including failure concentration. */
router.get(
  '/sites',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ_ALL),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery;
    const range = resolveRange(q);

    const rows = await prisma.$queryRaw<
      Array<{
        site_id: string;
        name: string;
        latitude: number | null;
        longitude: number | null;
        total: bigint;
        failed: bigint;
        avg_score: number | null;
        last_inspected: Date | null;
      }>
    >`
      SELECT s.id AS site_id, s.name, s.latitude, s.longitude,
             COUNT(i.id)::bigint AS total,
             COUNT(i.id) FILTER (WHERE i.outcome = 'FAIL')::bigint AS failed,
             AVG(i.score)::float AS avg_score,
             MAX(i."completedAt") AS last_inspected
        FROM sites s
        JOIN inspections i
          ON i."siteId" = s.id
         AND i."deletedAt" IS NULL
         AND i."createdAt" BETWEEN ${range.from} AND ${range.to}
       WHERE s."orgId" = ${subject.orgId}
         AND s."deletedAt" IS NULL
       GROUP BY s.id, s.name, s.latitude, s.longitude
       ORDER BY failed DESC, total DESC
       LIMIT 500
    `;

    res.json({
      data: rows.map((row) => {
        const total = Number(row.total);
        const failed = Number(row.failed);
        return {
          siteId: row.site_id,
          name: row.name,
          latitude: row.latitude,
          longitude: row.longitude,
          total,
          failed,
          failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
          averageScore: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null,
          lastInspectedAt: row.last_inspected?.toISOString() ?? null,
        };
      }),
    });
  }),
);

/** Per-project rollup. */
router.get(
  '/projects',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ_ALL),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery;
    const range = resolveRange(q);

    const rows = await prisma.$queryRaw<
      Array<{
        project_id: string;
        name: string;
        code: string;
        total: bigint;
        completed: bigint;
        failed: bigint;
        avg_score: number | null;
      }>
    >`
      SELECT p.id AS project_id, p.name, p.code,
             COUNT(i.id)::bigint AS total,
             COUNT(i.id) FILTER (WHERE i.status IN ('APPROVED','SUBMITTED','UNDER_REVIEW'))::bigint AS completed,
             COUNT(i.id) FILTER (WHERE i.outcome = 'FAIL')::bigint AS failed,
             AVG(i.score)::float AS avg_score
        FROM projects p
        LEFT JOIN inspections i
          ON i."projectId" = p.id
         AND i."deletedAt" IS NULL
         AND i."createdAt" BETWEEN ${range.from} AND ${range.to}
       WHERE p."orgId" = ${subject.orgId}
         AND p."deletedAt" IS NULL
       GROUP BY p.id, p.name, p.code
       ORDER BY total DESC
       LIMIT 200
    `;

    res.json({
      data: rows.map((row) => {
        const total = Number(row.total);
        return {
          projectId: row.project_id,
          name: row.name,
          code: row.code,
          total,
          completed: Number(row.completed),
          failed: Number(row.failed),
          completionRate: total > 0 ? Math.round((Number(row.completed) / total) * 1000) / 10 : 0,
          averageScore: row.avg_score != null ? Math.round(row.avg_score * 10) / 10 : null,
        };
      }),
    });
  }),
);

/**
 * Heat map cells.
 *
 * Coordinates are rounded to a grid so nearby inspections cluster into one cell
 * rather than rendering ten thousand overlapping points the browser cannot draw.
 */
router.get(
  '/heatmap',
  requireAuth,
  requirePermission(Permission.ANALYTICS_READ_ALL),
  validate({
    query: rangeQuery.extend({
      // ~1.1 km at 2 decimal places; 3 gives ~110 m for a dense urban portfolio.
      precision: z.coerce.number().int().min(1).max(4).default(2),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery & { precision: number };
    const range = resolveRange(q);

    const rows = await prisma.$queryRaw<
      Array<{ lat: number; lon: number; weight: bigint; failures: bigint }>
    >`
      SELECT ROUND(s.latitude::numeric, ${q.precision}::int)::float AS lat,
             ROUND(s.longitude::numeric, ${q.precision}::int)::float AS lon,
             COUNT(i.id)::bigint AS weight,
             COUNT(i.id) FILTER (WHERE i.outcome = 'FAIL')::bigint AS failures
        FROM inspections i
        JOIN sites s ON s.id = i."siteId"
       WHERE i."orgId" = ${subject.orgId}
         AND i."deletedAt" IS NULL
         AND s.latitude IS NOT NULL
         AND s.longitude IS NOT NULL
         AND i."createdAt" BETWEEN ${range.from} AND ${range.to}
       GROUP BY lat, lon
       ORDER BY weight DESC
       LIMIT 5000
    `;

    res.json({
      data: rows.map((row) => ({
        latitude: row.lat,
        longitude: row.lon,
        weight: Number(row.weight),
        failures: Number(row.failures),
      })),
    });
  }),
);

/**
 * CSV export.
 *
 * Streamed as text rather than assembled as JSON: an export of a year's
 * inspections is large, and the browser's download machinery handles it better
 * than a client-side blob.
 */
router.get(
  '/export/inspections.csv',
  requireAuth,
  requirePermission(Permission.REPORT_EXPORT),
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as RangeQuery;
    const range = resolveRange(q);
    const where = baseFilter(subject, q, range);

    const rows = await prisma.inspection.findMany({
      where,
      include: {
        template: { select: { name: true } },
        site: { select: { name: true } },
        client: { select: { name: true } },
        project: { select: { code: true } },
        assignedTo: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      // Bounded: beyond this an export belongs in a background job rather than
      // a request that will time out at the load balancer.
      take: 20_000,
    });

    /** RFC-4180 escaping. Quotes are doubled; anything risky is quoted. */
    const cell = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      // An object would stringify to the literal "[object Object]", which in an
      // exported spreadsheet looks like data rather than a bug.
      const text = toDisplayString(value);
      // A leading =, +, -, or @ is interpreted as a formula by Excel; prefixing
      // with an apostrophe neutralises CSV injection.
      const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };

    const header = [
      'Number',
      'Title',
      'Template',
      'Status',
      'Outcome',
      'Priority',
      'Score',
      'Client',
      'Site',
      'Project',
      'Inspector',
      'Created',
      'Started',
      'Completed',
      'Due',
      'Questions',
      'Answered',
      'Failed',
      'Critical failures',
    ];

    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.number,
          row.title,
          row.template?.name,
          row.status,
          row.outcome,
          row.priority,
          row.score,
          row.client?.name,
          row.site?.name,
          row.project?.code,
          row.assignedTo ? `${row.assignedTo.firstName} ${row.assignedTo.lastName}` : '',
          row.createdAt,
          row.startedAt,
          row.completedAt,
          row.dueAt,
          row.totalFields,
          row.answeredFields,
          row.failedFields,
          row.criticalFailures,
        ]
          .map(cell)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="inspections-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}.csv"`,
    );
    // BOM so Excel opens UTF-8 correctly rather than mangling accented names.
    // Written as an escape, not a literal glyph — editors and formatters strip
    // an invisible leading BOM from source and the export silently regresses.
    res.send(`\uFEFF${lines.join('\r\n')}`);
  }),
);

export { router as analyticsRouter };
