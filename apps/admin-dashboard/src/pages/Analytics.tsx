/**
 * Analytics.
 *
 * Charts follow one rule throughout: a metric and its axis mean the same thing
 * on every chart on the page. Failure is always the same red, completion always
 * the same green, and the y-axis of a rate chart is always 0–100. An operator
 * comparing two charts should never have to re-read the axis.
 */

import { Permission } from '@orbit/shared';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Card, Empty, ErrorBanner, Loading, Metric } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

type Period = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

interface Summary {
  total: number;
  completed: number;
  failed: number;
  overdue: number;
  dueToday: number;
  completionRate: number;
  failureRate: number;
  averageScore: number | null;
  averageDurationMinutes: number | null;
  statusCounts: Record<string, number>;
}

interface TrendPoint {
  bucket: string;
  total: number;
  completed: number;
  failed: number;
  passed: number;
}
interface InspectorRow {
  userId: string;
  name: string;
  assigned: number;
  completed: number;
  failed: number;
  completionRate: number;
  averageScore: number | null;
  averageDurationMinutes: number | null;
  onTimeRate: number | null;
}
interface SiteRow {
  siteId: string;
  name: string;
  total: number;
  failed: number;
  failureRate: number;
  averageScore: number | null;
  lastInspectedAt: string | null;
}

/* Chart colours resolve from the design tokens so light and dark agree. */
const INK = 'var(--ink-muted)';

export function Analytics(): React.ReactElement {
  const { can } = useSession();
  const [period, setPeriod] = useState<Period>('WEEKLY');
  const [days, setDays] = useState(90);

  const range = {
    from: new Date(Date.now() - days * 86_400_000).toISOString(),
    to: new Date().toISOString(),
  };

  const summary = useQuery<Summary>({
    queryKey: ['analytics', 'summary', days],
    queryFn: () => api.get<Summary>('/analytics/summary', range),
  });

  const trend = useQuery<TrendPoint[]>({
    queryKey: ['analytics', 'trend', period, days],
    queryFn: () => api.get<TrendPoint[]>('/analytics/trend', { ...range, period }),
  });

  const inspectors = useQuery<InspectorRow[]>({
    queryKey: ['analytics', 'inspectors', days],
    queryFn: () => api.get<InspectorRow[]>('/analytics/inspectors', range),
    enabled: can(Permission.ANALYTICS_READ_ALL),
  });

  const sites = useQuery<SiteRow[]>({
    queryKey: ['analytics', 'sites', days],
    queryFn: () => api.get<SiteRow[]>('/analytics/sites', range),
    enabled: can(Permission.ANALYTICS_READ_ALL),
  });

  const bucketLabel = (iso: string): string => {
    const date = new Date(iso);
    if (period === 'YEARLY') return String(date.getFullYear());
    if (period === 'MONTHLY' || period === 'QUARTERLY') {
      return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short' }).format(date);
  };

  const exportUrl = `/api/v1/analytics/export/inspections.csv?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Analytics</h1>
          <p className="page__subtitle">Throughput, quality, and where failures concentrate.</p>
        </div>
        <div className="row gap-3 wrap">
          <select
            className="select"
            style={{ width: 'auto' }}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Period"
          >
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <select
            className="select"
            style={{ width: 'auto' }}
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            aria-label="Grouping"
          >
            <option value="DAILY">By day</option>
            <option value="WEEKLY">By week</option>
            <option value="MONTHLY">By month</option>
            <option value="QUARTERLY">By quarter</option>
          </select>
          {/* A plain link, so the browser's own download machinery handles a
              large export rather than buffering it in a blob. */}
          <a className="btn btn--secondary" href={exportUrl} download>
            Export CSV
          </a>
        </div>
      </header>

      {summary.isError ? (
        <ErrorBanner
          message={
            summary.error instanceof Error ? summary.error.message : 'Could not load analytics.'
          }
        />
      ) : null}

      {summary.data ? (
        <div className="grid grid--4">
          <Metric value={summary.data.total.toLocaleString()} label="Inspections" />
          <Metric
            value={`${summary.data.completionRate}%`}
            label="Completion rate"
            tone={summary.data.completionRate >= 80 ? 'ok' : 'warn'}
          />
          <Metric
            value={`${summary.data.failureRate}%`}
            label="Failure rate"
            tone={
              summary.data.failureRate > 20
                ? 'danger'
                : summary.data.failureRate > 10
                  ? 'warn'
                  : 'ok'
            }
          />
          <Metric
            value={summary.data.averageScore !== null ? `${summary.data.averageScore}%` : '—'}
            label="Average score"
          />
        </div>
      ) : (
        <Loading rows={2} />
      )}

      <div className="mt-6">
        <Card title="Volume over time">
          {trend.isLoading ? (
            <Loading rows={4} />
          ) : !trend.data || trend.data.length === 0 ? (
            <Empty title="No data in this period" body="Try a longer window." />
          ) : (
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend.data.map((p) => ({ ...p, label: bucketLabel(p.bucket) }))}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke={INK}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke={INK}
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--line-strong)',
                      borderRadius: 'var(--r-md)',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="total"
                    name="Created"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="completed"
                    name="Completed"
                    stroke="var(--ok)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="failed"
                    name="Failed"
                    stroke="var(--danger)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {can(Permission.ANALYTICS_READ_ALL) ? (
        <>
          <div className="grid grid--2 mt-6">
            <Card title="Where failures concentrate" flush>
              {sites.isLoading ? (
                <Loading rows={4} />
              ) : !sites.data || sites.data.length === 0 ? (
                <Empty title="No site data" />
              ) : (
                <>
                  <div style={{ height: 240, padding: 'var(--s-4)' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart
                        data={sites.data
                          .slice(0, 8)
                          .map((s) => ({ name: s.name, rate: s.failureRate }))}
                        layout="vertical"
                        margin={{ left: 8, right: 16 }}
                      >
                        <CartesianGrid stroke="var(--line)" horizontal={false} />
                        {/* Fixed 0–100: a rate chart whose axis rescales per
                            dataset invites false comparisons between screens. */}
                        <XAxis
                          type="number"
                          domain={[0, 100]}
                          unit="%"
                          stroke={INK}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="name"
                          width={140}
                          stroke={INK}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip
                          formatter={(v: number) => [`${v}%`, 'Failure rate']}
                          contentStyle={{
                            background: 'var(--surface)',
                            border: '1px solid var(--line-strong)',
                            borderRadius: 'var(--r-md)',
                            fontSize: 12,
                          }}
                        />
                        <Bar dataKey="rate" radius={[0, 3, 3, 0]}>
                          {sites.data.slice(0, 8).map((s) => (
                            <Cell
                              key={s.siteId}
                              fill={
                                s.failureRate > 25
                                  ? 'var(--danger)'
                                  : s.failureRate > 10
                                    ? 'var(--warn)'
                                    : 'var(--ok)'
                              }
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Site</th>
                          <th style={{ textAlign: 'right' }}>Inspections</th>
                          <th style={{ textAlign: 'right' }}>Failed</th>
                          <th style={{ textAlign: 'right' }}>Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sites.data.slice(0, 10).map((site) => (
                          <tr key={site.siteId}>
                            <td className="table__primary">{site.name}</td>
                            <td className="table__num num">{site.total}</td>
                            <td className="table__num num">{site.failed}</td>
                            <td
                              className="table__num num"
                              style={{ color: site.failureRate > 25 ? 'var(--danger)' : undefined }}
                            >
                              {site.failureRate}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>

            <Card title="Inspector throughput" flush>
              {inspectors.isLoading ? (
                <Loading rows={4} />
              ) : !inspectors.data || inspectors.data.length === 0 ? (
                <Empty title="No inspector activity in this period" />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Inspector</th>
                        <th style={{ textAlign: 'right' }}>Assigned</th>
                        <th style={{ textAlign: 'right' }}>Done</th>
                        <th style={{ textAlign: 'right' }}>Avg score</th>
                        <th style={{ textAlign: 'right' }}>On time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspectors.data.map((row) => (
                        <tr key={row.userId}>
                          <td className="table__primary">{row.name}</td>
                          <td className="table__num num">{row.assigned}</td>
                          <td className="table__num num">{row.completed}</td>
                          <td className="table__num num">
                            {row.averageScore !== null ? `${row.averageScore}%` : '—'}
                          </td>
                          <td className="table__num num">
                            {/* Null, not 0%: nothing had a due date, which is
                                not the same as nothing being on time. */}
                            {row.onTimeRate !== null ? (
                              `${row.onTimeRate}%`
                            ) : (
                              <span className="muted">n/a</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
