/**
 * Push and local notifications on the device.
 *
 * Two kinds, both used:
 *
 *  - **Remote** — the server telling the inspector something they could not
 *    know locally: new work assigned, their submission reviewed, a conflict
 *    raised by somebody else's edit.
 *  - **Local** — the device telling them something it discovered itself: an
 *    upload that has now failed too many times, a sync that finished draining a
 *    week's backlog. These need no server round trip and must work offline,
 *    which is exactly when they matter.
 *
 * Permission is requested at the moment a notification would first be useful,
 * not on first launch. Asking before the user has seen any value is how apps
 * get permanently denied.
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type { NotificationTopic } from '@orbit/types';
import { storage } from '../../lib/storage';

const PERMISSION_ASKED_KEY = 'notifications.permissionAsked';

/**
 * Foreground presentation.
 *
 * Shown even while the app is open. An inspector mid-checklist who is assigned
 * an urgent job needs to see it; suppressing in-foreground notifications is a
 * default that makes sense for chat apps and not for this.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export type PermissionOutcome = 'GRANTED' | 'DENIED' | 'BLOCKED' | 'UNSUPPORTED';

export interface NotificationState {
  permission: PermissionOutcome;
  pushToken: string | null;
  /** False on a simulator, where remote push is not available at all. */
  supportsPush: boolean;
}

/**
 * Android notification channels.
 *
 * Android routes every notification through a channel, and the channel — not
 * the payload — owns importance, sound, and vibration. Creating them up front
 * means the user can tune categories individually in system settings, which is
 * the behaviour Android users expect.
 */
async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  await Notifications.setNotificationChannelAsync('urgent', {
    name: 'Urgent',
    description: 'Conflicts and overdue work that block your queue.',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  await Notifications.setNotificationChannelAsync('work', {
    name: 'Work assignments',
    description: 'New inspections assigned to you and review decisions.',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200],
  });

  await Notifications.setNotificationChannelAsync('sync', {
    name: 'Sync and uploads',
    description: 'Background sync results and failed uploads.',
    // Low by design: these are informational, and an inspector does not want a
    // buzz every time a photo finishes uploading.
    importance: Notifications.AndroidImportance.LOW,
    vibrationPattern: [0],
  });
}

/** Current permission state without prompting. */
export async function notificationState(): Promise<NotificationState> {
  const supportsPush = Device.isDevice;

  try {
    const settings = await Notifications.getPermissionsAsync();
    const permission: PermissionOutcome = settings.granted
      ? 'GRANTED'
      : settings.canAskAgain
        ? 'DENIED'
        : 'BLOCKED';

    return { permission, pushToken: null, supportsPush };
  } catch {
    return { permission: 'UNSUPPORTED', pushToken: null, supportsPush: false };
  }
}

/**
 * Request permission and obtain a push token.
 *
 * Returns the token so the caller can register it with the server. A null token
 * with GRANTED permission is normal on a simulator — local notifications still
 * work there, remote ones do not.
 */
export async function enableNotifications(): Promise<NotificationState> {
  await ensureChannels();

  const supportsPush = Device.isDevice;

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;

  if (!granted && existing.canAskAgain) {
    storage.set(PERMISSION_ASKED_KEY, true);
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
        // Not requested: provisional delivery arrives silently, and an urgent
        // assignment that makes no sound is worse than no notification.
        allowProvisional: false,
      },
    });
    granted = requested.granted;
  }

  if (!granted) {
    return {
      permission: existing.canAskAgain ? 'DENIED' : 'BLOCKED',
      pushToken: null,
      supportsPush,
    };
  }

  if (!supportsPush) {
    // Simulators cannot receive remote push. Local notifications still work, so
    // this is not a failure — just no token to register.
    return { permission: 'GRANTED', pushToken: null, supportsPush: false };
  }

  try {
    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
      Constants.easConfig?.projectId;

    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );

    return { permission: 'GRANTED', pushToken: token.data, supportsPush: true };
  } catch (err) {
    // A token fetch failure (no network, misconfigured project) must not read
    // as a permission problem — the user granted it, the plumbing failed.
    console.warn('[notifications] could not obtain a push token', err);
    return { permission: 'GRANTED', pushToken: null, supportsPush: true };
  }
}

/** Whether we have already asked once, so the UI can offer a settings link instead. */
export function hasAskedPermission(): boolean {
  return storage.getBoolean(PERMISSION_ASKED_KEY) ?? false;
}

// ---------------------------------------------------------------------------
// Local notifications
// ---------------------------------------------------------------------------

const CHANNEL_FOR_TOPIC: Record<string, string> = {
  SYNC_CONFLICT: 'urgent',
  INSPECTION_OVERDUE: 'urgent',
  INSPECTION_ASSIGNED: 'work',
  INSPECTION_DUE: 'work',
  INSPECTION_APPROVED: 'work',
  INSPECTION_REJECTED: 'work',
  SYNC_COMPLETED: 'sync',
  UPLOAD_FAILED: 'sync',
  REPORT_READY: 'sync',
};

export interface LocalNotification {
  topic: NotificationTopic | string;
  title: string;
  body: string;
  data?: Record<string, string>;
  /** Seconds from now. Omit to show immediately. */
  delaySeconds?: number;
}

/**
 * Raise a notification from the device itself.
 *
 * Used for things only the device knows: an upload that has exhausted its
 * retries, a background sync that resolved a backlog. These work with no
 * connectivity at all, which is the point.
 */
export async function notifyLocally(notification: LocalNotification): Promise<string | null> {
  try {
    const settings = await Notifications.getPermissionsAsync();
    if (!settings.granted) return null;

    return await Notifications.scheduleNotificationAsync({
      content: {
        title: notification.title,
        body: notification.body,
        data: { topic: notification.topic, ...(notification.data ?? {}) },
        sound: CHANNEL_FOR_TOPIC[notification.topic] === 'sync' ? undefined : 'default',
        ...(Platform.OS === 'android'
          ? { channelId: CHANNEL_FOR_TOPIC[notification.topic] ?? 'work' }
          : {}),
      },
      trigger:
        notification.delaySeconds && notification.delaySeconds > 0
          ? {
              type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: notification.delaySeconds,
            }
          : null,
    });
  } catch (err) {
    console.warn('[notifications] local notification failed', err);
    return null;
  }
}

/** Cancel a scheduled notification, e.g. a reminder for work now submitted. */
export async function cancelNotification(id: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
}

/**
 * App icon badge.
 *
 * Set from the server's unread count rather than incremented locally, so the
 * badge agrees with the inbox across every device the user owns.
 */
export async function setBadgeCount(count: number): Promise<void> {
  await Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

export interface NotificationTap {
  topic: string;
  deepLink: string | null;
  data: Record<string, unknown>;
}

/**
 * Subscribe to notification taps.
 *
 * Covers both the running app and a cold start from a tapped notification —
 * the second case is easy to miss, and produces an app that opens to the
 * dashboard instead of the inspection the user tapped.
 */
export function onNotificationTap(handler: (tap: NotificationTap) => void): () => void {
  const extract = (response: Notifications.NotificationResponse): NotificationTap => {
    const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
    return {
      topic: String(data.topic ?? 'UNKNOWN'),
      deepLink: typeof data.deepLink === 'string' ? data.deepLink : null,
      data,
    };
  };

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    handler(extract(response));
  });

  // The notification that launched the app from cold, if any.
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    if (response) handler(extract(response));
  });

  return () => subscription.remove();
}

/** Subscribe to notifications arriving while the app is open. */
export function onNotificationReceived(
  handler: (topic: string, data: Record<string, unknown>) => void,
): () => void {
  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    const data = (notification.request.content.data ?? {}) as Record<string, unknown>;
    handler(String(data.topic ?? 'UNKNOWN'), data);
  });
  return () => subscription.remove();
}

/** Clear delivered notifications, e.g. after the user reads the inbox. */
export async function dismissAll(): Promise<void> {
  await Notifications.dismissAllNotificationsAsync().catch(() => undefined);
  await setBadgeCount(0);
}
