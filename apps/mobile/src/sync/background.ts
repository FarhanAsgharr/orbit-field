/**
 * Background synchronisation.
 *
 * The requirement this exists to meet: an inspector finishes a job in a
 * basement, puts the phone in their pocket, drives home, and the work is on the
 * server before they get there — without opening the app.
 *
 * Both platforms give the same shape of guarantee and neither gives a strong
 * one. iOS `BGTaskScheduler` runs when *it* decides, weighted by usage patterns
 * and charge state; Android `WorkManager` (which `expo-background-fetch` wraps)
 * honours constraints but batches aggressively in Doze. So the design assumes
 * every run is a bonus, never a promise:
 *
 *  - The durable outbox is the source of truth. A background run that never
 *    fires costs latency, never data.
 *  - Every run is bounded. iOS terminates a task that overruns its window and
 *    penalises future scheduling, so the engine is given a hard budget and told
 *    to stop cleanly rather than being killed mid-push.
 *  - Registration is idempotent and re-asserted on every cold start, because a
 *    device reboot clears iOS's scheduled tasks entirely.
 */

import { ulid } from '@orbit/utils';
import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { AppState, type AppStateStatus } from 'react-native';

import { getDatabase } from '../db/database';
import { META_KEYS } from '../db/schema';
import { getNetworkState, onNetworkChange } from '../lib/network';
import { storage, STORAGE_KEYS } from '../lib/storage';
import type { SyncEngine, SyncTrigger } from './engine';

export const BACKGROUND_SYNC_TASK = 'orbit-background-sync';

/**
 * How long a background run may take before it stops volunteering more work.
 *
 * iOS allows roughly 30s for a `BGAppRefreshTask`. Overrunning gets the task
 * killed and the app's future scheduling priority reduced, so we stop well
 * short and let the next run continue — the outbox makes that free.
 */
const RUN_BUDGET_MS = 25_000;

/** Minimum gap between OS-initiated runs. The OS may ignore this upwards. */
const MIN_INTERVAL_SECONDS = 15 * 60;

const META_LAST_BACKGROUND_RUN = 'background.lastRunAt';
const META_REGISTERED_AT = 'background.registeredAt';

/**
 * The engine is owned by the React tree, which does not exist when a background
 * task fires. A module-level handle is the only way the task can reach it.
 */
let engineHandle: SyncEngine | null = null;

export function attachEngine(engine: SyncEngine): void {
  engineHandle = engine;
}

export function detachEngine(): void {
  engineHandle = null;
}

export interface BackgroundRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: SyncTrigger;
  outcome: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED' | 'NO_WORK';
  pushed: number;
  pulled: number;
  uploaded: number;
  durationMs: number | null;
  reason: string | null;
}

/**
 * Record a background attempt.
 *
 * Written to the existing `sync_log` table rather than a new one: field support
 * already looks there, and a separate table would mean two places to check when
 * somebody reports that syncing stopped overnight.
 */
async function recordRun(record: Omit<BackgroundRunRecord, 'id'>): Promise<void> {
  try {
    const db = await getDatabase();
    db.run(
      `INSERT INTO sync_log
         (id, started_at, finished_at, trigger, pushed_count, pulled_count,
          conflict_count, uploaded_count, bytes_up, bytes_down, duration_ms, outcome, error)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?)`,
      [
        ulid(),
        record.startedAt,
        record.finishedAt,
        record.trigger,
        record.pushed,
        record.pulled,
        record.uploaded,
        record.durationMs,
        record.outcome,
        record.reason,
      ],
    );
    db.setMeta(META_LAST_BACKGROUND_RUN, record.startedAt);
  } catch {
    // Logging a run must never be the reason a run fails.
  }
}

/** Is there anything worth waking up for? */
async function hasPendingWork(): Promise<{
  pending: boolean;
  operations: number;
  uploads: number;
}> {
  try {
    const db = await getDatabase();
    const ops = db.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outbox WHERE state IN ('PENDING','RETRYING','IN_FLIGHT')`,
    );
    const uploads = db.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments
        WHERE deleted_at IS NULL AND state IN ('QUEUED','UPLOADING','FAILED') AND local_uri IS NOT NULL`,
    );
    const operations = ops?.n ?? 0;
    const pendingUploads = uploads?.n ?? 0;
    return { pending: operations > 0 || pendingUploads > 0, operations, uploads: pendingUploads };
  } catch {
    // If we cannot tell, assume there is work. A wasted run is cheaper than a
    // skipped one that strands a day of inspections.
    return { pending: true, operations: 0, uploads: 0 };
  }
}

/**
 * The task body.
 *
 * Defined at module scope, not inside a component: `TaskManager` requires the
 * definition to be registered during the initial JS evaluation, because the OS
 * may launch the app directly into a background task with no UI at all.
 */
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const finish = async (
    outcome: BackgroundRunRecord['outcome'],
    counts: { pushed: number; pulled: number; uploaded: number },
    reason: string | null,
  ): Promise<BackgroundFetch.BackgroundFetchResult> => {
    await recordRun({
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger: 'BACKGROUND',
      outcome,
      pushed: counts.pushed,
      pulled: counts.pulled,
      uploaded: counts.uploaded,
      durationMs: Date.now() - start,
      reason,
    });

    if (outcome === 'FAILED') return BackgroundFetch.BackgroundFetchResult.Failed;
    if (outcome === 'NO_WORK' || outcome === 'SKIPPED') {
      // Reporting NoData when there was nothing to do is what keeps iOS
      // willing to schedule us again; claiming NewData every time trains it to
      // deprioritise the app.
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }
    return BackgroundFetch.BackgroundFetchResult.NewData;
  };

  const empty = { pushed: 0, pulled: 0, uploaded: 0 };

  try {
    if (!(storage.getBoolean(STORAGE_KEYS.SYNC_AUTO) ?? true)) {
      return finish('SKIPPED', empty, 'Automatic sync is switched off.');
    }

    const network = getNetworkState();
    if (!network.isConnected) {
      return finish('SKIPPED', empty, 'No connection.');
    }

    const work = await hasPendingWork();
    if (!work.pending) {
      // Still pull: another inspector may have been assigned work to this
      // device, which the outbox knows nothing about.
      if (!engineHandle) return finish('NO_WORK', empty, 'Nothing queued.');
    }

    if (!engineHandle) {
      // The OS launched us with no JS session holding an engine — most often a
      // cold background start before the app has ever been opened since boot.
      // Nothing is lost; the next foreground launch drains the queue.
      return finish('SKIPPED', empty, 'No active session on this device.');
    }

    // Hard budget. The engine checks its abort signal between operations, so it
    // stops cleanly at a transaction boundary rather than being killed.
    const timeout = setTimeout(() => engineHandle?.abort(), RUN_BUDGET_MS);

    try {
      const status = await engineHandle.sync('BACKGROUND');
      clearTimeout(timeout);

      const counts = {
        pushed:
          status.pendingOperations === 0
            ? work.operations
            : work.operations - status.pendingOperations,
        pulled: 0,
        uploaded: work.uploads - status.pendingUploads,
      };

      if (status.state === 'ERROR') {
        return finish('PARTIAL', counts, status.lastError ?? 'Sync reported an error.');
      }
      if (status.conflictedOperations > 0) {
        return finish(
          'PARTIAL',
          counts,
          `${status.conflictedOperations} change(s) need a decision.`,
        );
      }
      return finish('SUCCESS', counts, null);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    return finish('FAILED', empty, err instanceof Error ? err.message : String(err));
  }
});

export type BackgroundStatus = 'AVAILABLE' | 'DENIED' | 'RESTRICTED' | 'UNSUPPORTED';

export interface BackgroundState {
  registered: boolean;
  status: BackgroundStatus;
  lastRunAt: string | null;
  registeredAt: string | null;
  /** Human-readable explanation when background sync cannot run. */
  reason: string | null;
}

function translateStatus(status: BackgroundFetch.BackgroundFetchStatus | null): BackgroundStatus {
  switch (status) {
    case BackgroundFetch.BackgroundFetchStatus.Available:
      return 'AVAILABLE';
    case BackgroundFetch.BackgroundFetchStatus.Denied:
      return 'DENIED';
    case BackgroundFetch.BackgroundFetchStatus.Restricted:
      return 'RESTRICTED';
    default:
      return 'UNSUPPORTED';
  }
}

/**
 * Register the background task.
 *
 * Idempotent and called on every cold start, not only on first launch: a device
 * reboot clears iOS's pending task registrations entirely, and Android may drop
 * them when the app is force-stopped. Re-asserting costs nothing and is the only
 * thing that makes "survives a reboot" true rather than aspirational.
 */
export async function registerBackgroundSync(): Promise<BackgroundState> {
  const db = await getDatabase().catch(() => null);

  try {
    const status = translateStatus(await BackgroundFetch.getStatusAsync());

    if (status !== 'AVAILABLE') {
      return {
        registered: false,
        status,
        lastRunAt: db?.getMeta(META_LAST_BACKGROUND_RUN) ?? null,
        registeredAt: db?.getMeta(META_REGISTERED_AT) ?? null,
        reason:
          status === 'DENIED'
            ? 'Background App Refresh is switched off for Orbit Field. Your work syncs whenever you open the app.'
            : status === 'RESTRICTED'
              ? 'Background activity is restricted on this device, often by battery saver or a device policy.'
              : 'This device does not support background syncing.',
      };
    }

    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);

    if (!alreadyRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
        minimumInterval: MIN_INTERVAL_SECONDS,
        // Both matter for the reboot requirement: without them the task is
        // gone the moment the device restarts or the user swipes the app away.
        stopOnTerminate: false,
        startOnBoot: true,
      });
      db?.setMeta(META_REGISTERED_AT, new Date().toISOString());
    }

    return {
      registered: true,
      status,
      lastRunAt: db?.getMeta(META_LAST_BACKGROUND_RUN) ?? null,
      registeredAt: db?.getMeta(META_REGISTERED_AT) ?? null,
      reason: null,
    };
  } catch (err) {
    return {
      registered: false,
      status: 'UNSUPPORTED',
      lastRunAt: db?.getMeta(META_LAST_BACKGROUND_RUN) ?? null,
      registeredAt: null,
      reason: err instanceof Error ? err.message : 'Background sync could not be registered.',
    };
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
      await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
    }
  } catch {
    // Already gone is the desired end state.
  }
}

export async function backgroundState(): Promise<BackgroundState> {
  const db = await getDatabase().catch(() => null);
  try {
    const status = translateStatus(await BackgroundFetch.getStatusAsync());
    return {
      registered: await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK),
      status,
      lastRunAt: db?.getMeta(META_LAST_BACKGROUND_RUN) ?? null,
      registeredAt: db?.getMeta(META_REGISTERED_AT) ?? null,
      reason: null,
    };
  } catch {
    return {
      registered: false,
      status: 'UNSUPPORTED',
      lastRunAt: null,
      registeredAt: null,
      reason: null,
    };
  }
}

/** Recent background attempts, for the sync screen's diagnostics. */
export async function backgroundRunHistory(limit = 20): Promise<BackgroundRunRecord[]> {
  const db = await getDatabase();
  return db
    .getAll<{
      id: string;
      started_at: string;
      finished_at: string | null;
      trigger: string;
      pushed_count: number;
      pulled_count: number;
      uploaded_count: number;
      duration_ms: number | null;
      outcome: string | null;
      error: string | null;
    }>(`SELECT * FROM sync_log WHERE trigger = 'BACKGROUND' ORDER BY started_at DESC LIMIT ?`, [
      limit,
    ])
    .map((row) => ({
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      trigger: 'BACKGROUND' as SyncTrigger,
      outcome: (row.outcome ?? 'FAILED') as BackgroundRunRecord['outcome'],
      pushed: row.pushed_count,
      pulled: row.pulled_count,
      uploaded: row.uploaded_count,
      durationMs: row.duration_ms,
      reason: row.error,
    }));
}

/**
 * Foreground triggers.
 *
 * Background scheduling is best-effort, so the app also syncs on the two events
 * that actually correlate with an inspector finishing work: regaining a
 * connection, and bringing the app back to the foreground. These are what make
 * sync feel immediate; the OS task is the safety net for when the app is never
 * opened at all.
 */
export function startForegroundTriggers(engine: SyncEngine): () => void {
  let lastRun = 0;

  // Guards against a flapping connection triggering a sync per transition.
  const COOLDOWN_MS = 20_000;

  const maybeSync = (trigger: SyncTrigger): void => {
    if (!(storage.getBoolean(STORAGE_KEYS.SYNC_AUTO) ?? true)) return;
    if (Date.now() - lastRun < COOLDOWN_MS) return;
    if (!getNetworkState().isConnected) return;
    lastRun = Date.now();
    void engine.sync(trigger);
  };

  const stopNetwork = onNetworkChange((state) => {
    if (state.isConnected) maybeSync('CONNECTIVITY');
  });

  const handleAppState = (next: AppStateStatus): void => {
    if (next === 'active') maybeSync('STARTUP');
  };
  const subscription = AppState.addEventListener('change', handleAppState);

  return () => {
    stopNetwork();
    subscription.remove();
  };
}

/**
 * Recover work stranded by a crash or force-quit.
 *
 * Called on every cold start, before the first sync. Two things need it:
 * outbox rows left IN_FLIGHT when the process died, and attachments left
 * UPLOADING with a half-finished chunk session.
 */
export async function recoverInterruptedWork(): Promise<{ operations: number; uploads: number }> {
  const db = await getDatabase();

  return db.write(() => {
    const operations = db.run(
      `UPDATE outbox SET state = 'PENDING', updated_at = ?
        WHERE state = 'IN_FLIGHT'`,
      [new Date().toISOString()],
    ).changes;

    // An upload interrupted mid-transfer keeps its chunk progress — the server
    // is asked what it actually holds on resume — but must leave UPLOADING or
    // the uploader will not pick it up again.
    const uploads = db.run(
      `UPDATE attachments SET state = 'QUEUED', updated_at = ?
        WHERE state IN ('UPLOADING','FINALIZING') AND local_uri IS NOT NULL`,
      [new Date().toISOString()],
    ).changes;

    return { operations, uploads };
  });
}

export { META_KEYS };
