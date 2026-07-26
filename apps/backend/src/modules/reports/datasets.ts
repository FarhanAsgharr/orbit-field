/**
 * Export datasets.
 *
 * One definition per exportable entity, shared by the Excel, CSV, and PDF
 * paths. Defining columns once is what stops the CSV and the spreadsheet
 * disagreeing about what "completion rate" means — a discrepancy nobody notices
 * until an auditor puts the two side by side.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '../../db/prisma.js';
import { type PreparedSheet, sheet, type SheetColumn, toCsv } from './excel.service.js';
import { type PreparedSection, section } from './pdf.service.js';

export interface DatasetContext {
  orgId: string;
  from: Date;
  to: Date;
  /** Restricts to one inspector when the caller lacks org-wide analytics. */
  scopeToUserId?: string;
  projectIds?: string[];
  siteIds?: string[];
  templateIds?: string[];
  limit?: number;
}

export interface Dataset<T> {
  key: string;
  /** Worksheet name and CSV filename stem. */
  name: string;
  subtitle?: string;
  columns: Array<SheetColumn<T>>;
  totals?: string[];
  load: (ctx: DatasetContext) => Promise<T[]>;
}

/** Hard ceiling per export. Beyond this a report belongs in a scheduled job. */
const MAX_ROWS = 20_000;

const asDate = (value: Date | null | undefined): Date | null => value ?? null;

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

type InspectionRow = Prisma.InspectionGetPayload<{
  include: {
    template: { select: { name: true } };
    templateVersion: { select: { version: true } };
    site: { select: { name: true } };
    client: { select: { name: true } };
    project: { select: { code: true; name: true } };
    assignedTo: { select: { firstName: true; lastName: true; email: true } };
    reviewedBy: { select: { firstName: true; lastName: true } };
    _count: { select: { attachments: true; responses: true } };
  };
}>;

export const inspectionsDataset: Dataset<InspectionRow> = {
  key: 'inspections',
  name: 'Inspections',
  subtitle: 'One row per inspection, including outcome and evidence counts.',
  totals: ['Questions', 'Answered', 'Failed', 'Attachments'],
  columns: [
    { header: 'Reference', value: (r) => r.number, width: 18 },
    { header: 'Title', value: (r) => r.title, width: 38 },
    { header: 'Checklist', value: (r) => r.template?.name ?? '', width: 30 },
    {
      header: 'Version',
      value: (r) => r.templateVersion?.version ?? null,
      format: 'integer',
      width: 9,
    },
    { header: 'Status', value: (r) => r.status.replace(/_/g, ' '), width: 14 },
    {
      header: 'Result',
      value: (r) => r.outcome.replace(/_/g, ' '),
      width: 20,
      // Colour follows the same semantics as the app and the console.
      signal: (r) =>
        r.outcome === 'FAIL'
          ? 'danger'
          : r.outcome === 'PASS_WITH_OBSERVATIONS'
            ? 'warn'
            : r.outcome === 'PASS'
              ? 'ok'
              : null,
    },
    { header: 'Priority', value: (r) => r.priority, width: 11 },
    { header: 'Score', value: (r) => r.score, format: 'percent', width: 9 },
    { header: 'Client', value: (r) => r.client?.name ?? '', width: 26 },
    { header: 'Site', value: (r) => r.site?.name ?? '', width: 30 },
    { header: 'Project', value: (r) => r.project?.code ?? '', width: 16 },
    {
      header: 'Inspector',
      value: (r) => (r.assignedTo ? `${r.assignedTo.firstName} ${r.assignedTo.lastName}` : ''),
      width: 22,
    },
    { header: 'Created', value: (r) => asDate(r.createdAt), format: 'datetime', width: 18 },
    { header: 'Started', value: (r) => asDate(r.startedAt), format: 'datetime', width: 18 },
    { header: 'Completed', value: (r) => asDate(r.completedAt), format: 'datetime', width: 18 },
    { header: 'Due', value: (r) => asDate(r.dueAt), format: 'date', width: 13 },
    {
      header: 'Overdue',
      value: (r) =>
        r.dueAt && r.completedAt && r.completedAt > r.dueAt
          ? 'Yes'
          : r.dueAt && !r.completedAt && r.dueAt < new Date()
            ? 'Yes'
            : 'No',
      width: 10,
      signal: (r) =>
        (r.dueAt && r.completedAt && r.completedAt > r.dueAt) ||
        (r.dueAt && !r.completedAt && r.dueAt < new Date())
          ? 'warn'
          : null,
    },
    { header: 'Questions', value: (r) => r.totalFields, format: 'integer', width: 11 },
    { header: 'Answered', value: (r) => r.answeredFields, format: 'integer', width: 11 },
    {
      header: 'Failed',
      value: (r) => r.failedFields,
      format: 'integer',
      width: 9,
      signal: (r) => (r.failedFields > 0 ? 'danger' : null),
    },
    {
      header: 'Critical failures',
      value: (r) => r.criticalFailures,
      format: 'integer',
      width: 15,
      signal: (r) => (r.criticalFailures > 0 ? 'danger' : null),
    },
    { header: 'Attachments', value: (r) => r._count.attachments, format: 'integer', width: 12 },
    {
      header: 'Location at completion',
      value: (r) => {
        const point = r.endLocation as { latitude?: number; longitude?: number } | null;
        return point?.latitude !== undefined && point.longitude !== undefined
          ? `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`
          : '';
      },
      width: 24,
    },
    { header: 'Notes', value: (r) => r.notes ?? '', width: 48 },
  ],
  load: async (ctx) =>
    prisma.inspection.findMany({
      where: {
        orgId: ctx.orgId,
        deletedAt: null,
        createdAt: { gte: ctx.from, lte: ctx.to },
        ...(ctx.scopeToUserId ? { assignedToId: ctx.scopeToUserId } : {}),
        ...(ctx.projectIds?.length ? { projectId: { in: ctx.projectIds } } : {}),
        ...(ctx.siteIds?.length ? { siteId: { in: ctx.siteIds } } : {}),
        ...(ctx.templateIds?.length ? { templateId: { in: ctx.templateIds } } : {}),
      },
      include: {
        template: { select: { name: true } },
        templateVersion: { select: { version: true } },
        site: { select: { name: true } },
        client: { select: { name: true } },
        project: { select: { code: true, name: true } },
        assignedTo: { select: { firstName: true, lastName: true, email: true } },
        reviewedBy: { select: { firstName: true, lastName: true } },
        _count: { select: { attachments: true, responses: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(ctx.limit ?? MAX_ROWS, MAX_ROWS),
    }),
};

// ---------------------------------------------------------------------------
// Analytics rollups
// ---------------------------------------------------------------------------

interface InspectorStat {
  name: string;
  email: string;
  assigned: number;
  completed: number;
  failed: number;
  completionRate: number;
  averageScore: number | null;
  averageMinutes: number | null;
  onTimeRate: number | null;
}

export const inspectorsDataset: Dataset<InspectorStat> = {
  key: 'inspectors',
  name: 'Inspector performance',
  subtitle: 'Throughput and quality per inspector over the reporting period.',
  totals: ['Assigned', 'Completed', 'Failed'],
  columns: [
    { header: 'Inspector', value: (r) => r.name, width: 24 },
    { header: 'Email', value: (r) => r.email, width: 30 },
    { header: 'Assigned', value: (r) => r.assigned, format: 'integer', width: 11 },
    { header: 'Completed', value: (r) => r.completed, format: 'integer', width: 11 },
    { header: 'Failed', value: (r) => r.failed, format: 'integer', width: 9 },
    {
      header: 'Completion rate',
      value: (r) => r.completionRate,
      format: 'percent',
      width: 15,
      signal: (r) => (r.completionRate >= 80 ? 'ok' : r.completionRate >= 50 ? 'warn' : 'danger'),
    },
    { header: 'Average score', value: (r) => r.averageScore, format: 'percent', width: 14 },
    {
      header: 'Average minutes on site',
      value: (r) => r.averageMinutes,
      format: 'integer',
      width: 20,
    },
    { header: 'On time', value: (r) => r.onTimeRate, format: 'percent', width: 10 },
  ],
  load: async (ctx) => {
    const rows = await prisma.$queryRaw<
      Array<{
        first_name: string;
        last_name: string;
        email: string;
        assigned: bigint;
        completed: bigint;
        failed: bigint;
        avg_score: number | null;
        avg_minutes: number | null;
        on_time: bigint;
        with_due: bigint;
      }>
    >`
      SELECT u."firstName" AS first_name, u."lastName" AS last_name, u.email,
             COUNT(i.id)::bigint AS assigned,
             COUNT(i.id) FILTER (WHERE i.status IN ('APPROVED','SUBMITTED','UNDER_REVIEW'))::bigint AS completed,
             COUNT(i.id) FILTER (WHERE i.outcome = 'FAIL')::bigint AS failed,
             AVG(i.score)::float AS avg_score,
             AVG(EXTRACT(EPOCH FROM (i."completedAt" - i."startedAt")) / 60)::float AS avg_minutes,
             COUNT(i.id) FILTER (WHERE i."completedAt" IS NOT NULL AND i."dueAt" IS NOT NULL AND i."completedAt" <= i."dueAt")::bigint AS on_time,
             COUNT(i.id) FILTER (WHERE i."dueAt" IS NOT NULL AND i."completedAt" IS NOT NULL)::bigint AS with_due
        FROM users u
        LEFT JOIN inspections i ON i."assignedToId" = u.id
         AND i."deletedAt" IS NULL AND i."createdAt" BETWEEN ${ctx.from} AND ${ctx.to}
       WHERE u."orgId" = ${ctx.orgId} AND u."deletedAt" IS NULL
       GROUP BY u.id, u."firstName", u."lastName", u.email
       HAVING COUNT(i.id) > 0
       ORDER BY assigned DESC`;

    return rows.map((row) => {
      const assigned = Number(row.assigned);
      const completed = Number(row.completed);
      const withDue = Number(row.with_due);
      return {
        name: `${row.first_name} ${row.last_name}`,
        email: row.email,
        assigned,
        completed,
        failed: Number(row.failed),
        completionRate: assigned > 0 ? Math.round((completed / assigned) * 1000) / 10 : 0,
        averageScore: row.avg_score !== null ? Math.round(row.avg_score * 10) / 10 : null,
        averageMinutes: row.avg_minutes !== null ? Math.round(row.avg_minutes) : null,
        // Null rather than 0 when nothing had a due date — "no deadlines" is
        // not the same finding as "always late".
        onTimeRate: withDue > 0 ? Math.round((Number(row.on_time) / withDue) * 1000) / 10 : null,
      };
    });
  },
};

interface SiteStat {
  name: string;
  client: string;
  total: number;
  failed: number;
  failureRate: number;
  averageScore: number | null;
  lastInspected: Date | null;
}

export const sitesDataset: Dataset<SiteStat> = {
  key: 'sites',
  name: 'Site statistics',
  subtitle: 'Where failures concentrate across the estate.',
  totals: ['Inspections', 'Failed'],
  columns: [
    { header: 'Site', value: (r) => r.name, width: 32 },
    { header: 'Client', value: (r) => r.client, width: 26 },
    { header: 'Inspections', value: (r) => r.total, format: 'integer', width: 12 },
    { header: 'Failed', value: (r) => r.failed, format: 'integer', width: 9 },
    {
      header: 'Failure rate',
      value: (r) => r.failureRate,
      format: 'percent',
      width: 13,
      signal: (r) => (r.failureRate > 25 ? 'danger' : r.failureRate > 10 ? 'warn' : 'ok'),
    },
    { header: 'Average score', value: (r) => r.averageScore, format: 'percent', width: 14 },
    { header: 'Last inspected', value: (r) => r.lastInspected, format: 'datetime', width: 18 },
  ],
  load: async (ctx) => {
    const rows = await prisma.$queryRaw<
      Array<{
        name: string;
        client_name: string | null;
        total: bigint;
        failed: bigint;
        avg_score: number | null;
        last_inspected: Date | null;
      }>
    >`
      SELECT s.name, c.name AS client_name,
             COUNT(i.id)::bigint AS total,
             COUNT(i.id) FILTER (WHERE i.outcome = 'FAIL')::bigint AS failed,
             AVG(i.score)::float AS avg_score,
             MAX(i."completedAt") AS last_inspected
        FROM sites s
        JOIN inspections i ON i."siteId" = s.id
         AND i."deletedAt" IS NULL AND i."createdAt" BETWEEN ${ctx.from} AND ${ctx.to}
        LEFT JOIN clients c ON c.id = s."clientId"
       WHERE s."orgId" = ${ctx.orgId} AND s."deletedAt" IS NULL
       GROUP BY s.id, s.name, c.name
       ORDER BY failed DESC, total DESC`;

    return rows.map((row) => {
      const total = Number(row.total);
      const failed = Number(row.failed);
      return {
        name: row.name,
        client: row.client_name ?? '',
        total,
        failed,
        failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
        averageScore: row.avg_score !== null ? Math.round(row.avg_score * 10) / 10 : null,
        lastInspected: row.last_inspected,
      };
    });
  },
};

// ---------------------------------------------------------------------------
// Administrative datasets
// ---------------------------------------------------------------------------

type UserRow = Prisma.UserGetPayload<{
  include: { _count: { select: { devices: true; assignedInspections: true } } };
}>;

export const usersDataset: Dataset<UserRow> = {
  key: 'users',
  name: 'People',
  subtitle: 'Accounts, roles, and access.',
  columns: [
    { header: 'First name', value: (r) => r.firstName, width: 16 },
    { header: 'Last name', value: (r) => r.lastName, width: 18 },
    { header: 'Email', value: (r) => r.email, width: 32 },
    { header: 'Role', value: (r) => r.role.replace(/_/g, ' '), width: 15 },
    {
      header: 'Status',
      value: (r) => r.status,
      width: 13,
      signal: (r) => (r.status === 'ACTIVE' ? 'ok' : r.status === 'SUSPENDED' ? 'danger' : null),
    },
    { header: 'Job title', value: (r) => r.jobTitle ?? '', width: 22 },
    { header: 'Department', value: (r) => r.department ?? '', width: 20 },
    { header: 'Devices', value: (r) => r._count.devices, format: 'integer', width: 9 },
    {
      header: 'Assigned work',
      value: (r) => r._count.assignedInspections,
      format: 'integer',
      width: 14,
    },
    {
      header: 'Last signed in',
      value: (r) => asDate(r.lastLoginAt),
      format: 'datetime',
      width: 18,
    },
    { header: 'Created', value: (r) => asDate(r.createdAt), format: 'datetime', width: 18 },
  ],
  load: async (ctx) =>
    prisma.user.findMany({
      where: { orgId: ctx.orgId, deletedAt: null },
      include: { _count: { select: { devices: true, assignedInspections: true } } },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    }),
};

type DeviceRow = Prisma.DeviceGetPayload<{
  include: { user: { select: { firstName: true; lastName: true; email: true } } };
}>;

export const devicesDataset: Dataset<DeviceRow> = {
  key: 'devices',
  name: 'Devices',
  subtitle: 'Enrolled devices and their sync position.',
  columns: [
    { header: 'Device', value: (r) => r.name, width: 26 },
    { header: 'Person', value: (r) => `${r.user.firstName} ${r.user.lastName}`, width: 22 },
    { header: 'Platform', value: (r) => `${r.platform} ${r.osVersion}`, width: 16 },
    { header: 'App version', value: (r) => r.appVersion, width: 12 },
    { header: 'Sync cursor', value: (r) => Number(r.lastSyncCursor), format: 'integer', width: 12 },
    { header: 'Last sync', value: (r) => asDate(r.lastSyncAt), format: 'datetime', width: 18 },
    { header: 'Last seen', value: (r) => asDate(r.lastSeenAt), format: 'datetime', width: 18 },
    {
      header: 'State',
      value: (r) => (r.revokedAt ? 'Revoked' : 'Active'),
      width: 11,
      signal: (r) => (r.revokedAt ? 'danger' : 'ok'),
    },
    { header: 'Revoked reason', value: (r) => r.revokedReason ?? '', width: 28 },
  ],
  load: async (ctx) =>
    prisma.device.findMany({
      where: { orgId: ctx.orgId, deletedAt: null },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { lastSeenAt: 'desc' },
      take: MAX_ROWS,
    }),
};

type AuditRow = Prisma.AuditLogGetPayload<{
  include: { user: { select: { firstName: true; lastName: true; email: true } } };
}>;

export const auditDataset: Dataset<AuditRow> = {
  key: 'audit',
  name: 'Audit log',
  subtitle: 'Append-only record of access and record changes.',
  columns: [
    { header: 'When', value: (r) => asDate(r.createdAt), format: 'datetime', width: 19 },
    { header: 'Action', value: (r) => r.action.replace(/_/g, ' '), width: 26 },
    {
      header: 'Who',
      value: (r) => (r.user ? `${r.user.firstName} ${r.user.lastName}` : 'System'),
      width: 22,
    },
    { header: 'Email', value: (r) => r.user?.email ?? '', width: 30 },
    { header: 'Record type', value: (r) => r.entity ?? '', width: 18 },
    { header: 'Record id', value: (r) => r.entityId ?? '', width: 28 },
    { header: 'From address', value: (r) => (r.ipAddress ? String(r.ipAddress) : ''), width: 16 },
    {
      header: 'Detail',
      value: (r) => (r.metadata ? JSON.stringify(r.metadata).slice(0, 400) : ''),
      width: 46,
    },
  ],
  load: async (ctx) =>
    prisma.auditLog.findMany({
      where: { orgId: ctx.orgId, createdAt: { gte: ctx.from, lte: ctx.to } },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
    }),
};

type ClientRow = Prisma.ClientGetPayload<{
  include: { _count: { select: { projects: true; sites: true; inspections: true } } };
}>;

export const clientsDataset: Dataset<ClientRow> = {
  key: 'clients',
  name: 'Clients',
  columns: [
    { header: 'Client', value: (r) => r.name, width: 30 },
    { header: 'Code', value: (r) => r.code ?? '', width: 12 },
    { header: 'Contact', value: (r) => r.contactName ?? '', width: 22 },
    { header: 'Email', value: (r) => r.contactEmail ?? '', width: 28 },
    { header: 'Phone', value: (r) => r.contactPhone ?? '', width: 18 },
    { header: 'Projects', value: (r) => r._count.projects, format: 'integer', width: 10 },
    { header: 'Sites', value: (r) => r._count.sites, format: 'integer', width: 9 },
    { header: 'Inspections', value: (r) => r._count.inspections, format: 'integer', width: 12 },
  ],
  load: async (ctx) =>
    prisma.client.findMany({
      where: { orgId: ctx.orgId, deletedAt: null },
      include: { _count: { select: { projects: true, sites: true, inspections: true } } },
      orderBy: { name: 'asc' },
      take: MAX_ROWS,
    }),
};

type ProjectRow = Prisma.ProjectGetPayload<{
  include: {
    client: { select: { name: true } };
    manager: { select: { firstName: true; lastName: true } };
    _count: { select: { sites: true; inspections: true } };
  };
}>;

export const projectsDataset: Dataset<ProjectRow> = {
  key: 'projects',
  name: 'Projects',
  columns: [
    { header: 'Project', value: (r) => r.name, width: 32 },
    { header: 'Code', value: (r) => r.code, width: 16 },
    { header: 'Client', value: (r) => r.client?.name ?? '', width: 26 },
    {
      header: 'Manager',
      value: (r) => (r.manager ? `${r.manager.firstName} ${r.manager.lastName}` : ''),
      width: 22,
    },
    { header: 'Start', value: (r) => asDate(r.startDate), format: 'date', width: 13 },
    { header: 'End', value: (r) => asDate(r.endDate), format: 'date', width: 13 },
    { header: 'Sites', value: (r) => r._count.sites, format: 'integer', width: 9 },
    { header: 'Inspections', value: (r) => r._count.inspections, format: 'integer', width: 12 },
    { header: 'Active', value: (r) => (r.isActive ? 'Yes' : 'No'), width: 9 },
  ],
  load: async (ctx) =>
    prisma.project.findMany({
      where: { orgId: ctx.orgId, deletedAt: null },
      include: {
        client: { select: { name: true } },
        manager: { select: { firstName: true, lastName: true } },
        _count: { select: { sites: true, inspections: true } },
      },
      orderBy: { name: 'asc' },
      take: MAX_ROWS,
    }),
};

/**
 * A dataset loaded and bound to every output format.
 *
 * The row type is sealed in here. Indexing a map of `Dataset<T>` by a runtime
 * key gives TypeScript a union of `columns` and a union of `rows` that it
 * cannot correlate — it has no way to know the columns came from the same
 * member as the rows. Preparing each dataset behind a monomorphic thunk binds
 * the type at its definition site, where it is known, and keeps every column's
 * value extractor genuinely type-checked against its row.
 */
export interface PreparedDataset {
  key: string;
  name: string;
  subtitle?: string;
  count: number;
  sheet: PreparedSheet;
  section: PreparedSection;
  csv: () => string;
}

async function prepare<T>(spec: Dataset<T>, ctx: DatasetContext): Promise<PreparedDataset> {
  const rows = await spec.load(ctx);
  return {
    key: spec.key,
    name: spec.name,
    subtitle: spec.subtitle,
    count: rows.length,
    sheet: sheet({
      name: spec.name,
      subtitle: spec.subtitle,
      columns: spec.columns,
      rows,
      totals: spec.totals,
    }),
    section: section({
      heading: spec.name,
      description: spec.subtitle,
      columns: spec.columns,
      rows,
    }),
    csv: () => toCsv(spec.columns, rows),
  };
}

/** Everything exportable, keyed by the identifier the API accepts. */
export const DATASETS = {
  inspections: inspectionsDataset,
  inspectors: inspectorsDataset,
  sites: sitesDataset,
  users: usersDataset,
  devices: devicesDataset,
  audit: auditDataset,
  clients: clientsDataset,
  projects: projectsDataset,
} as const;

export type DatasetKey = keyof typeof DATASETS;

export const DATASET_KEYS = Object.keys(DATASETS) as DatasetKey[];

/**
 * Loaders, one per dataset, each monomorphic at its definition site.
 * This is what makes `DATASET_LOADERS[key](ctx)` type-safe.
 */
export const DATASET_LOADERS: Record<
  DatasetKey,
  (ctx: DatasetContext) => Promise<PreparedDataset>
> = {
  inspections: (ctx) => prepare(inspectionsDataset, ctx),
  inspectors: (ctx) => prepare(inspectorsDataset, ctx),
  sites: (ctx) => prepare(sitesDataset, ctx),
  users: (ctx) => prepare(usersDataset, ctx),
  devices: (ctx) => prepare(devicesDataset, ctx),
  audit: (ctx) => prepare(auditDataset, ctx),
  clients: (ctx) => prepare(clientsDataset, ctx),
  projects: (ctx) => prepare(projectsDataset, ctx),
};

/** Permission required to export each dataset. */
export const DATASET_PERMISSION: Record<DatasetKey, string> = {
  inspections: 'inspection:read',
  inspectors: 'analytics:read:all',
  sites: 'analytics:read:all',
  users: 'user:read',
  devices: 'device:read',
  audit: 'audit:read',
  clients: 'client:read',
  projects: 'project:read',
};
