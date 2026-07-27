/**
 * Export what is on screen.
 *
 * Every list had a search box and filters and no way to take the result away —
 * the only export lived in Reports, which exports a whole dataset and ignores
 * whatever the person was looking at.
 *
 * The query in force is passed through to the server, so a filtered view
 * downloads filtered. An export that quietly ignores the filters is worse than
 * no export at all, because nobody checks the row count against what they
 * expected before sending it to a client.
 *
 * Print opens the browser's dialog on the current page rather than generating
 * anything: the table is already laid out, and a second rendering path is a
 * second thing to keep in step with the first.
 */

import React, { useState } from 'react';

import { api } from '../lib/api';
import { ErrorBanner } from './ui';

/** Datasets the reports endpoint knows how to render. */
export type ExportDataset =
  'inspections' | 'inspectors' | 'sites' | 'users' | 'devices' | 'audit' | 'clients' | 'projects';

/** Query keys the export endpoint accepts; anything else is a list-only concern. */
const EXPORTABLE = new Set(['search', 'from', 'to', 'projectId', 'siteId', 'templateId', 'limit']);

export function ExportMenu({
  dataset,
  query,
  label = 'Export',
}: {
  dataset: ExportDataset;
  /** The query in force. Only scalar values ever reach a query string. */
  query: Record<string, string | number | boolean | undefined | null>;
  label?: string;
}): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (format: 'csv' | 'xlsx' | 'pdf'): Promise<void> => {
    setBusy(format);
    setError(null);
    try {
      const params = new URLSearchParams({ format });
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        if (!EXPORTABLE.has(k)) continue;
        params.set(k, typeof v === 'string' ? v : String(v));
      }

      const blob = await api.blob(`/reports/export/${dataset}?${params.toString()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${dataset}-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      // Released on the next tick: revoking synchronously cancels the download
      // in some browsers before it has started.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="row gap-1" role="group" aria-label={label}>
        {(['csv', 'xlsx', 'pdf'] as const).map((f) => (
          <button
            key={f}
            className="btn btn--ghost btn--sm"
            onClick={() => void download(f)}
            disabled={busy !== null}
          >
            {busy === f ? '…' : f.toUpperCase()}
          </button>
        ))}
        <button
          className="btn btn--ghost btn--sm"
          onClick={() => globalThis.print()}
          disabled={busy !== null}
        >
          Print
        </button>
      </div>
    </>
  );
}
