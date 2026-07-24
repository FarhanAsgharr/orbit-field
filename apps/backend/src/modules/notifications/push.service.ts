/**
 * Push notification delivery.
 *
 * Routed through Expo's push service, which fronts both FCM and APNs. That is a
 * deliberate choice, not a shortcut: the mobile client is an Expo app, so tokens
 * are already `ExponentPushToken[...]`, and Expo handles per-platform payload
 * shaping, APNs certificate rotation, and FCM v1 migration. Talking to FCM and
 * APNs directly would mean maintaining two payload builders and two credential
 * rotations for no behavioural gain.
 *
 * Delivery is best-effort by design. A notification is a *prompt* to open the
 * app; the app then syncs and discovers the real state. Nothing in this system
 * depends on a push arriving, which is what makes it safe to drop one.
 */

import { NotificationTopic } from '@orbit/types';
import { ulid } from '@orbit/utils';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Expo accepts at most 100 messages per request. */
const BATCH_SIZE = 100;

export interface PushMessage {
  topic: NotificationTopic;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Deep link, e.g. `orbit://inspections/01J...`. */
  deepLink?: string;
  /** Overrides the category default. */
  priority?: 'default' | 'high';
}

/**
 * Default urgency per topic.
 *
 * High priority wakes the device from Doze on Android and shows immediately on
 * iOS. Reserved for things an inspector needs *now*; using it for everything is
 * how an app gets its notifications muted.
 */
const TOPIC_PRIORITY: Record<string, 'default' | 'high'> = {
  [NotificationTopic.INSPECTION_ASSIGNED]: 'high',
  [NotificationTopic.INSPECTION_OVERDUE]: 'high',
  [NotificationTopic.SYNC_CONFLICT]: 'high',
  [NotificationTopic.UPLOAD_FAILED]: 'high',
  [NotificationTopic.INSPECTION_DUE]: 'default',
  [NotificationTopic.INSPECTION_APPROVED]: 'default',
  [NotificationTopic.INSPECTION_REJECTED]: 'high',
  [NotificationTopic.SYNC_COMPLETED]: 'default',
  [NotificationTopic.REPORT_READY]: 'default',
};

/** Per-user delivery preferences, stored on the user record. */
export interface NotificationPreferences {
  enabled: boolean;
  /** Topics the user has switched off. */
  mutedTopics: string[];
  quietHours: { enabled: boolean; startHour: number; endHour: number } | null;
  sound: boolean;
  vibrate: boolean;
  badge: boolean;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  mutedTopics: [],
  // Off by default: an inspector on a night shift would otherwise silently miss
  // an urgent assignment because someone chose a sensible-sounding default.
  quietHours: null,
  sound: true,
  vibrate: true,
  badge: true,
};

/**
 * Is the current local time inside the user's quiet hours?
 *
 * Evaluated in the user's own timezone, not the server's. A quiet-hours window
 * computed in UTC is wrong for everyone outside it, which is the majority.
 */
export function inQuietHours(
  preferences: NotificationPreferences,
  timezone: string | null,
  now: Date = new Date(),
): boolean {
  const quiet = preferences.quietHours;
  if (!quiet?.enabled) return false;

  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        hour: 'numeric',
        hour12: false,
        timeZone: timezone ?? 'UTC',
      }).format(now),
    );
  } catch {
    // An invalid stored timezone must not silence notifications entirely.
    hour = now.getUTCHours();
  }

  const { startHour, endHour } = quiet;
  // A window that wraps midnight (22:00–07:00) is the common case.
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Deliver to Expo.
 *
 * Returns per-token outcomes so the caller can retire dead tokens. Never
 * throws: a push failure must not roll back the database write that triggered
 * it — the inspection assignment is the real event, the notification is a hint.
 */
async function sendToExpo(
  messages: Array<{ to: string; title: string; body: string; data: Record<string, string>; priority: string; sound: string | null; badge?: number }>,
): Promise<ExpoTicket[]> {
  if (messages.length === 0) return [];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
  };
  // Optional but recommended by Expo: an access token raises rate limits and
  // is required for enhanced security mode.
  if (env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${env.EXPO_ACCESS_TOKEN}`;

  try {
    const response = await fetch(EXPO_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'expo push service rejected the batch');
      return messages.map(() => ({ status: 'error', message: `HTTP ${response.status}` }));
    }

    const payload = (await response.json()) as { data?: ExpoTicket[] };
    return payload.data ?? [];
  } catch (err) {
    logger.warn({ err }, 'expo push delivery failed');
    return messages.map(() => ({ status: 'error', message: 'delivery failed' }));
  }
}

/**
 * A token Expo says is permanently dead.
 *
 * `DeviceNotRegistered` means the app was uninstalled or the token rotated.
 * Retrying it forever wastes quota and eventually gets the project throttled,
 * so it is cleared from the device record.
 */
function isDeadToken(ticket: ExpoTicket): boolean {
  return ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered';
}

export interface NotifyResult {
  created: number;
  delivered: number;
  suppressed: number;
  failed: number;
}

/**
 * Notify users.
 *
 * The in-app notification row is always written, even when push is suppressed
 * by preferences or quiet hours. The record is the notification; the push is
 * only how the user finds out about it early. That separation is what lets
 * someone open the app at 7am and see everything from overnight.
 */
export async function notifyUsers(
  orgId: string,
  userIds: string[],
  message: PushMessage,
): Promise<NotifyResult> {
  if (userIds.length === 0) return { created: 0, delivered: 0, suppressed: 0, failed: 0 };

  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, orgId, deletedAt: null, status: 'ACTIVE' },
    select: {
      id: true,
      timezone: true,
      // Preferences ride in the same JSON column as other per-user settings.
      extraPermissions: true,
      devices: {
        where: { revokedAt: null, deletedAt: null, pushToken: { not: null } },
        select: { id: true, pushToken: true },
      },
    },
  });

  const result: NotifyResult = { created: 0, delivered: 0, suppressed: 0, failed: 0 };
  const outbound: Array<{ to: string; title: string; body: string; data: Record<string, string>; priority: string; sound: string | null }> = [];
  const tokenOwner = new Map<string, string>();

  const rows = await prisma.$transaction(
    users.map((user) =>
      prisma.notification.create({
        data: {
          id: ulid(),
          orgId,
          userId: user.id,
          topic: message.topic,
          channel: 'PUSH',
          title: message.title,
          body: message.body,
          data: (message.data ?? {}) as never,
          deepLink: message.deepLink ?? null,
        },
      }),
    ),
  );
  result.created = rows.length;

  for (const user of users) {
    const preferences = await loadPreferences(user.id);

    if (!preferences.enabled || preferences.mutedTopics.includes(message.topic)) {
      result.suppressed += 1;
      continue;
    }

    // Quiet hours never suppress a genuinely urgent topic — an inspector whose
    // device was revoked needs to know at 3am.
    const urgent = message.topic === NotificationTopic.SYNC_CONFLICT || message.priority === 'high';
    if (!urgent && inQuietHours(preferences, user.timezone)) {
      result.suppressed += 1;
      continue;
    }

    for (const device of user.devices) {
      if (!device.pushToken) continue;
      tokenOwner.set(device.pushToken, device.id);
      outbound.push({
        to: device.pushToken,
        title: message.title,
        body: message.body,
        data: {
          topic: message.topic,
          ...(message.deepLink ? { deepLink: message.deepLink } : {}),
          ...(message.data ?? {}),
        },
        priority: message.priority ?? TOPIC_PRIORITY[message.topic] ?? 'default',
        sound: preferences.sound ? 'default' : null,
      });
    }
  }

  for (let i = 0; i < outbound.length; i += BATCH_SIZE) {
    const batch = outbound.slice(i, i + BATCH_SIZE);
    const tickets = await sendToExpo(batch);

    for (const [index, ticket] of tickets.entries()) {
      const target = batch[index];
      if (!target) continue;

      if (ticket.status === 'ok') {
        result.delivered += 1;
        continue;
      }

      result.failed += 1;

      if (isDeadToken(ticket)) {
        const deviceId = tokenOwner.get(target.to);
        if (deviceId) {
          await prisma.device
            .update({ where: { id: deviceId }, data: { pushToken: null } })
            .catch(() => undefined);
          logger.info({ deviceId }, 'cleared push token for unregistered device');
        }
      }
    }
  }

  // Mark the rows we actually pushed, so the history distinguishes "sent" from
  // "queued but suppressed by preferences".
  if (result.delivered > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { deliveredAt: new Date() },
    });
  }

  return result;
}

/** Preferences for one user, merged over the defaults. */
export async function loadPreferences(userId: string): Promise<NotificationPreferences> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { locale: true, timezone: true },
  });
  void user;

  const stored = await prisma.$queryRaw<Array<{ prefs: unknown }>>`
    SELECT "notificationPreferences" AS prefs FROM users WHERE id = ${userId}
  `.catch(() => [] as Array<{ prefs: unknown }>);

  const raw = stored[0]?.prefs;
  if (!raw || typeof raw !== 'object') return DEFAULT_PREFERENCES;

  return { ...DEFAULT_PREFERENCES, ...(raw as Partial<NotificationPreferences>) };
}

export async function savePreferences(
  userId: string,
  preferences: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const current = await loadPreferences(userId);
  const merged: NotificationPreferences = { ...current, ...preferences };

  await prisma.$executeRaw`
    UPDATE users SET "notificationPreferences" = ${JSON.stringify(merged)}::jsonb WHERE id = ${userId}
  `;

  return merged;
}

// ---------------------------------------------------------------------------
// Topic helpers — one per event the system actually raises
// ---------------------------------------------------------------------------

export async function notifyInspectionAssigned(input: {
  orgId: string; assigneeId: string; inspectionId: string;
  number: string; title: string; siteName: string | null; dueAt: Date | null;
}): Promise<void> {
  await notifyUsers(input.orgId, [input.assigneeId], {
    topic: NotificationTopic.INSPECTION_ASSIGNED,
    title: 'New inspection assigned',
    // Leads with what and where, because that is what decides whether the
    // inspector needs to act now or can finish what they are doing.
    body: [input.title, input.siteName].filter(Boolean).join(' — '),
    deepLink: `orbit://inspections/${input.inspectionId}`,
    data: { inspectionId: input.inspectionId, number: input.number },
  }).catch((err) => logger.error({ err }, 'assignment notification failed'));
}

export async function notifyInspectionReviewed(input: {
  orgId: string; assigneeId: string; inspectionId: string;
  number: string; approved: boolean; reason?: string | null;
}): Promise<void> {
  await notifyUsers(input.orgId, [input.assigneeId], {
    topic: input.approved ? NotificationTopic.INSPECTION_APPROVED : NotificationTopic.INSPECTION_REJECTED,
    title: input.approved ? `${input.number} approved` : `${input.number} sent back`,
    body: input.approved
      ? 'No further action needed.'
      : (input.reason ?? 'Open the inspection to see what needs changing.'),
    deepLink: `orbit://inspections/${input.inspectionId}`,
    data: { inspectionId: input.inspectionId },
  }).catch((err) => logger.error({ err }, 'review notification failed'));
}

export async function notifyConflict(input: {
  orgId: string; userId: string; entity: string; entityId: string;
}): Promise<void> {
  await notifyUsers(input.orgId, [input.userId], {
    topic: NotificationTopic.SYNC_CONFLICT,
    title: 'A change needs your decision',
    body: 'Someone edited the same record while you were offline. Nothing has been overwritten.',
    deepLink: 'orbit://sync',
    priority: 'high',
    data: { entity: input.entity, entityId: input.entityId },
  }).catch((err) => logger.error({ err }, 'conflict notification failed'));
}

export async function notifyDeviceRevoked(input: {
  orgId: string; userId: string; deviceName: string;
}): Promise<void> {
  await notifyUsers(input.orgId, [input.userId], {
    topic: NotificationTopic.SYNC_CONFLICT,
    title: 'A device was signed out',
    body: `${input.deviceName} can no longer sync. Work already on it stays there until you sign in again.`,
    priority: 'high',
  }).catch((err) => logger.error({ err }, 'device revocation notification failed'));
}

/**
 * Due and overdue sweep.
 *
 * Run on a schedule. Deliberately notifies once per inspection per state
 * change rather than every run — an inspector who has already been told
 * something is overdue does not need telling hourly.
 */
export async function sweepDueInspections(): Promise<{ due: number; overdue: number }> {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 3_600_000);

  const dueSoon = await prisma.inspection.findMany({
    where: {
      deletedAt: null,
      assignedToId: { not: null },
      dueAt: { gte: now, lte: soon },
      status: { in: ['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'REJECTED'] },
    },
    select: { id: true, orgId: true, number: true, title: true, assignedToId: true, dueAt: true },
    take: 500,
  });

  const overdue = await prisma.inspection.findMany({
    where: {
      deletedAt: null,
      assignedToId: { not: null },
      dueAt: { lt: now },
      status: { in: ['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'REJECTED'] },
    },
    select: { id: true, orgId: true, number: true, title: true, assignedToId: true, dueAt: true },
    take: 500,
  });

  /** Suppress a repeat if the same topic was raised for this record recently. */
  const alreadyNotified = async (userId: string, inspectionId: string, topic: string): Promise<boolean> => {
    const since = new Date(Date.now() - 20 * 3_600_000);
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        topic,
        createdAt: { gte: since },
        data: { path: ['inspectionId'], equals: inspectionId },
      },
      select: { id: true },
    });
    return existing !== null;
  };

  let dueCount = 0;
  for (const inspection of dueSoon) {
    if (!inspection.assignedToId) continue;
    if (await alreadyNotified(inspection.assignedToId, inspection.id, NotificationTopic.INSPECTION_DUE)) continue;

    await notifyUsers(inspection.orgId, [inspection.assignedToId], {
      topic: NotificationTopic.INSPECTION_DUE,
      title: 'Due within 24 hours',
      body: `${inspection.number} — ${inspection.title}`,
      deepLink: `orbit://inspections/${inspection.id}`,
      data: { inspectionId: inspection.id },
    });
    dueCount += 1;
  }

  let overdueCount = 0;
  for (const inspection of overdue) {
    if (!inspection.assignedToId) continue;
    if (await alreadyNotified(inspection.assignedToId, inspection.id, NotificationTopic.INSPECTION_OVERDUE)) continue;

    await notifyUsers(inspection.orgId, [inspection.assignedToId], {
      topic: NotificationTopic.INSPECTION_OVERDUE,
      title: 'Inspection overdue',
      body: `${inspection.number} — ${inspection.title}`,
      deepLink: `orbit://inspections/${inspection.id}`,
      priority: 'high',
      data: { inspectionId: inspection.id },
    });
    overdueCount += 1;
  }

  return { due: dueCount, overdue: overdueCount };
}

export { NotificationTopic };
