/**
 * Resumable media uploader.
 *
 * Photographs and videos are the hardest part of this system to get right: they
 * are large, they are captured exactly where the network is worst, and losing
 * one loses evidence that cannot be recreated once the inspector has left site.
 *
 * The design:
 *  - Files upload in chunks. Each acknowledged chunk is recorded in SQLite
 *    before the next is sent, so progress is durable across a force-quit.
 *  - Resume asks the server which chunks it already holds rather than trusting
 *    local state; the server is the authority on what it has.
 *  - A local file is never deleted on the strength of an upload that merely
 *    started. Only a server-confirmed checksum retires the local copy.
 */

import * as FileSystem from 'expo-file-system';
import { AttachmentState, type UploadSession } from '@orbit/types';
import { AppError, ErrorCode } from '@orbit/shared';
import { MEDIA_BACKOFF, backoffDelay } from '@orbit/utils';
import type { ApiClient } from '../api/client';
import type { AttachmentRepository } from '../db/repositories/attachment.repository';
import type { MediaUploader as MediaUploaderContract } from './engine';

/**
 * Session as the server actually returns it.
 *
 * `complete` and `storageKey` are set only on the dedupe / already-uploaded
 * paths, where no transfer is needed at all.
 */
type OpenedSession = UploadSession & { complete?: boolean; storageKey?: string };

export interface UploaderOptions {
  api: ApiClient;
  attachments: AttachmentRepository;
  /** Bytes per chunk. Must match what the server agreed in the session. */
  chunkSize?: number;
  /** Uploads attempted per sync pass. Keeps one huge video from starving others. */
  maxPerPass?: number;
}

export class MediaUploader implements MediaUploaderContract {
  private readonly chunkSize: number;
  private readonly maxPerPass: number;

  constructor(private readonly options: UploaderOptions) {
    this.chunkSize = options.chunkSize ?? 5 * 1024 * 1024;
    this.maxPerPass = options.maxPerPass ?? 10;
  }

  pendingCount(): number {
    return this.options.attachments.pendingUploadCount();
  }

  /**
   * Upload queued attachments.
   *
   * Failures are per-file: one corrupt attachment must not block the queue
   * behind it, because that one bad file would hold back every photo taken
   * after it.
   */
  async uploadPending(options: { metered: boolean; signal: AbortSignal }): Promise<number> {
    const queue = this.options.attachments.pendingUploads(this.maxPerPass);
    let completed = 0;

    for (const attachment of queue) {
      if (options.signal.aborted) break;

      // On a metered connection, hold back anything large. A 40 MB video should
      // not silently consume an inspector's personal data allowance; it waits
      // for wifi. Small photos still go, so evidence is not stranded entirely.
      if (options.metered && attachment.sizeBytes > 2 * 1024 * 1024) continue;

      try {
        await this.uploadOne(attachment.id, options.signal);
        completed += 1;
      } catch (err) {
        if (options.signal.aborted) break;
        const message = err instanceof Error ? err.message : String(err);
        this.options.attachments.markUploadFailed(attachment.id, message);

        // Back off before touching the next file when the failure looks like a
        // server or network problem rather than one bad file.
        if (err instanceof AppError && err.status >= 500) {
          const delay = backoffDelay(attachment.uploadAttempts + 1, MEDIA_BACKOFF);
          await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
        }
      }
    }

    return completed;
  }

  /** Upload one attachment, resuming if a session already exists. */
  private async uploadOne(attachmentId: string, signal: AbortSignal): Promise<void> {
    const attachment = this.options.attachments.findById(attachmentId);
    if (!attachment) return;

    if (!attachment.localUri) {
      // Nothing to send. Either already evicted or registered without a file —
      // either way, retrying forever would be pointless.
      this.options.attachments.markUploadFailed(attachmentId, 'The local file is no longer available.');
      return;
    }

    const info = await FileSystem.getInfoAsync(attachment.localUri, { size: true });
    if (!info.exists) {
      // The OS reclaimed the cache directory. This is a real data loss event
      // and must be visible rather than retried silently forever.
      this.options.attachments.markUploadFailed(
        attachmentId,
        'The captured file was removed from device storage before it could upload.',
      );
      return;
    }

    const session = await this.openSession(attachment.id, attachment.sizeBytes, attachment.checksum);

    // The server may report the work is already done: either these exact bytes
    // are present under another attachment (content-addressed dedupe), or a
    // previous run finished and we lost the acknowledgement. In both cases the
    // `uploadId` is a sentinel rather than a real session, and sending chunks to
    // it would fail validation on every one.
    if (session.complete === true && session.storageKey) {
      this.options.attachments.markUploaded(attachment.id, session.storageKey);
      return;
    }

    const totalChunks = session.totalChunks;
    const received = new Set(session.receivedChunks);

    for (let index = 0; index < totalChunks; index++) {
      if (signal.aborted) throw new AppError(ErrorCode.TIMEOUT, 'Upload cancelled.');

      // Skip what the server already holds — this is the resume.
      if (received.has(index)) continue;

      const offset = index * session.chunkSize;
      const length = Math.min(session.chunkSize, attachment.sizeBytes - offset);

      const chunk = await FileSystem.readAsStringAsync(attachment.localUri, {
        encoding: FileSystem.EncodingType.Base64,
        position: offset,
        length,
      });

      const ack = await this.options.api.post<{ receivedChunks: number[]; complete: boolean }>(
        `/uploads/${session.uploadId}/chunks/${index}`,
        { data: chunk },
        { timeoutMs: 120_000, signal },
      );

      for (const c of ack.receivedChunks) received.add(c);

      // Persist the resume point before sending the next chunk. Writing after
      // would mean a crash re-sends a chunk the server already has — harmless
      // but wasteful on a link where bytes are expensive.
      this.options.attachments.recordChunkProgress(
        attachment.id,
        session.uploadId,
        Array.from(received),
        Math.min(attachment.sizeBytes, (index + 1) * session.chunkSize),
      );
    }

    const result = await this.options.api.post<{ storageKey: string }>(
      `/uploads/${session.uploadId}/complete`,
      { checksum: attachment.checksum },
    );

    this.options.attachments.markUploaded(attachment.id, result.storageKey);
  }

  /**
   * Open or resume an upload session.
   *
   * Always asks the server, even when a local `upload_id` exists: sessions
   * expire, and a stale local id would produce a 410 on every chunk. Letting the
   * server decide keeps the two sides in agreement.
   */
  private async openSession(
    attachmentId: string,
    sizeBytes: number,
    checksum: string,
  ): Promise<OpenedSession> {
    const local = this.options.attachments.resumeState(attachmentId);

    if (local.uploadId) {
      try {
        return await this.options.api.get<OpenedSession>(`/uploads/${local.uploadId}`);
      } catch (err) {
        // Expired or unknown session: fall through and open a fresh one rather
        // than failing the whole attachment.
        if (!(err instanceof AppError) || err.status !== 410) throw err;
      }
    }

    const session = await this.options.api.post<OpenedSession>('/uploads', {
      attachmentId,
      sizeBytes,
      checksum,
      chunkSize: this.chunkSize,
    });

    this.options.attachments.recordChunkProgress(
      attachmentId,
      session.uploadId,
      session.receivedChunks,
      session.receivedChunks.length * session.chunkSize,
    );

    return session;
  }

  /**
   * Free space by removing local copies the server has confirmed.
   *
   * Only touches files belonging to closed inspections outside the retention
   * window, and never touches anything still dirty or unuploaded.
   */
  async evictConfirmedFiles(retentionDays: number): Promise<{ freedBytes: number; count: number }> {
    const candidates = this.options.attachments.evictionCandidates(retentionDays);
    let freedBytes = 0;
    let count = 0;

    for (const attachment of candidates) {
      if (!attachment.localUri) continue;
      try {
        await FileSystem.deleteAsync(attachment.localUri, { idempotent: true });
        this.options.attachments.markEvicted(attachment.id);
        freedBytes += attachment.sizeBytes;
        count += 1;
      } catch {
        // A file that will not delete is not worth failing the sweep over.
        continue;
      }
    }

    return { freedBytes, count };
  }

  /** Requeue everything that failed. Backs the "retry uploads" action. */
  retryFailed(): number {
    return this.options.attachments.retryFailed();
  }

  /** Byte-level progress for the sync indicator. */
  progress(): { total: number; uploaded: number; ratio: number } {
    const { total, uploaded } = this.options.attachments.pendingUploadBytes();
    return { total, uploaded, ratio: total > 0 ? uploaded / total : 1 };
  }
}

export { AttachmentState };
