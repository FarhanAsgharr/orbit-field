/**
 * Notification inbox and preferences.
 *
 * The inbox is the authoritative record; push is only early warning. A user who
 * had notifications muted, was in quiet hours, or had no device registered still
 * sees everything here when they open the app.
 */

import { AppError, ErrorCode, Permission } from '@orbit/shared';
import { NotificationTopic } from '@orbit/types';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { paginate, paginationArgs, paginationSchema } from '../../lib/pagination.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import {
  DEFAULT_PREFERENCES,
  loadPreferences,
  notifyUsers,
  savePreferences,
  sweepDueInspections,
} from './push.service.js';

const router: Router = Router();

/** The signed-in user's inbox. */
router.get(
  '/',
  requireAuth,
  validate({
    query: paginationSchema.extend({
      unreadOnly: z.coerce.boolean().default(false),
      // `unreadOnly` is kept as-is so existing clients are unaffected; `read`
      // is the fuller filter the console needs (unread / read / either).
      read: z.enum(['true', 'false']).optional(),
      topic: z.string().max(60).optional(),
      search: z.string().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as {
      page: number;
      pageSize: number;
      unreadOnly: boolean;
      read?: 'true' | 'false';
      topic?: string;
      search?: string;
    };

    const where = {
      userId: subject.userId,
      orgId: subject.orgId,
      deletedAt: null,
      ...(q.unreadOnly || q.read === 'false' ? { readAt: null } : {}),
      ...(q.read === 'true' ? { readAt: { not: null } } : {}),
      ...(q.topic ? { topic: q.topic } : {}),
      ...(q.search
        ? {
            OR: [
              { title: { contains: q.search, mode: 'insensitive' as const } },
              { body: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [items, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginationArgs(q) }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: { userId: subject.userId, orgId: subject.orgId, readAt: null, deletedAt: null },
      }),
    ]);

    // The unread count drives the app icon badge, so it ships with every page
    // rather than needing a second request.
    res.json({ data: { ...paginate(items, total, q), unread } });
  }),
);

router.post(
  '/:id/read',
  requireAuth,
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const { count } = await prisma.notification.updateMany({
      where: { id, userId: subject.userId, readAt: null },
      data: { readAt: new Date() },
    });

    if (count === 0) {
      // Either it does not exist or it belongs to someone else. Both are a 404
      // — confirming existence would leak another user's inbox.
      throw new AppError(ErrorCode.NOT_FOUND, 'That notification was not found.');
    }

    res.status(204).end();
  }),
);

router.post(
  '/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { count } = await prisma.notification.updateMany({
      where: { userId: subject.userId, orgId: subject.orgId, readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ data: { marked: count } });
  }),
);

/** Preferences: categories, quiet hours, sound. */
/**
 * Remove a notification from your own inbox.
 *
 * Soft, and scoped to the caller: an inbox entry belongs to one person, and a
 * notification somebody has dismissed is not evidence of anything — the
 * underlying inspection, audit entry and change log all remain. Without this
 * the inbox only ever grows, which is why people stop reading it.
 */
router.delete(
  '/:id',
  requireAuth,
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const existing = await prisma.notification.findFirst({
      where: { id, userId: subject.userId, orgId: subject.orgId, deletedAt: null },
      select: { id: true },
    });
    // Scoped to `userId`, so one person cannot clear another's inbox.
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'That notification was not found.');

    await prisma.notification.update({ where: { id }, data: { deletedAt: new Date() } });
    res.status(204).end();
  }),
);

router.get(
  '/preferences',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    res.json({
      data: {
        preferences: await loadPreferences(subject.userId),
        topics: Object.values(NotificationTopic).map((topic) => ({
          topic,
          label: TOPIC_LABEL[topic] ?? topic,
          description: TOPIC_DESCRIPTION[topic] ?? null,
          // Some topics cannot be muted: a conflict blocks the inspector's own
          // queue until they decide, so silencing it would strand their work.
          mutable: !UNMUTABLE.includes(topic),
        })),
      },
    });
  }),
);

const UNMUTABLE: string[] = [NotificationTopic.SYNC_CONFLICT];

const TOPIC_LABEL: Record<string, string> = {
  [NotificationTopic.INSPECTION_ASSIGNED]: 'New work assigned to me',
  [NotificationTopic.INSPECTION_DUE]: 'Due within 24 hours',
  [NotificationTopic.INSPECTION_OVERDUE]: 'Overdue',
  [NotificationTopic.INSPECTION_APPROVED]: 'My work approved',
  [NotificationTopic.INSPECTION_REJECTED]: 'My work sent back',
  [NotificationTopic.SYNC_COMPLETED]: 'Sync finished',
  [NotificationTopic.SYNC_CONFLICT]: 'A change needs my decision',
  [NotificationTopic.UPLOAD_FAILED]: 'A photo or file failed to upload',
  [NotificationTopic.REPORT_READY]: 'A report is ready',
};

const TOPIC_DESCRIPTION: Record<string, string> = {
  [NotificationTopic.SYNC_CONFLICT]: 'Always on — your work stays queued until you choose.',
  [NotificationTopic.SYNC_COMPLETED]:
    'Off by default for most people; useful while troubleshooting.',
};

router.patch(
  '/preferences',
  requireAuth,
  validate({
    body: z.object({
      enabled: z.boolean().optional(),
      mutedTopics: z.array(z.string().max(60)).max(40).optional(),
      quietHours: z
        .object({
          enabled: z.boolean(),
          startHour: z.number().int().min(0).max(23),
          endHour: z.number().int().min(0).max(23),
        })
        .nullable()
        .optional(),
      sound: z.boolean().optional(),
      vibrate: z.boolean().optional(),
      badge: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as Record<string, unknown>;

    if (Array.isArray(body.mutedTopics)) {
      const blocked = (body.mutedTopics as string[]).filter((t) => UNMUTABLE.includes(t));
      if (blocked.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Conflict alerts cannot be switched off — your work stays queued until you resolve them.',
          { fields: { mutedTopics: blocked.join(', ') } },
        );
      }
    }

    res.json({ data: await savePreferences(subject.userId, body) });
  }),
);

/**
 * Send an announcement.
 *
 * The one path that fans out to many users, so it is gated on user
 * administration rather than being available to anyone who can log in.
 */
router.post(
  '/announce',
  requireAuth,
  requirePermission(Permission.USER_UPDATE),
  validate({
    body: z.object({
      title: z.string().min(1).max(120),
      body: z.string().min(1).max(500),
      role: z.string().max(40).optional(),
      userIds: z.array(schemas.ulid).max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const input = req.validated!.body as {
      title: string;
      body: string;
      role?: string;
      userIds?: string[];
    };

    const recipients = input.userIds?.length
      ? input.userIds
      : (
          await prisma.user.findMany({
            where: {
              orgId: subject.orgId,
              deletedAt: null,
              status: 'ACTIVE',
              ...(input.role ? { role: input.role as never } : {}),
            },
            select: { id: true },
            take: 2000,
          })
        ).map((u) => u.id);

    const result = await notifyUsers(subject.orgId, recipients, {
      topic: NotificationTopic.REPORT_READY,
      title: input.title,
      body: input.body,
    });

    res.json({ data: result });
  }),
);

/**
 * Due/overdue sweep.
 *
 * Exposed as an endpoint so it can be driven by an external scheduler (cron,
 * Kubernetes CronJob) rather than an in-process timer that would fire once per
 * replica and notify everyone N times.
 */
router.post(
  '/sweep',
  requireAuth,
  requirePermission(Permission.SYSTEM_SETTINGS),
  asyncHandler(async (_req, res) => {
    res.json({ data: await sweepDueInspections() });
  }),
);

export { DEFAULT_PREFERENCES, router as notificationsRouter };
