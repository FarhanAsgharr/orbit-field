/**
 * Overview.
 *
 * Ordered by what an operator needs to act on, not by what is easiest to
 * aggregate: anything requiring a decision first, fleet health second, work
 * throughput third. A conflict that nobody resolves blocks an inspector's queue,
 * so it sits above the charts.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Permission } from '@orbit/shared';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { CursorLagRail, useSyncHealth } from '../components/Shell';
import { Bar, Card, Empty, ErrorBanner, Loading, Metric, relativeTime, statusBadge, Badge } from '../components/ui';

interface Summary {
  total: number;
  statusCounts: Record<string, number>;
  outcomeCounts: Record<string, number>;
  completed: number;
  failed: number;
  overdue: number;
  dueToday: number;
  completionRate: number;
  failureRate: number;
  averageScore: number | null;
  averageDurationMinutes: number | null;
}

interface InspectionRow {
  id: string;
  number: string;
  title: string;
  status: string;
  updatedAt: string;
  site: { name: string } | null;
  assignedTo: { firstName: string; lastName: string } | null;
}

export function Overview(): React.ReactElement {
  const { can, user } = useSession();
  const { data: health, isLoading: healthLoading } = useSyncHealth();

  const { data: summary, isError, error } = useQuery<Summary>({
    queryKey: ['analytics-summary'],
    queryFn: () => api.get<Summary>('/analytics/summary'),
    enabled: can(Permission.ANALYTICS_READ),
  });

  const { data: recent } = useQuery<{ items: InspectionRow[] }>({
    queryKey: ['recent-inspections'],
    queryFn: () => api.get<{ items: InspectionRow[] }>('/inspections', { pageSize: 8, sortBy: 'updatedAt', sortDir: 'desc' }),
    enabled: can(Permission.INSPECTION_READ),
  });

  const conflicts = health?.unresolvedConflicts ?? 0;
  const stale = health?.devices.filter((d) => d.stale).length ?? 0;

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Good {timeOfDay()}, {user?.firstName}</h1>
          <p className="page__subtitle">
            {conflicts === 0 && stale === 0
              ? 'Nothing needs your attention right now.'
              : 'Some items need a decision before field work can complete.'}
          </p>
        </div>
      </header>

      {isError ? (
        <ErrorBanner message={error instanceof Error ? error.message : 'Could not load the overview.'} />
      ) : null}

      {/* --- things needing action, first --- */}
      {conflicts > 0 || stale > 0 ? (
        <div className="grid grid--2 mt-4" style={{ marginBottom: 'var(--s-6)' }}>
          {conflicts > 0 ? (
            <Card>
              <div className="row gap-4">
                <div className="grow">
                  <div className="metric__value num" style={{ color: 'var(--danger)' }}>{conflicts}</div>
                  <div className="metric__label">Conflicts awaiting a decision</div>
                  <p className="small muted mt-2">
                    Two people changed the same record while one was offline. Nothing has been
                    overwritten — the change stays queued until somebody chooses.
                  </p>
                </div>
                <Link className="btn" to="/sync">Review</Link>
              </div>
            </Card>
          ) : null}

          {stale > 0 ? (
            <Card>
              <div className="row gap-4">
                <div className="grow">
                  <div className="metric__value num" style={{ color: 'var(--warn)' }}>{stale}</div>
                  <div className="metric__label">Devices silent for 24 hours</div>
                  <p className="small muted mt-2">
                    Work on these devices has not reached the server. Often just a device that is
                    off, but worth confirming before an audit.
                  </p>
                </div>
                <Link className="btn btn--secondary" to="/devices">Check</Link>
              </div>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* --- fleet health: the signature view --- */}
      {can(Permission.AUDIT_READ) ? (
        <Card title="Fleet position" flush>
          {healthLoading ? (
            <Loading rows={3} />
          ) : health ? (
            <CursorLagRail health={health} />
          ) : (
            <Empty title="Fleet data unavailable" body="Sync health could not be loaded." />
          )}
        </Card>
      ) : null}

      {/* --- throughput --- */}
      {can(Permission.ANALYTICS_READ) && summary ? (
        <>
          <div className="grid grid--4 mt-6">
            <Metric value={summary.total.toLocaleString()} label="Inspections (30 days)" />
            <Metric
              value={`${summary.completionRate}%`}
              label="Completion rate"
              tone={summary.completionRate >= 80 ? 'ok' : summary.completionRate >= 50 ? 'warn' : 'danger'}
            />
            <Metric
              value={`${summary.failureRate}%`}
              label="Failure rate"
              tone={summary.failureRate > 20 ? 'danger' : summary.failureRate > 10 ? 'warn' : 'ok'}
            />
            <Metric
              value={summary.overdue.toLocaleString()}
              label="Overdue"
              tone={summary.overdue > 0 ? 'danger' : 'ok'}
              delta={summary.dueToday > 0 ? `${summary.dueToday} due today` : undefined}
            />
          </div>

          <div className="grid grid--2 mt-6">
            <Card title="Work in progress">
              <div className="stack gap-4">
                {Object.entries(summary.statusCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => {
                    const badge = statusBadge(status);
                    const share = summary.total > 0 ? count / summary.total : 0;
                    return (
                      <div key={status} className="stack gap-2">
                        <div className="row gap-3">
                          <Badge label={badge.label} tone={badge.tone} glyph={badge.glyph} />
                          <span className="right num strong">{count.toLocaleString()}</span>
                        </div>
                        <Bar value={share} tone={badge.tone === 'danger' ? 'danger' : 'accent'} />
                      </div>
                    );
                  })}
                {Object.keys(summary.statusCounts).length === 0 ? (
                  <p className="muted small">No inspections in this period.</p>
                ) : null}
              </div>
            </Card>

            <Card title="Quality">
              <div className="stack gap-5">
                <div>
                  <div className="metric__value num">
                    {summary.averageScore !== null ? `${summary.averageScore}%` : '—'}
                  </div>
                  <div className="metric__label">Average score</div>
                </div>
                <div>
                  <div className="metric__value num">
                    {summary.averageDurationMinutes !== null
                      ? formatDuration(summary.averageDurationMinutes)
                      : '—'}
                  </div>
                  <div className="metric__label">Average time on site</div>
                  <p className="small muted mt-2">
                    Measured from first answer to submission. Only completed inspections count.
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </>
      ) : null}

      {/* --- recent activity --- */}
      {can(Permission.INSPECTION_READ) ? (
        <div className="mt-6">
          <Card
            title="Recently updated"
            action={<Link className="btn btn--ghost btn--sm" to="/inspections">See all</Link>}
            flush
          >
            {!recent ? (
              <Loading rows={4} />
            ) : recent.items.length === 0 ? (
              <Empty title="No inspections yet" body="Work created in the field app appears here." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Inspection</th>
                      <th>Site</th>
                      <th>Inspector</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.items.map((row) => {
                      const badge = statusBadge(row.status);
                      return (
                        <tr key={row.id}>
                          <td className="num small">{row.number}</td>
                          <td className="table__primary">
                            <Link to={`/inspections/${row.id}`}>{row.title}</Link>
                          </td>
                          <td className="table__meta">{row.site?.name ?? '—'}</td>
                          <td className="table__meta">
                            {row.assignedTo
                              ? `${row.assignedTo.firstName} ${row.assignedTo.lastName}`
                              : 'Unassigned'}
                          </td>
                          <td><Badge label={badge.label} tone={badge.tone} glyph={badge.glyph} /></td>
                          <td className="table__num table__meta">{relativeTime(row.updatedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      ) : null}
    </>
  );
}

function timeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
