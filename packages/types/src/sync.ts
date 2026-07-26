/**
 * Synchronisation protocol.
 *
 * Design in one paragraph: the device owns a durable outbox of intent-level
 * operations. Each operation names the entity, the primary key (minted on the
 * device), the field-level patch, and the record version the device believed it
 * was editing. The server applies operations in causal order inside a
 * transaction, stamps each accepted change with the next value of a per-org
 * monotonic sequence, and returns either an ACK or a CONFLICT carrying the
 * server's current row. The device pulls changes by asking for everything after
 * the cursor it last durably persisted. Nothing is ever deleted client-side
 * until the server has confirmed receipt, so a crash at any point loses nothing.
 */

import type { ConflictResolution, OutboxState, SyncEntity, SyncOperation } from './enums.js';
import type {
  DeviceId,
  IsoTimestamp,
  JsonValue,
  OperationId,
  RecordVersion,
  SyncCursor,
  UserId,
} from './primitives.js';

/** Wire version. Bumped only on breaking changes; server supports N and N-1. */
export const SYNC_PROTOCOL_VERSION = 1;

/**
 * A single durable mutation. `patch` holds only changed fields, so two devices
 * editing disjoint fields of the same inspection merge cleanly rather than
 * fighting over a whole-row overwrite.
 */
export interface SyncOperationEnvelope {
  /** Client-minted ULID. Doubles as the server-side idempotency key. */
  id: OperationId;
  entity: SyncEntity;
  operation: SyncOperation;
  /** Primary key of the affected row, minted on the device for CREATE. */
  entityId: string;
  /**
   * Field-level patch. For CREATE this is the full row; for UPDATE only the
   * changed fields; for DELETE it is empty.
   */
  patch: Record<string, JsonValue>;
  /**
   * Version the device believed it was editing. Null for CREATE. A mismatch
   * against the server's current version is what triggers conflict detection.
   */
  baseVersion: RecordVersion | null;
  /** Operation IDs that must be applied before this one, e.g. parent inserts. */
  dependsOn: OperationId[];
  /** Device wall-clock at capture. Advisory only — never used for ordering. */
  clientTimestamp: IsoTimestamp;
  /**
   * Lamport counter, monotonic per device. Establishes causal order within a
   * device's own stream without trusting its clock.
   */
  lamport: number;
  deviceId: DeviceId;
  userId: UserId;
}

/** Outbox row as persisted on the device. */
export interface OutboxEntry extends SyncOperationEnvelope {
  state: OutboxState;
  attempts: number;
  /** Epoch millis before which the entry must not be retried. */
  nextAttemptAt: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface SyncPushRequest {
  protocolVersion: number;
  deviceId: DeviceId;
  operations: SyncOperationEnvelope[];
  /** Cursor the device currently holds, so the server can detect staleness. */
  cursor: SyncCursor;
}

export type SyncOperationResultStatus =
  /** Applied cleanly. */
  | 'APPLIED'
  /** Already applied in an earlier attempt; returned for idempotent replays. */
  | 'DUPLICATE'
  /** Concurrent server-side edit. Requires resolution. */
  | 'CONFLICT'
  /** Permanently rejected — validation failure or permission denial. */
  | 'REJECTED'
  /** Transient server-side failure. The device should retry with backoff. */
  | 'RETRY'
  /** A dependency failed, so this operation was not attempted. */
  | 'SKIPPED_DEPENDENCY';

export interface SyncOperationResult {
  operationId: OperationId;
  status: SyncOperationResultStatus;
  /** Set on APPLIED/DUPLICATE — the authoritative post-write state. */
  entityId?: string;
  version?: RecordVersion;
  syncCursor?: SyncCursor;
  /** Set on CONFLICT. */
  conflict?: SyncConflict;
  /** Set on REJECTED/RETRY. */
  errorCode?: string;
  errorMessage?: string;
  /** Field-level validation errors keyed by field path. */
  fieldErrors?: Record<string, string>;
}

export interface SyncPushResponse {
  protocolVersion: number;
  results: SyncOperationResult[];
  /** Cursor after applying this batch. */
  cursor: SyncCursor;
  serverTime: IsoTimestamp;
}

export interface SyncPullRequest {
  protocolVersion: number;
  deviceId: DeviceId;
  /** Everything strictly greater than this cursor is returned. */
  since: SyncCursor;
  /** Max changes per page. The server may return fewer. */
  limit: number;
  /** Restrict to specific entity families, e.g. metadata-only warm-up pulls. */
  entities?: SyncEntity[];
}

/** One changed row on the wire. */
export interface SyncChange {
  entity: SyncEntity;
  operation: SyncOperation;
  entityId: string;
  /** Full row for CREATE/UPDATE; null for DELETE. */
  data: Record<string, JsonValue> | null;
  version: RecordVersion;
  syncCursor: SyncCursor;
  updatedAt: IsoTimestamp;
}

export interface SyncPullResponse {
  protocolVersion: number;
  changes: SyncChange[];
  /** Cursor to persist and send on the next pull. */
  cursor: SyncCursor;
  /** True when more pages remain — the device should pull again immediately. */
  hasMore: boolean;
  serverTime: IsoTimestamp;
  /**
   * Set when the device's cursor is older than the server's change-log retention
   * window. The device must discard local server-state and re-bootstrap.
   */
  requiresFullResync?: boolean;
}

/** Per-field divergence, rendered side-by-side in the resolution UI. */
export interface FieldDiff {
  /** Dot path within the record, e.g. `notes` or `value.latitude`. */
  path: string;
  label: string;
  /** Common ancestor value — the version both sides edited from. */
  baseValue: JsonValue;
  localValue: JsonValue;
  serverValue: JsonValue;
  /** False when only one side changed, in which case it auto-merges. */
  isConflicting: boolean;
  /** Resolution the merge engine chose without asking, when unambiguous. */
  autoResolution: ConflictResolution | null;
}

export interface SyncConflict {
  operationId: OperationId;
  entity: SyncEntity;
  entityId: string;
  /** Version the device edited from. */
  baseVersion: RecordVersion | null;
  /** Current server version. */
  serverVersion: RecordVersion;
  localRecord: Record<string, JsonValue>;
  serverRecord: Record<string, JsonValue>;
  diffs: FieldDiff[];
  /** True when every diff auto-resolved and no human input is needed. */
  isAutoResolvable: boolean;
  serverUpdatedAt: IsoTimestamp;
  serverUpdatedByName: string | null;
  detectedAt: IsoTimestamp;
}

/** What the user (or the auto-merger) decided. */
export interface ConflictResolutionRequest {
  operationId: OperationId;
  entity: SyncEntity;
  entityId: string;
  strategy: ConflictResolution;
  /**
   * Required when strategy is MERGE: the chosen side per field path. Paths
   * omitted here fall back to the server value.
   */
  fieldChoices?: Record<string, 'LOCAL' | 'SERVER'>;
  /** Explicit override values, used when the user hand-edits during merge. */
  fieldValues?: Record<string, JsonValue>;
  resolvedBy: UserId;
  resolvedAt: IsoTimestamp;
}

/** Resumable upload session for a single binary. */
export interface UploadSession {
  attachmentId: string;
  uploadId: string;
  /** Bytes per chunk agreed with the server. */
  chunkSize: number;
  totalChunks: number;
  /** Indices the server has already durably stored — the resume point. */
  receivedChunks: number[];
  expiresAt: IsoTimestamp;
  /** Direct-to-storage URLs when the deployment uses presigned uploads. */
  presignedUrls?: string[];
}

export interface UploadChunkAck {
  uploadId: string;
  chunkIndex: number;
  receivedChunks: number[];
  complete: boolean;
}

/** Aggregate progress surfaced on the dashboard. */
export interface SyncStatus {
  state: 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR' | 'PAUSED';
  isOnline: boolean;
  /** True when the connection is metered and media sync is deferred. */
  isMetered: boolean;
  cursor: SyncCursor;
  lastSuccessfulSyncAt: IsoTimestamp | null;
  lastAttemptAt: IsoTimestamp | null;
  pendingOperations: number;
  inFlightOperations: number;
  failedOperations: number;
  conflictedOperations: number;
  pendingUploads: number;
  uploadedBytes: number;
  totalUploadBytes: number;
  /** 0..1 across the whole current run, or null when idle. */
  progress: number | null;
  currentPhase: 'PUSH' | 'PULL' | 'MEDIA' | null;
  lastError: string | null;
}

/** Durable audit trail of every sync run, for field-support diagnosis. */
export interface SyncLogEntry {
  id: string;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  trigger: 'MANUAL' | 'INTERVAL' | 'CONNECTIVITY' | 'BACKGROUND' | 'STARTUP' | 'PUSH_NOTIFICATION';
  pushedCount: number;
  pulledCount: number;
  conflictCount: number;
  uploadedCount: number;
  bytesUp: number;
  bytesDown: number;
  durationMs: number | null;
  outcome: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'ABORTED';
  error: string | null;
}
