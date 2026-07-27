/**
 * Attaching files to a request, from the customer's side.
 *
 * Drives exactly the same two-step pipeline as the console and the phone:
 * declare the file against the request, then push it in chunks with a
 * checksum. Nothing here talks to storage, so resume, integrity checking and
 * the server's type rules all come for free rather than being reimplemented
 * for a third client.
 *
 * Progress is per-chunk. On the connection a customer's site office actually
 * has, a 20 MB drawing is a minute of nothing happening, and a bar that only
 * moves at the end is indistinguishable from one that is stuck.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useRef, useState } from 'react';

import { api } from '../lib/api';
import { formatBytes, Notice } from './ui';

/** Mirrors the server's allowlist. Kept in step deliberately, not derived. */
const ACCEPT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/zip',
  'text/plain',
].join(',');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20;

/** 1 MB, comfortably under the API's JSON body limit once base64-encoded. */
const CHUNK_BYTES = 1024 * 1024;

export interface StoredAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploaded: boolean;
  createdAt: string;
}

interface Transfer {
  key: string;
  file: File;
  progress: number;
  status: 'waiting' | 'sending' | 'done' | 'failed';
  error?: string;
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: a single spread of a megabyte blows the argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + 8192));
  }
  return globalThis.btoa(binary);
}

const extensionOf = (name: string): string => {
  const at = name.lastIndexOf('.');
  return at < 0 ? 'file' : name.slice(at + 1, at + 5);
};

export function Attachments({
  requestId,
  readOnly = false,
}: {
  requestId: string;
  readOnly?: boolean;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = useQuery({
    queryKey: ['request-attachments', requestId],
    queryFn: () => api.get<StoredAttachment[]>(`/inspection-requests/${requestId}/attachments`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['request-attachments', requestId] });
    void queryClient.invalidateQueries({ queryKey: ['request', requestId] });
  };

  const update = (key: string, patch: Partial<Transfer>): void =>
    setTransfers((current) => current.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  const send = async (transfer: Transfer): Promise<void> => {
    update(transfer.key, { status: 'sending', progress: 0, error: undefined });
    try {
      const checksum = await sha256(transfer.file);

      const declared = await api.post<{ id: string }>(
        `/inspection-requests/${requestId}/attachments`,
        {
          fileName: transfer.file.name,
          mimeType: transfer.file.type || 'application/octet-stream',
          sizeBytes: transfer.file.size,
          checksum,
        },
      );

      const session = await api.post<{ uploadId: string; totalChunks: number; chunkSize: number }>(
        '/uploads',
        {
          attachmentId: declared.id,
          sizeBytes: transfer.file.size,
          checksum,
          chunkSize: CHUNK_BYTES,
        },
      );

      for (let index = 0; index < session.totalChunks; index++) {
        const slice = transfer.file.slice(
          index * session.chunkSize,
          (index + 1) * session.chunkSize,
        );
        await api.post(`/uploads/${session.uploadId}/chunks/${index}`, {
          data: await toBase64(slice),
          checksum: await sha256(slice),
        });
        update(transfer.key, { progress: Math.round(((index + 1) / session.totalChunks) * 100) });
      }

      await api.post(`/uploads/${session.uploadId}/complete`, { checksum });
      update(transfer.key, { status: 'done', progress: 100 });
      refresh();
    } catch (err) {
      // Kept in the list rather than dropped: the point of showing a failure is
      // that the person can press retry on that one file.
      update(transfer.key, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'The upload failed.',
      });
    }
  };

  const accept = (files: FileList | null): void => {
    if (!files || readOnly) return;
    setError(null);

    const room = MAX_FILES - (stored.data?.length ?? 0) - transfers.length;
    const chosen = [...files];
    if (chosen.length > room) {
      setError(
        `A request can carry ${MAX_FILES} files. Only the first ${Math.max(room, 0)} were added.`,
      );
    }

    const queued: Transfer[] = [];
    for (const file of chosen.slice(0, Math.max(room, 0))) {
      if (file.size > MAX_BYTES) {
        // Refused here so a doomed 30 MB upload never starts.
        setError(`${file.name} is larger than 25 MB.`);
        continue;
      }
      queued.push({
        key: `${file.name}-${file.size}-${file.lastModified}`,
        file,
        progress: 0,
        status: 'waiting',
      });
    }

    setTransfers((current) => [...current, ...queued]);
    for (const t of queued) void send(t);
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/inspection-requests/${requestId}/attachments/${id}`),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'That file could not be removed.'),
  });

  /**
   * Fetch the bytes and hand back an object URL.
   *
   * The API is on another origin and authenticates with a bearer token, so an
   * `<a href>` pointing at it sends no credentials and resolves against the
   * portal instead — every download would be a 404.
   */
  const download = async (a: StoredAttachment): Promise<void> => {
    try {
      const blob = await api.blob(`/uploads/attachments/${a.id}/content`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = a.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be opened.');
    }
  };

  const files = stored.data ?? [];

  return (
    <div className="stack stack--tight">
      {error && <Notice>{error}</Notice>}

      {!readOnly && (
        <div
          className={dragging ? 'dropzone dropzone--active' : 'dropzone'}
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            accept(e.dataTransfer.files);
          }}
        >
          <strong>Drop drawings, photos or documents here</strong>
          <div className="faint" style={{ marginTop: 4 }}>
            PDF, Word, Excel, images, text or zip · up to 25 MB each · {MAX_FILES} files
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              accept(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {(files.length > 0 || transfers.length > 0) && (
        <div className="file-list">
          {files.map((file) => (
            <div className="file" key={file.id}>
              <span className="file__icon">{extensionOf(file.fileName)}</span>
              <div className="file__main">
                <div className="file__name" title={file.fileName}>
                  {file.fileName}
                </div>
                <div className="file__meta">
                  {formatBytes(file.sizeBytes)}
                  {!file.uploaded && ' · still transferring'}
                </div>
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void download(file)}
              >
                Download
              </button>
              {!readOnly && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(file.id)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}

          {transfers
            .filter((t) => t.status !== 'done')
            .map((t) => (
              <div className="file" key={t.key}>
                <span className="file__icon">{extensionOf(t.file.name)}</span>
                <div className="file__main">
                  <div className="file__name">{t.file.name}</div>
                  <div className="file__meta">
                    {t.status === 'failed'
                      ? (t.error ?? 'Failed')
                      : `${formatBytes(t.file.size)} · ${t.progress}%`}
                  </div>
                  {t.status === 'sending' && (
                    <div className="progress">
                      <div className="progress__bar" style={{ width: `${t.progress}%` }} />
                    </div>
                  )}
                </div>
                {t.status === 'failed' && (
                  <button type="button" className="btn btn--sm" onClick={() => void send(t)}>
                    Retry
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
