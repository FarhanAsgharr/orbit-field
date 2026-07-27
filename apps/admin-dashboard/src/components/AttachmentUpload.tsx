/**
 * Attaching files to a request.
 *
 * The transfer reuses the same two-step pipeline a phone uses for photographs:
 * declare the file, then push it in chunks with a checksum. Nothing here talks
 * to storage — it drives the endpoints that already exist, which is why resume
 * and integrity checking come for free rather than being reimplemented in a
 * browser.
 *
 * Progress is per-chunk rather than per-file. On the connection a site office
 * actually has, a 20 MB drawing is a minute of nothing happening, and a bar
 * that only moves at the end is indistinguishable from one that is stuck.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useRef, useState } from 'react';

import { api } from '../lib/api';
import { Badge, ErrorBanner, formatBytes } from './ui';

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

/** 1 MB, comfortably under the API's 10 MB JSON body limit once base64-encoded. */
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

/** SHA-256 of a Blob, using the platform's own implementation. */
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

export function AttachmentUpload({
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
  const [preview, setPreview] = useState<StoredAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const stored = useQuery({
    queryKey: ['request-attachments', requestId],
    queryFn: () => api.get<StoredAttachment[]>(`/inspection-requests/${requestId}/attachments`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['request-attachments', requestId] });
    void queryClient.invalidateQueries({ queryKey: ['client-request', requestId] });
  };

  const update = (key: string, patch: Partial<Transfer>): void =>
    setTransfers((current) => current.map((t) => (t.key === key ? { ...t, ...patch } : t)));

  /** Declare, then chunk. The same path a phone takes with a photograph. */
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
      // Kept in the list rather than dropped: the whole point of showing a
      // failure is that the person can press retry on that one file.
      update(transfer.key, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Upload failed.',
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
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not remove that file.'),
  });

  const isImage = (mime: string): boolean => mime.startsWith('image/');

  /**
   * Fetch the bytes and hand back an object URL.
   *
   * The API authenticates with a bearer token on a different origin, so an
   * `<img src>` or an `<a href>` pointing at it sends no credentials and
   * resolves against the console instead — every thumbnail would be a broken
   * image and every download a 404.
   */
  const openBlob = async (a: StoredAttachment, mode: 'download' | 'view'): Promise<void> => {
    try {
      const blob = await api.blob(`/uploads/attachments/${a.id}/content`);
      const url = URL.createObjectURL(blob);
      if (mode === 'download') {
        const link = document.createElement('a');
        link.href = url;
        link.download = a.fileName;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        setPreviewUrl(url);
        setPreview(a);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that file.');
    }
  };

  return (
    <div className="stack gap-3">
      {error ? <ErrorBanner message={error} /> : null}

      {readOnly ? null : (
        <div
          className={`dropzone${dragging ? ' dropzone--over' : ''}`}
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
          <strong>Drop files here, or choose them</strong>
          <span className="small muted">
            PDF, Word, Excel, images, text or zip · up to 25 MB each · {MAX_FILES} files
          </span>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            aria-label="Choose files to attach"
            style={{ display: 'none' }}
            onChange={(e) => {
              accept(e.target.files);
              // Cleared so choosing the same file twice fires a change event.
              e.target.value = '';
            }}
          />
        </div>
      )}

      {transfers.length > 0 ? (
        <ul className="stack gap-2">
          {transfers.map((t) => (
            <li key={t.key} className="stack gap-1">
              <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
                <span className="truncate">{t.file.name}</span>
                <span className="row gap-2">
                  <span className="muted small">{formatBytes(t.file.size)}</span>
                  {t.status === 'failed' ? (
                    <>
                      <Badge label="failed" tone="danger" />
                      <button className="btn btn--ghost btn--sm" onClick={() => void send(t)}>
                        Retry
                      </button>
                    </>
                  ) : t.status === 'done' ? (
                    <Badge label="uploaded" tone="ok" />
                  ) : (
                    <span className="muted small">{t.progress}%</span>
                  )}
                </span>
              </div>
              {t.status === 'sending' ? (
                <progress
                  max={100}
                  value={t.progress}
                  aria-label={`Uploading ${t.file.name}`}
                  style={{ width: '100%' }}
                />
              ) : null}
              {t.error ? (
                <span className="small" style={{ color: 'var(--danger)' }}>
                  {t.error}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {stored.data?.length ? (
        <ul className="stack gap-2">
          {stored.data.map((a) => (
            <li key={a.id} className="row gap-2" style={{ justifyContent: 'space-between' }}>
              <span className="row gap-2 truncate">
                {isImage(a.mimeType) && a.uploaded ? <Thumbnail id={a.id} /> : null}
                <span className="truncate">{a.fileName}</span>
                {a.uploaded ? null : <Badge label="incomplete" tone="warn" />}
              </span>
              <span className="row gap-2">
                <span className="muted small">{formatBytes(a.sizeBytes)}</span>
                {a.uploaded && (isImage(a.mimeType) || a.mimeType === 'application/pdf') ? (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void openBlob(a, 'view')}
                  >
                    Preview
                  </button>
                ) : null}
                {a.uploaded ? (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void openBlob(a, 'download')}
                  >
                    Download
                  </button>
                ) : null}
                {readOnly ? null : (
                  <button
                    className="btn btn--ghost btn--sm"
                    aria-label={`Remove ${a.fileName}`}
                    onClick={() => remove.mutate(a.id)}
                    disabled={remove.isPending}
                  >
                    ✕
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {preview ? (
        <div
          className="modal__backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            setPreview(null);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            setPreviewUrl(null);
          }}
        >
          <div
            className="card modal"
            role="dialog"
            aria-modal="true"
            aria-label={preview.fileName}
            style={{ width: 'min(900px, 100%)' }}
          >
            <div className="card__head">
              <h2 className="card__title truncate">{preview.fileName}</h2>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  setPreview(null);
                  if (previewUrl) URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                }}
              >
                Close
              </button>
            </div>
            <div className="card__body">
              {previewUrl === null ? null : isImage(preview.mimeType) ? (
                <img
                  src={previewUrl}
                  alt={preview.fileName}
                  style={{ maxWidth: '100%', maxHeight: '70vh' }}
                />
              ) : (
                <iframe
                  src={previewUrl}
                  title={preview.fileName}
                  style={{ width: '100%', height: '70vh', border: 0 }}
                />
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A thumbnail for an image attachment.
 *
 * Its own component because each one is a separate authenticated fetch, and
 * the object URL has to be released when the row goes away — a list that
 * scrolls would otherwise leak a blob per image.
 */
function Thumbnail({ id }: { id: string }): React.ReactElement | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;

    void api
      .blob(`/uploads/attachments/${id}/content`)
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (!url) return null;
  return (
    <img src={url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4 }} />
  );
}
