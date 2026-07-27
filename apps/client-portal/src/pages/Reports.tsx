/**
 * Finished work, and the reports that came out of it.
 *
 * Only the customer's own inspections reach this list — the API narrows by
 * `clientId` before the query runs, so there is no filtering to do here and no
 * way for the page to get it wrong.
 *
 * A report is generated on demand rather than stored. That keeps a signed-off
 * inspection and its report from drifting apart, and means a customer who
 * downloads the same report twice a year apart gets the same document either
 * time.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import { Shell } from '../components/Shell';
import { Card, Empty, formatDate, Loading, Notice, StatusBadge } from '../components/ui';
import { api } from '../lib/api';

interface Inspection {
  id: string;
  number: string;
  title: string | null;
  status: string;
  completedAt: string | null;
  submittedAt: string | null;
  updatedAt: string;
  score: number | null;
  result: string | null;
  site: { id: string; name: string } | null;
  template: { id: string; name: string } | null;
}

/** Only work that has been signed off produces a report worth downloading. */
const FINISHED = ['APPROVED', 'COMPLETED'];

export function Reports(): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  const inspections = useQuery({
    queryKey: ['inspections'],
    queryFn: () =>
      api.get<{ items: Inspection[] }>('/inspections', {
        page: 1,
        pageSize: 100,
        sort: '-updatedAt',
      }),
  });

  const download = useMutation({
    mutationFn: async ({
      inspection,
      format,
    }: {
      inspection: Inspection;
      format: 'pdf' | 'xlsx';
    }) => {
      setDownloading(inspection.id);
      // The API is on another origin and needs a bearer token, so the bytes
      // are fetched and turned into an object URL — a plain link would send no
      // credentials and resolve against the portal.
      const blob = await api.blob(`/reports/inspection/${inspection.id}?format=${format}`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${inspection.number}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onSettled: () => setDownloading(null),
    onError: (e) => setError(e instanceof Error ? e.message : 'That report could not be produced.'),
  });

  const items = inspections.data?.items ?? [];
  const ready = items.filter((i) => FINISHED.includes(i.status));
  const pending = items.filter((i) => !FINISHED.includes(i.status));

  return (
    <Shell title="Reports" subtitle="Inspection reports for your sites, ready to download.">
      {error && <Notice>{error}</Notice>}
      {inspections.isError && <Notice>Your reports could not be loaded. Try reloading.</Notice>}

      <Card title="Available reports" flush>
        {inspections.isLoading ? (
          <Loading />
        ) : ready.length === 0 ? (
          <Empty
            title="No reports yet"
            action={
              <Link className="btn btn--primary" to="/client/request/new">
                Request an inspection
              </Link>
            }
          >
            A report appears here once an inspection has been carried out and signed off.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Inspection</th>
                  <th>Site</th>
                  <th>Result</th>
                  <th>Completed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ready.map((inspection) => (
                  <tr key={inspection.id}>
                    <td className="table__ref">{inspection.number}</td>
                    <td>
                      {inspection.title ?? inspection.template?.name ?? 'Inspection'}
                      {inspection.score !== null && (
                        <div className="faint">Score {Math.round(inspection.score)}%</div>
                      )}
                    </td>
                    <td className="muted">{inspection.site?.name ?? '—'}</td>
                    <td>{inspection.result ? <StatusBadge status={inspection.result} /> : '—'}</td>
                    <td className="muted">
                      {formatDate(inspection.completedAt ?? inspection.updatedAt)}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <button
                          type="button"
                          className="btn btn--sm btn--primary"
                          disabled={downloading === inspection.id}
                          onClick={() => download.mutate({ inspection, format: 'pdf' })}
                        >
                          {downloading === inspection.id ? 'Preparing…' : 'PDF'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={downloading === inspection.id}
                          onClick={() => download.mutate({ inspection, format: 'xlsx' })}
                        >
                          Excel
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pending.length > 0 && (
        <Card title="Still in progress" flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Inspection</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((inspection) => (
                  <tr key={inspection.id}>
                    <td className="table__ref">{inspection.number}</td>
                    <td>{inspection.title ?? inspection.template?.name ?? 'Inspection'}</td>
                    <td className="muted">{inspection.site?.name ?? '—'}</td>
                    <td>
                      <StatusBadge status={inspection.status} />
                    </td>
                    <td className="muted">{formatDate(inspection.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </Shell>
  );
}
