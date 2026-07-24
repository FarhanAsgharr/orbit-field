/**
 * Attachment repository.
 *
 * Binaries are the part of an inspection most likely to be lost, because they
 * are large, slow to upload, and captured in exactly the conditions where the
 * network is worst. Two rules follow:
 *
 *  1. The local file is authoritative until the server confirms the checksum.
 *     A photo is never deleted from the device on the strength of an upload
 *     that merely *started*.
 *  2. Upload progress is durable. `received_chunks` and `uploaded_bytes` live in
 *     SQLite, not memory, so a force-quit at 90% of a 40 MB video resumes at 90%
 *     rather than starting again.
 */

import {
  AttachmentKind,
  AttachmentState,
  SyncEntity,
  SyncOperation,
  type Attachment,
  type GeoPoint,
  type JsonValue,
} from '@orbit/types';
import { ulid } from '@orbit/utils';
import type { Database, SqlValue } from '../database';
import type { Outbox } from '../../sync/outbox';

interface AttachmentRow {
  id: string;
  org_id: string;
  inspection_id: string | null;
  response_id: string | null;
  kind: string;
  state: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  checksum: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  local_uri: string | null;
  thumbnail_uri: string | null;
  storage_key: string | null;
  location: string | null;
  captured_at: string | null;
  caption: string | null;
  pair_tag: string | null;
  annotations: string | null;
  uploaded_at: string | null;
  upload_attempts: number;
  uploaded_bytes: number;
  upload_id: string | null;
  received_chunks: string;
  last_upload_error: string | null;
  version: number;
  sync_cursor: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_dirty: number;
  has_conflict: number;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id as Attachment['id'],
    orgId: row.org_id as Attachment['orgId'],
    inspectionId: row.inspection_id as Attachment['inspectionId'],
    responseId: row.response_id as Attachment['responseId'],
    kind: row.kind as AttachmentKind,
    state: row.state as AttachmentState,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    localUri: row.local_uri,
    storageKey: row.storage_key,
    thumbnailStorageKey: null,
    location: row.location ? (JSON.parse(row.location) as GeoPoint) : null,
    capturedAt: row.captured_at as Attachment['capturedAt'],
    caption: row.caption,
    pairTag: row.pair_tag,
    annotations: row.annotations ? (JSON.parse(row.annotations) as JsonValue) : null,
    uploadedAt: row.uploaded_at as Attachment['uploadedAt'],
    uploadAttempts: row.upload_attempts,
    lastUploadError: row.last_upload_error,
    version: row.version as Attachment['version'],
    syncCursor: row.sync_cursor as Attachment['syncCursor'],
    createdAt: row.created_at as Attachment['createdAt'],
    updatedAt: row.updated_at as Attachment['updatedAt'],
    deletedAt: row.deleted_at as Attachment['deletedAt'],
    lastWriterDeviceId: null,
    lastWriterUserId: null,
  };
}

export interface RegisterAttachmentInput {
  inspectionId: string | null;
  responseId?: string | null;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  localUri: string;
  thumbnailUri?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  location?: GeoPoint | null;
  capturedAt?: string | null;
  caption?: string | null;
  pairTag?: string | null;
}

export class AttachmentRepository {
  constructor(
    private readonly db: Database,
    private readonly outbox: Outbox,
    private readonly identity: { userId: string; orgId: string },
  ) {}

  // --- reads ---------------------------------------------------------------

  findById(id: string): Attachment | null {
    const row = this.db.getFirst<AttachmentRow>(`SELECT * FROM attachments WHERE id = ?`, [id]);
    return row ? toAttachment(row) : null;
  }

  forInspection(inspectionId: string): Attachment[] {
    return this.db
      .getAll<AttachmentRow>(
        `SELECT * FROM attachments
          WHERE inspection_id = ? AND deleted_at IS NULL
          ORDER BY captured_at ASC, created_at ASC`,
        [inspectionId],
      )
      .map(toAttachment);
  }

  forResponse(responseId: string): Attachment[] {
    return this.db
      .getAll<AttachmentRow>(
        `SELECT * FROM attachments
          WHERE response_id = ? AND deleted_at IS NULL
          ORDER BY created_at ASC`,
        [responseId],
      )
      .map(toAttachment);
  }

  /** Grouped by field, for feeding the validation engine in one pass. */
  byFieldForInspection(inspectionId: string): Record<string, Attachment[]> {
    const rows = this.db.getAll<AttachmentRow & { field_id: string | null }>(
      `SELECT a.*, r.field_id
         FROM attachments a
         LEFT JOIN inspection_responses r ON r.id = a.response_id
        WHERE a.inspection_id = ? AND a.deleted_at IS NULL`,
      [inspectionId],
    );

    const out: Record<string, Attachment[]> = {};
    for (const row of rows) {
      if (!row.field_id) continue;
      (out[row.field_id] ??= []).push(toAttachment(row));
    }
    return out;
  }

  /** Upload queue, oldest first so the earliest evidence reaches the server first. */
  pendingUploads(limit = 50): Attachment[] {
    return this.db
      .getAll<AttachmentRow>(
        `SELECT * FROM attachments
          WHERE deleted_at IS NULL
            AND state IN ('QUEUED','UPLOADING','FAILED')
            AND local_uri IS NOT NULL
          ORDER BY created_at ASC
          LIMIT ?`,
        [limit],
      )
      .map(toAttachment);
  }

  pendingUploadCount(): number {
    const row = this.db.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM attachments
        WHERE deleted_at IS NULL AND state IN ('QUEUED','UPLOADING','FAILED')`,
    );
    return row?.n ?? 0;
  }

  /** Bytes still to transfer, for the sync progress indicator. */
  pendingUploadBytes(): { total: number; uploaded: number } {
    const row = this.db.getFirst<{ total: number | null; uploaded: number | null }>(
      `SELECT SUM(size_bytes) AS total, SUM(uploaded_bytes) AS uploaded
         FROM attachments
        WHERE deleted_at IS NULL AND state IN ('QUEUED','UPLOADING','FAILED')`,
    );
    return { total: row?.total ?? 0, uploaded: row?.uploaded ?? 0 };
  }

  /**
   * Dedupe by content hash.
   *
   * The same photo attached to two questions should upload once. Checked before
   * registering rather than server-side only, so the device also avoids storing
   * the bytes twice.
   */
  findByChecksum(checksum: string): Attachment | null {
    const row = this.db.getFirst<AttachmentRow>(
      `SELECT * FROM attachments WHERE checksum = ? AND deleted_at IS NULL LIMIT 1`,
      [checksum],
    );
    return row ? toAttachment(row) : null;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Register a freshly captured file.
   *
   * The row is created in QUEUED state, which is what puts it in front of the
   * uploader. The file itself is already on disk by this point — the camera
   * module writes it before calling here, so a crash between capture and
   * registration leaves an orphaned file rather than a lost photo.
   */
  register(input: RegisterAttachmentInput): Attachment {
    const id = ulid();
    const now = new Date().toISOString();

    return this.db.write(() => {
      this.db.run(
        `INSERT INTO attachments
           (id, org_id, inspection_id, response_id, kind, state, file_name, mime_type,
            size_bytes, checksum, width, height, duration_ms, local_uri, thumbnail_uri,
            location, captured_at, caption, pair_tag, version, sync_cursor,
            created_at, updated_at, is_dirty)
         VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1)`,
        [
          id,
          this.identity.orgId,
          input.inspectionId,
          input.responseId ?? null,
          input.kind,
          input.fileName,
          input.mimeType,
          input.sizeBytes,
          input.checksum,
          input.width ?? null,
          input.height ?? null,
          input.durationMs ?? null,
          input.localUri,
          input.thumbnailUri ?? null,
          input.location ? JSON.stringify(input.location) : null,
          input.capturedAt ?? now,
          input.caption ?? null,
          input.pairTag ?? null,
          now,
          now,
        ],
      );

      // The metadata row syncs through the normal channel; the bytes go through
      // the separate resumable upload path. Keeping them independent means a
      // stalled 40 MB video never blocks the inspection's answers from syncing.
      this.outbox.enqueue({
        entity: SyncEntity.ATTACHMENT,
        operation: SyncOperation.CREATE,
        entityId: id,
        patch: {
          inspectionId: input.inspectionId,
          responseId: input.responseId ?? null,
          kind: input.kind,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          checksum: input.checksum,
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
          location: (input.location ?? null) as JsonValue,
          capturedAt: input.capturedAt ?? now,
          caption: input.caption ?? null,
          pairTag: input.pairTag ?? null,
          state: AttachmentState.QUEUED,
        },
        baseVersion: null,
      });

      return this.findById(id)!;
    });
  }

  /** Persist a resume point. Called after every acknowledged chunk. */
  recordChunkProgress(id: string, uploadId: string, receivedChunks: number[], uploadedBytes: number): void {
    this.db.run(
      `UPDATE attachments
          SET upload_id = ?, received_chunks = ?, uploaded_bytes = ?,
              state = 'UPLOADING', updated_at = ?
        WHERE id = ?`,
      [uploadId, JSON.stringify(receivedChunks), uploadedBytes, new Date().toISOString(), id],
    );
  }

  /** Chunk indices already durably stored server-side. */
  resumeState(id: string): { uploadId: string | null; receivedChunks: number[]; uploadedBytes: number } {
    const row = this.db.getFirst<{ upload_id: string | null; received_chunks: string; uploaded_bytes: number }>(
      `SELECT upload_id, received_chunks, uploaded_bytes FROM attachments WHERE id = ?`,
      [id],
    );
    if (!row) return { uploadId: null, receivedChunks: [], uploadedBytes: 0 };
    let chunks: number[] = [];
    try {
      chunks = JSON.parse(row.received_chunks) as number[];
    } catch {
      chunks = [];
    }
    return { uploadId: row.upload_id, receivedChunks: chunks, uploadedBytes: row.uploaded_bytes };
  }

  markUploaded(id: string, storageKey: string): void {
    this.db.run(
      `UPDATE attachments
          SET state = 'UPLOADED', storage_key = ?, uploaded_at = ?,
              last_upload_error = NULL, updated_at = ?
        WHERE id = ?`,
      [storageKey, new Date().toISOString(), new Date().toISOString(), id],
    );
  }

  markUploadFailed(id: string, error: string): void {
    this.db.run(
      `UPDATE attachments
          SET state = 'FAILED', upload_attempts = upload_attempts + 1,
              last_upload_error = ?, updated_at = ?
        WHERE id = ?`,
      [error.slice(0, 500), new Date().toISOString(), id],
    );
  }

  /** Requeue everything that failed — the "retry uploads" button. */
  retryFailed(): number {
    return this.db.run(
      `UPDATE attachments
          SET state = 'QUEUED', last_upload_error = NULL, updated_at = ?
        WHERE state = 'FAILED' AND local_uri IS NOT NULL`,
      [new Date().toISOString()],
    ).changes;
  }

  updateMetadata(id: string, changes: { caption?: string | null; pairTag?: string | null; annotations?: JsonValue }): void {
    this.db.write(() => {
      const current = this.db.getFirst<{ version: number }>(
        `SELECT version FROM attachments WHERE id = ?`, [id],
      );

      const sets: string[] = [];
      const params: SqlValue[] = [];
      const patch: Record<string, JsonValue> = {};

      if (changes.caption !== undefined) {
        sets.push('caption = ?'); params.push(changes.caption); patch.caption = changes.caption;
      }
      if (changes.pairTag !== undefined) {
        sets.push('pair_tag = ?'); params.push(changes.pairTag); patch.pairTag = changes.pairTag;
      }
      if (changes.annotations !== undefined) {
        // Annotations are stored separately from the image so the original
        // capture is never destructively modified — a redacted photo must
        // always be recoverable to its unedited state for evidentiary purposes.
        sets.push('annotations = ?');
        params.push(JSON.stringify(changes.annotations));
        patch.annotations = changes.annotations;
      }
      if (sets.length === 0) return;

      sets.push('updated_at = ?', 'is_dirty = 1');
      params.push(new Date().toISOString(), id);
      this.db.run(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`, params);

      this.outbox.enqueue({
        entity: SyncEntity.ATTACHMENT,
        operation: SyncOperation.UPDATE,
        entityId: id,
        patch,
        baseVersion: current && current.version > 0 ? current.version : null,
      });
    });
  }

  remove(id: string): void {
    this.db.write(() => {
      const current = this.db.getFirst<{ version: number }>(
        `SELECT version FROM attachments WHERE id = ?`, [id],
      );
      this.db.run(`UPDATE attachments SET deleted_at = ?, is_dirty = 1 WHERE id = ?`, [
        new Date().toISOString(), id,
      ]);
      this.outbox.enqueue({
        entity: SyncEntity.ATTACHMENT,
        operation: SyncOperation.DELETE,
        entityId: id,
        patch: {},
        baseVersion: current && current.version > 0 ? current.version : null,
      });
    });
  }

  /**
   * Candidates for local eviction.
   *
   * Only files the server has confirmed, belonging to inspections closed longer
   * than the retention window. An unsynced photo is never evictable, however
   * tight storage gets — the device may hold the only copy.
   */
  evictionCandidates(retentionDays: number, limit = 100): Attachment[] {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return this.db
      .getAll<AttachmentRow>(
        `SELECT a.* FROM attachments a
           JOIN inspections i ON i.id = a.inspection_id
          WHERE a.state = 'UPLOADED'
            AND a.local_uri IS NOT NULL
            AND a.storage_key IS NOT NULL
            AND i.status IN ('APPROVED','ARCHIVED','CANCELLED')
            AND i.updated_at < ?
            AND i.is_dirty = 0
          ORDER BY i.updated_at ASC
          LIMIT ?`,
        [cutoff, limit],
      )
      .map(toAttachment);
  }

  /** Drop the local file reference after the bytes have been deleted from disk. */
  markEvicted(id: string): void {
    this.db.run(
      `UPDATE attachments SET local_uri = NULL, thumbnail_uri = NULL, state = 'EVICTABLE' WHERE id = ?`,
      [id],
    );
  }

  /** Total bytes held on device, for the storage indicator. */
  localStorageBytes(): number {
    const row = this.db.getFirst<{ total: number | null }>(
      `SELECT SUM(size_bytes) AS total FROM attachments WHERE local_uri IS NOT NULL AND deleted_at IS NULL`,
    );
    return row?.total ?? 0;
  }
}
