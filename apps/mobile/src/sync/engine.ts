/**
 * Client synchronisation engine.
 *
 * A sync run is three ordered phases:
 *
 *   PUSH  — drain the outbox. Local intent goes first, so a pull can never
 *           clobber an edit the user has made but not yet sent.
 *   PULL  — apply the server's delta. Rows with pending local changes are not
 *           overwritten; they are left for the conflict path.
 *   MEDIA — upload queued binaries, resumably, subject to the metered-network
 *           policy.
 *
 * The run is idempotent and interruptible at every step. If the app is killed
 * mid-phase, the next run continues from durable state — nothing lives only in
 * memory.
 */

import {
  OutboxState,
  SYNC_PROTOCOL_VERSION,
  SyncEntity,
  SyncOperation,
  type SyncChange,
  type SyncConflict,
  type SyncOperationResult,
  type SyncPullResponse,
  type SyncPushResponse,
  type SyncStatus,
} from '@orbit/types';
import { isRetryableCode, retryAfterMs, ulid } from '@orbit/utils';
import type { Database } from '../db/database';
import { META_KEYS } from '../db/database';
import { Outbox } from './outbox';
import { applyChange } from './apply-change';

export type SyncTrigger =
  | 'MANUAL'
  | 'INTERVAL'
  | 'CONNECTIVITY'
  | 'BACKGROUND'
  | 'STARTUP'
  | 'PUSH_NOTIFICATION';

export interface NetworkState {
  isConnected: boolean;
  /** True on cellular or a hotspot — media sync may be deferred. */
  isMetered: boolean;
}

export interface SyncTransport {
  push(body: unknown): Promise<SyncPushResponse>;
  pull(params: { since: number; limit: number }): Promise<SyncPullResponse>;
}

export interface MediaUploader {
  /** Returns the number of attachments fully uploaded in this pass. */
  uploadPending(options: { metered: boolean; signal: AbortSignal }): Promise<number>;
  pendingCount(): number;
}

export interface EngineOptions {
  db: Database;
  transport: SyncTransport;
  uploader: MediaUploader;
  outbox: Outbox;
  getNetwork: () => NetworkState;
  /** Org policy: hold media until an unmetered connection is available. */
  wifiOnlyMedia: () => boolean;
  pushBatchSize?: number;
  pullPageSize?: number;
  onStatusChange?: (status: SyncStatus) => void;
  onConflict?: (conflict: SyncConflict) => void;
}

export class SyncEngine {
  private running = false;
  private abortController: AbortController | null = null;
  private status: SyncStatus;

  private readonly pushBatchSize: number;
  private readonly pullPageSize: number;

  constructor(private readonly options: EngineOptions) {
    this.pushBatchSize = options.pushBatchSize ?? 100;
    this.pullPageSize = options.pullPageSize ?? 500;
    this.status = this.buildStatus('IDLE');
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  private buildStatus(state: SyncStatus['state'], patch: Partial<SyncStatus> = {}): SyncStatus {
    const counts = this.options.outbox.counts();
    const network = this.options.getNetwork();
    return {
      state,
      isOnline: network.isConnected,
      isMetered: network.isMetered,
      cursor: this.options.db.getCursor() as SyncStatus['cursor'],
      lastSuccessfulSyncAt: this.options.db.getMeta(META_KEYS.LAST_SYNC_AT) as SyncStatus['lastSuccessfulSyncAt'],
      lastAttemptAt: null,
      pendingOperations: counts.pending + counts.retrying,
      inFlightOperations: counts.inFlight,
      failedOperations: counts.deadLetter,
      conflictedOperations: counts.conflicted,
      pendingUploads: this.options.uploader.pendingCount(),
      uploadedBytes: 0,
      totalUploadBytes: 0,
      progress: null,
      currentPhase: null,
      lastError: null,
      ...patch,
    };
  }

  private emit(state: SyncStatus['state'], patch: Partial<SyncStatus> = {}): void {
    this.status = this.buildStatus(state, patch);
    this.options.onStatusChange?.(this.status);
  }

  /** Cancel an in-flight run, e.g. when the user backgrounds the app. */
  abort(): void {
    this.abortController?.abort();
  }

  /**
   * Run one full cycle.
   *
   * Returns without doing anything if a run is already active — overlapping
   * runs would push the same operations twice and race on the cursor.
   */
  async sync(trigger: SyncTrigger): Promise<SyncStatus> {
    if (this.running) return this.status;

    const network = this.options.getNetwork();
    if (!network.isConnected) {
      this.emit('OFFLINE');
      return this.status;
    }

    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const logId = ulid();
    const startedAt = Date.now();
    this.options.db.run(
      `INSERT INTO sync_log (id, started_at, trigger) VALUES (?, ?, ?)`,
      [logId, new Date(startedAt).toISOString(), trigger],
    );

    let pushed = 0;
    let pulled = 0;
    let conflicts = 0;
    let uploaded = 0;
    let error: string | null = null;

    try {
      // Recover anything the last run left mid-flight before queueing more.
      this.options.outbox.recoverInFlight();

      this.emit('SYNCING', { currentPhase: 'PUSH', progress: 0 });
      const pushResult = await this.pushPhase(signal);
      pushed = pushResult.applied;
      conflicts = pushResult.conflicts;

      if (signal.aborted) throw new Error('aborted');

      this.emit('SYNCING', { currentPhase: 'PULL', progress: 0.4 });
      pulled = await this.pullPhase(signal);

      if (signal.aborted) throw new Error('aborted');

      const shouldUploadMedia = !network.isMetered || !this.options.wifiOnlyMedia();
      if (shouldUploadMedia) {
        this.emit('SYNCING', { currentPhase: 'MEDIA', progress: 0.75 });
        uploaded = await this.options.uploader.uploadPending({
          metered: network.isMetered,
          signal,
        });
      }

      this.options.db.setMeta(META_KEYS.LAST_SYNC_AT, new Date().toISOString());
      this.emit(conflicts > 0 ? 'ERROR' : 'IDLE', {
        currentPhase: null,
        progress: 1,
        lastError: conflicts > 0 ? `${conflicts} change${conflicts === 1 ? '' : 's'} need your attention.` : null,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.emit(error === 'aborted' ? 'PAUSED' : 'ERROR', {
        currentPhase: null,
        lastError: error === 'aborted' ? null : error,
      });
    } finally {
      this.options.db.run(
        `UPDATE sync_log
            SET finished_at = ?, pushed_count = ?, pulled_count = ?, conflict_count = ?,
                uploaded_count = ?, duration_ms = ?, outcome = ?, error = ?
          WHERE id = ?`,
        [
          new Date().toISOString(),
          pushed,
          pulled,
          conflicts,
          uploaded,
          Date.now() - startedAt,
          error === null ? (conflicts > 0 ? 'PARTIAL' : 'SUCCESS') : error === 'aborted' ? 'ABORTED' : 'FAILED',
          error,
          logId,
        ],
      );
      this.running = false;
      this.abortController = null;
    }

    return this.status;
  }

  /** Drain the outbox in Lamport-ordered batches until nothing is due. */
  private async pushPhase(signal: AbortSignal): Promise<{ applied: number; conflicts: number }> {
    let applied = 0;
    let conflicts = 0;

    for (;;) {
      if (signal.aborted) break;

      const batch = this.options.outbox.claimBatch(this.pushBatchSize);
      if (batch.length === 0) break;

      const ids = batch.map((e) => e.id);
      this.options.outbox.markInFlight(ids);

      let response: SyncPushResponse;
      try {
        response = await this.options.transport.push({
          protocolVersion: SYNC_PROTOCOL_VERSION,
          deviceId: this.options.db.getMeta(META_KEYS.DEVICE_ID),
          cursor: this.options.db.getCursor(),
          operations: this.options.outbox.toEnvelopes(batch),
        });
      } catch (err) {
        // Transport failure: the whole batch returns to pending with backoff.
        // Marking each entry individually keeps their attempt counters honest.
        const message = err instanceof Error ? err.message : String(err);
        const after = err instanceof Object && 'retryAfter' in err
          ? retryAfterMs(String((err as { retryAfter?: string }).retryAfter))
          : null;
        for (const entry of batch) {
          this.options.outbox.markRetry(entry.id, message, 'NETWORK_ERROR', after ?? undefined);
        }
        throw err;
      }

      for (const result of response.results) {
        const handled = this.handleResult(result);
        if (handled === 'APPLIED') applied += 1;
        if (handled === 'CONFLICT') conflicts += 1;
      }

      if (response.cursor > this.options.db.getCursor()) {
        // Do not adopt the server's cursor here: our own writes advanced it, but
        // we have not yet pulled the changes between our old cursor and this
        // one. Adopting it would skip other devices' changes permanently.
      }

      // A short batch means the queue is drained for now.
      if (batch.length < this.pushBatchSize) break;
    }

    return { applied, conflicts };
  }

  /** Apply one operation result to local state. */
  private handleResult(result: SyncOperationResult): SyncOperationResult['status'] {
    const db = this.options.db;

    switch (result.status) {
      case 'APPLIED':
      case 'DUPLICATE': {
        db.write(() => {
          this.options.outbox.markApplied(result.operationId);
          if (result.entityId && result.version !== undefined) {
            // The row is now in sync: clear the dirty flag and record the
            // acknowledged version as the new merge ancestor.
            for (const table of ['inspections', 'inspection_responses', 'attachments', 'signatures', 'assets']) {
              db.run(
                `UPDATE ${table}
                    SET version = ?, sync_cursor = ?, is_dirty = 0,
                        base_snapshot = NULL
                  WHERE id = ? AND is_dirty = 1`,
                [result.version!, result.syncCursor ?? 0, result.entityId!],
              );
            }
          }
        });
        return result.status;
      }

      case 'CONFLICT': {
        const conflict = result.conflict!;
        db.write(() => {
          db.run(
            `INSERT INTO conflicts
               (operation_id, entity, entity_id, base_version, server_version,
                local_record, server_record, diffs, is_auto_resolvable,
                server_updated_at, server_updated_by, detected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(operation_id) DO UPDATE SET
               server_version = excluded.server_version,
               server_record  = excluded.server_record,
               diffs          = excluded.diffs,
               detected_at    = excluded.detected_at`,
            [
              conflict.operationId,
              conflict.entity,
              conflict.entityId,
              conflict.baseVersion,
              conflict.serverVersion,
              JSON.stringify(conflict.localRecord),
              JSON.stringify(conflict.serverRecord),
              JSON.stringify(conflict.diffs),
              conflict.isAutoResolvable ? 1 : 0,
              conflict.serverUpdatedAt,
              conflict.serverUpdatedByName,
              conflict.detectedAt,
            ],
          );
          this.options.outbox.markConflicted(result.operationId, conflict.entityId);
        });
        this.options.onConflict?.(conflict);
        return 'CONFLICT';
      }

      case 'REJECTED':
        // Permanent: validation or permission. The user must intervene, so the
        // entry is dead-lettered and surfaced rather than retried forever.
        this.options.outbox.markDeadLetter(
          result.operationId,
          result.errorMessage ?? 'The change was rejected by the server.',
          result.errorCode ?? null,
        );
        return 'REJECTED';

      case 'RETRY':
      case 'SKIPPED_DEPENDENCY':
        this.options.outbox.markRetry(
          result.operationId,
          result.errorMessage ?? 'Temporarily unavailable.',
          result.errorCode ?? null,
        );
        return result.status;

      default:
        return result.status;
    }
  }

  /** Page through the delta until the server says there is no more. */
  private async pullPhase(signal: AbortSignal): Promise<number> {
    let total = 0;

    for (;;) {
      if (signal.aborted) break;

      const since = this.options.db.getCursor();
      const response = await this.options.transport.pull({ since, limit: this.pullPageSize });

      if (response.requiresFullResync) {
        // The device has been offline longer than the server's change-log
        // retention. Local server-state is discarded, but unsent work is kept.
        this.options.db.resetForFullResync();
        continue;
      }

      if (response.changes.length === 0) {
        this.options.db.setCursor(response.cursor);
        break;
      }

      // One transaction per page: a page either lands whole or not at all, so
      // the cursor and the rows it covers can never disagree.
      this.options.db.write(() => {
        for (const change of response.changes) {
          this.applyPulledChange(change);
        }
        this.options.db.setCursor(response.cursor);
      });

      total += response.changes.length;
      this.emit('SYNCING', { currentPhase: 'PULL' });

      if (!response.hasMore) break;
    }

    return total;
  }

  /**
   * Apply one server change.
   *
   * The critical guard: a row with unsent local edits is not overwritten. The
   * user's work stays on screen, and the divergence is resolved through the
   * conflict path when their operation is pushed.
   */
  private applyPulledChange(change: SyncChange): void {
    const db = this.options.db;

    if (change.operation === SyncOperation.DELETE) {
      applyChange.remove(db, change.entity, change.entityId);
      return;
    }

    const table = applyChange.tableFor(change.entity);
    if (!table || !change.data) return;

    const local = db.getFirst<{ is_dirty: number; version: number }>(
      `SELECT is_dirty, version FROM ${table} WHERE id = ?`,
      [change.entityId],
    );

    if (local?.is_dirty === 1) {
      // Store the server's version as the merge ancestor for the eventual
      // three-way diff, but leave the visible row alone.
      db.run(`UPDATE ${table} SET base_snapshot = ? WHERE id = ?`, [
        JSON.stringify(change.data),
        change.entityId,
      ]);
      return;
    }

    applyChange.upsert(db, change.entity, change.entityId, change.data, change.version, change.syncCursor);
  }
}

export { OutboxState, SyncEntity, isRetryableCode };
