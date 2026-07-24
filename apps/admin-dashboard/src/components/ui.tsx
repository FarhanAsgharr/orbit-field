/**
 * Console primitives.
 *
 * Presentation mappings (status → badge) are duplicated from the mobile app on
 * purpose: an operator and an inspector discussing an inspection must see the
 * same word, the same colour, and the same glyph. The wire values are shared via
 * @orbit/types; only the rendering differs per platform.
 */

import React from 'react';
import { InspectionOutcome, InspectionStatus, type Priority } from '@orbit/types';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info';

export function Badge({
  label,
  tone = 'neutral',
  glyph,
}: {
  label: string;
  tone?: Tone;
  glyph?: string;
}): React.ReactElement {
  return (
    <span className={`badge badge--${tone}`}>
      {glyph ? (
        <span className="badge__glyph" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      {label}
    </span>
  );
}

export function statusBadge(status: string): { label: string; tone: Tone; glyph: string } {
  switch (status) {
    case InspectionStatus.DRAFT: return { label: 'Draft', tone: 'neutral', glyph: '○' };
    case InspectionStatus.SCHEDULED: return { label: 'Scheduled', tone: 'info', glyph: '◔' };
    case InspectionStatus.IN_PROGRESS: return { label: 'In progress', tone: 'accent', glyph: '◑' };
    case InspectionStatus.SUBMITTED: return { label: 'Submitted', tone: 'info', glyph: '↑' };
    case InspectionStatus.UNDER_REVIEW: return { label: 'Under review', tone: 'warn', glyph: '◐' };
    case InspectionStatus.APPROVED: return { label: 'Approved', tone: 'ok', glyph: '✓' };
    case InspectionStatus.REJECTED: return { label: 'Rejected', tone: 'danger', glyph: '↺' };
    case InspectionStatus.CANCELLED: return { label: 'Cancelled', tone: 'neutral', glyph: '✕' };
    case InspectionStatus.ARCHIVED: return { label: 'Archived', tone: 'neutral', glyph: '▣' };
    default: return { label: status, tone: 'neutral', glyph: '•' };
  }
}

export function outcomeBadge(outcome: string): { label: string; tone: Tone; glyph: string } {
  switch (outcome) {
    case InspectionOutcome.PASS: return { label: 'Pass', tone: 'ok', glyph: '✓' };
    case InspectionOutcome.PASS_WITH_OBSERVATIONS: return { label: 'Observations', tone: 'warn', glyph: '!' };
    case InspectionOutcome.FAIL: return { label: 'Fail', tone: 'danger', glyph: '✕' };
    case InspectionOutcome.NOT_APPLICABLE: return { label: 'N/A', tone: 'neutral', glyph: '–' };
    default: return { label: 'Pending', tone: 'neutral', glyph: '○' };
  }
}

export function priorityBadge(priority: Priority | string): { label: string; tone: Tone; glyph: string } {
  switch (priority) {
    case 'CRITICAL': return { label: 'Critical', tone: 'danger', glyph: '▲' };
    case 'HIGH': return { label: 'High', tone: 'warn', glyph: '▲' };
    case 'LOW': return { label: 'Low', tone: 'neutral', glyph: '▼' };
    default: return { label: 'Normal', tone: 'neutral', glyph: '■' };
  }
}

export function roleBadge(role: string): { label: string; tone: Tone } {
  const label = role.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  if (role === 'SUPER_ADMIN' || role === 'ADMIN') return { label, tone: 'danger' };
  if (role === 'MANAGER' || role === 'SUPERVISOR') return { label, tone: 'accent' };
  if (role === 'VIEWER') return { label, tone: 'neutral' };
  return { label, tone: 'info' };
}

export function Card({
  title,
  action,
  children,
  flush,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}): React.ReactElement {
  return (
    <section className="card">
      {title || action ? (
        <header className="card__head">
          {title ? <h2 className="card__title">{title}</h2> : <span />}
          {action}
        </header>
      ) : null}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
    </section>
  );
}

export function Metric({
  value,
  label,
  tone,
  delta,
}: {
  value: string | number;
  label: string;
  tone?: Tone;
  delta?: string;
}): React.ReactElement {
  const colour =
    tone === 'ok' ? 'var(--ok)'
    : tone === 'warn' ? 'var(--warn)'
    : tone === 'danger' ? 'var(--danger)'
    : tone === 'accent' ? 'var(--accent)'
    : 'var(--ink)';

  return (
    <div className="card">
      <div className="card__body">
        <div className="metric__value num" style={{ color: colour }}>
          {value}
        </div>
        <div className="metric__label">{label}</div>
        {delta ? <div className="metric__delta">{delta}</div> : null}
      </div>
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {body ? <p className="empty__body">{body}</p> : null}
      {action}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }): React.ReactElement {
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}

export function Loading({ rows = 5 }: { rows?: number }): React.ReactElement {
  return (
    <div className="stack gap-3" style={{ padding: 'var(--s-5)' }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - i * 7}%` }} />
      ))}
    </div>
  );
}

export function Bar({ value, tone = 'accent' }: { value: number; tone?: Tone }): React.ReactElement {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const colour =
    tone === 'ok' ? 'var(--ok)'
    : tone === 'warn' ? 'var(--warn)'
    : tone === 'danger' ? 'var(--danger)'
    : 'var(--accent)';

  return (
    <div
      className="bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
    >
      <div className="bar__fill" style={{ width: `${clamped * 100}%`, background: colour }} />
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}): React.ReactElement | null {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="pagination">
      <span>
        <span className="num">{first}</span>–<span className="num">{last}</span> of{' '}
        <span className="num">{total}</span>
      </span>
      <div className="row gap-2">
        <button
          className="btn btn--secondary btn--sm"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
        >
          Previous
        </button>
        <span className="small muted">
          Page <span className="num">{page}</span> of <span className="num">{pages}</span>
        </span>
        <button
          className="btn btn--secondary btn--sm"
          onClick={() => onPage(page + 1)}
          disabled={page >= pages}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Relative time that degrades to an absolute date beyond a week. */
export function relativeTime(value: string | Date | null | undefined): string {
  if (!value) return 'Never';
  const then = typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (Number.isNaN(then)) return '—';

  const diff = then - Date.now();
  const abs = Math.abs(diff);

  if (abs < 45_000) return 'just now';
  if (abs > 7 * 86_400_000) {
    return new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' }).format(then);
  }

  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60_000, 'minute'],
    [3_600_000, 'hour'],
    [86_400_000, 'day'],
  ];
  let divisor = 1_000;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [limit, u] of units) {
    if (abs < limit) break;
    divisor = limit;
    unit = u;
  }

  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    Math.round(diff / divisor),
    unit,
  );
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function initials(first?: string, last?: string): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase() || '?';
}
