/**
 * The outbox.
 *
 * Every mutation the user makes is written here in the same SQLite transaction
 * that updates the visible row. That single fact is what makes the "no data is
 * ever lost" claim true rather than aspirational: the UI cannot show a change
 * that is not already durably queued, and the queue cannot lose an entry that
 * the UI has shown.
 *
 * Entries leave only on an explicit server acknowledgement.
 */

import {
  type JsonValue,
  type OutboxEntry,
  OutboxState,
  SyncEntity,
  SyncOperation,
  type SyncOperationEnvelope,
} from '@orbit/types';
import { backoffDelay, DEFAULT_BACKOFF, ulid } from '@orbit/utils';

import type { Database, SqlValue } from '../db/database';

export interface EnqueueInput {
  entity: SyncEntity;
  operation: SyncOperation;
  entityId: string;
  patch: Record<string, JsonValue>;
  baseVersion: number | null;
  dependsOn?: string[];
}

interface OutboxRow {
  id: string;
  entity: string;
  operation: string;
  entity_id: string;
  patch: string;
  base_version: number | null;
  depends_on: string;
  client_timestamp: string;
  lamport: number;
  device_id: string;
  user_id: string;
  state: string;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}

function toEntry(row: OutboxRow): OutboxEntry {
  return {
    id: row.id as OutboxEntry['id'],
    entity: row.entity as SyncEntity,
    operation: row.operation as SyncOperation,
    entityId: row.entity_id,
    patch: JSON.parse(row.patch) as Record<string, JsonValue>,
    baseVersion: row.base_version as OutboxEntry['baseVersion'],
    dependsOn: JSON.parse(row.depends_on) as OutboxEntry['dependsOn'],
    clientTimestamp: row.client_timestamp as OutboxEntry['clientTimestamp'],
    lamport: row.lamport,
    deviceId: row.device_id as OutboxEntry['deviceId'],
    userId: row.user_id as OutboxEntry['userId'],
    state: row.state as OutboxState,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at as OutboxEntry['createdAt'],
    updatedAt: row.updated_at as OutboxEntry['updatedAt'],
  };
}

export class Outbox {
  constructor(
    private readonly db: Database,
    private readonly identity: { deviceId: string; userId: string },
  ) {}

  /**
   * Monotonic per-device counter establishing causal order.
   *
   * Deliberately not a timestamp: field devices have wrong clocks (manual time
   * changes, dead RTC batteries, timezone edits mid-shift), and ordering user
   * intent by an untrusted clock reorders their work.
   */
  private nextLamport(): number {
    const row = this.db.getFirst<{ value: string }>(`SELECT value FROM meta WHERE key = 'lamport'`);
    const next = (row ? Number(row.value) : 0) + 1;
    this.db.run(
      `INSERT INTO meta (key, value) VALUES ('lamport', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(next)],
    );
    return next;
  }

  /**
   * Queue a mutation.
   *
   * Call this inside the same transaction as the row write. `Database.write`
   * wraps both, so a crash between them is impossible.
   */
  enqueue(input: EnqueueInput): OutboxEntry {
    const now = new Date().toISOString();
    const id = ulid();
    const lamport = this.nextLamport();

    // Coalescing: an unsent UPDATE for the same entity is merged rather than
    // queued twice. Typing into a notes field would otherwise emit one
    // operation per keystroke and turn a 3G sync into a multi-minute drain.
    if (input.operation === SyncOperation.UPDATE) {
      const pending = this.db.getFirst<OutboxRow>(
        `SELECT * FROM outbox
          WHERE entity_id = ? AND operation IN ('CREATE','UPDATE') AND state = 'PENDING'
          ORDER BY lamport DESC LIMIT 1`,
        [input.entityId],
      );

      if (pending) {
        const mergedPatch = { ...(JSON.parse(pending.patch) as object), ...input.patch };
        this.db.run(`UPDATE outbox SET patch = ?, updated_at = ? WHERE id = ?`, [
          JSON.stringify(mergedPatch),
          now,
          pending.id,
        ]);
        return toEntry({ ...pending, patch: JSON.stringify(mergedPatch), updated_at: now });
      }
    }

    this.db.run(
      `INSERT INTO outbox
         (id, entity, operation, entity_id, patch, base_version, depends_on,
          client_timestamp, lamport, device_id, user_id, state, attempts,
          next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, ?, ?)`,
      [
        id,
        input.entity,
        input.operation,
        input.entityId,
        JSON.stringify(input.patch),
        input.baseVersion,
        JSON.stringify(input.dependsOn ?? []),
        now,
        lamport,
        this.identity.deviceId,
        this.identity.userId,
        now,
        now,
      ],
    );

    return toEntry({
      id,
      entity: input.entity,
      operation: input.operation,
      entity_id: input.entityId,
      patch: JSON.stringify(input.patch),
      base_version: input.baseVersion,
      depends_on: JSON.stringify(input.dependsOn ?? []),
      client_timestamp: now,
      lamport,
      device_id: this.identity.deviceId,
      user_id: this.identity.userId,
      state: OutboxState.PENDING,
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      last_error_code: null,
      created_at: now,
      updated_at: now,
    });
  }

  /**
   * The next batch to push: pending or backed-off-and-due entries in Lamport
   * order. Conflicted and dead-lettered entries are excluded — they need a human.
   */
  claimBatch(limit: number, now: number = Date.now()): OutboxEntry[] {
    const rows = this.db.getAll<OutboxRow>(
      `SELECT * FROM outbox
        WHERE state IN ('PENDING','RETRYING')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY lamport ASC
        LIMIT ?`,
      [now, limit],
    );
    return rows.map(toEntry);
  }

  /** Convert entries to wire envelopes. */
  toEnvelopes(entries: OutboxEntry[]): SyncOperationEnvelope[] {
    return entries.map((e) => ({
      id: e.id,
      entity: e.entity,
      operation: e.operation,
      entityId: e.entityId,
      patch: e.patch,
      baseVersion: e.baseVersion,
      dependsOn: e.dependsOn,
      clientTimestamp: e.clientTimestamp,
      lamport: e.lamport,
      deviceId: e.deviceId,
      userId: e.userId,
    }));
  }

  markInFlight(ids: string[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE outbox SET state = 'IN_FLIGHT', updated_at = ?
        WHERE id IN (${ids.map(() => '?').join(',')})`,
      [now, ...ids],
    );
  }

  /** Acknowledged by the server. This is the only path that removes an entry. */
  markApplied(id: string): void {
    this.db.run(`DELETE FROM outbox WHERE id = ?`, [id]);
  }

  /**
   * Transient failure. Schedules the next attempt with jittered backoff, or
   * dead-letters once the attempt budget is exhausted so the user is told
   * rather than left with a silently stuck queue.
   */
  markRetry(id: string, error: string, code: string | null, retryAfterMs?: number): void {
    const row = this.db.getFirst<{ attempts: number }>(`SELECT attempts FROM outbox WHERE id = ?`, [
      id,
    ]);
    const attempts = (row?.attempts ?? 0) + 1;
    const now = new Date().toISOString();

    if (attempts >= DEFAULT_BACKOFF.maxAttempts) {
      this.db.run(
        `UPDATE outbox
            SET state = 'DEAD_LETTER', attempts = ?, last_error = ?, last_error_code = ?, updated_at = ?
          WHERE id = ?`,
        [attempts, error.slice(0, 500), code, now, id],
      );
      return;
    }

    // A server-supplied Retry-After always wins over local backoff: it is the
    // only party that knows when it will actually be ready.
    const delay = retryAfterMs ?? backoffDelay(attempts, DEFAULT_BACKOFF);
    this.db.run(
      `UPDATE outbox
          SET state = 'RETRYING', attempts = ?, next_attempt_at = ?,
              last_error = ?, last_error_code = ?, updated_at = ?
        WHERE id = ?`,
      [attempts, Date.now() + delay, error.slice(0, 500), code, now, id],
    );
  }

  /** Permanently rejected — validation or permission. Needs user action. */
  markDeadLetter(id: string, error: string, code: string | null): void {
    this.db.run(
      `UPDATE outbox
          SET state = 'DEAD_LETTER', last_error = ?, last_error_code = ?, updated_at = ?
        WHERE id = ?`,
      [error.slice(0, 500), code, new Date().toISOString(), id],
    );
  }

  /** Blocked on a conflict. Stays queued; replayed after resolution. */
  markConflicted(id: string, entityId: string): void {
    const now = new Date().toISOString();
    this.db.run(`UPDATE outbox SET state = 'CONFLICTED', updated_at = ? WHERE id = ?`, [now, id]);
    // Flag the row so the list can badge it without joining the outbox.
    for (const table of ['inspections', 'inspection_responses', 'attachments', 'signatures']) {
      this.db.run(`UPDATE ${table} SET has_conflict = 1 WHERE id = ?`, [entityId]);
    }
  }

  /** After resolution: requeue so the operation is applied against the merge. */
  requeueAfterResolution(id: string, patch: Record<string, JsonValue>, baseVersion: number): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE outbox
          SET state = 'PENDING', patch = ?, base_version = ?, attempts = 0,
              next_attempt_at = NULL, last_error = NULL, last_error_code = NULL, updated_at = ?
        WHERE id = ?`,
      [JSON.stringify(patch), baseVersion, now, id],
    );
  }

  /** Return in-flight entries to pending — called on startup after a crash. */
  recoverInFlight(): number {
    const now = new Date().toISOString();
    // An IN_FLIGHT entry at startup means the process died mid-push. The server
    // may or may not have applied it; the idempotency ledger makes a replay
    // safe, so retrying is strictly better than dropping it.
    const result = this.db.run(
      `UPDATE outbox SET state = 'PENDING', updated_at = ? WHERE state = 'IN_FLIGHT'`,
      [now],
    );
    return result.changes;
  }

  /** User-initiated retry of everything that has stalled. */
  retryFailed(): number {
    const now = new Date().toISOString();
    const result = this.db.run(
      `UPDATE outbox
          SET state = 'PENDING', attempts = 0, next_attempt_at = NULL,
              last_error = NULL, last_error_code = NULL, updated_at = ?
        WHERE state IN ('DEAD_LETTER','RETRYING')`,
      [now],
    );
    return result.changes;
  }

  counts(): {
    pending: number;
    inFlight: number;
    retrying: number;
    conflicted: number;
    deadLetter: number;
    total: number;
  } {
    const rows = this.db.getAll<{ state: string; n: number }>(
      `SELECT state, COUNT(*) AS n FROM outbox GROUP BY state`,
    );
    const by = (s: string): number => rows.find((r) => r.state === s)?.n ?? 0;
    return {
      pending: by('PENDING'),
      inFlight: by('IN_FLIGHT'),
      retrying: by('RETRYING'),
      conflicted: by('CONFLICTED'),
      deadLetter: by('DEAD_LETTER'),
      total: rows.reduce((sum, r) => sum + r.n, 0),
    };
  }

  /** Entries blocking a specific record, for the "unsynced changes" sheet. */
  forEntity(entityId: string): OutboxEntry[] {
    return this.db
      .getAll<OutboxRow>(`SELECT * FROM outbox WHERE entity_id = ? ORDER BY lamport ASC`, [
        entityId,
      ])
      .map(toEntry);
  }

  /** Purge everything. Used on logout and on a forced full resync. */
  clear(): void {
    this.db.run(`DELETE FROM outbox`);
  }
}

export type { SqlValue };
