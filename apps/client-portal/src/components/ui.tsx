/**
 * The portal's small set of repeated pieces.
 *
 * Kept to what is actually reused twice or more. A component library for a
 * seven-screen app is overhead, not architecture.
 */

import React from 'react';

export function Card({
  title,
  action,
  children,
  flush,
  footer,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
  footer?: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card__header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {action}
        </header>
      )}
      <div className={flush ? 'card__body card__body--flush' : 'card__body'}>{children}</div>
      {footer && <footer className="card__footer">{footer}</footer>}
    </section>
  );
}

export function Field({
  label,
  required,
  hint,
  error,
  children,
  full,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  full?: boolean;
}): React.ReactElement {
  return (
    <label className={full ? 'field form-grid--full' : 'field'}>
      <span className="field__label">
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        )}
      </span>
      {children}
      {error ? (
        <span className="field__error">{error}</span>
      ) : hint ? (
        <span className="field__hint">{hint}</span>
      ) : null}
    </label>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }): React.ReactElement {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function Notice({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'ok' | 'info';
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={`notice notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/**
 * Status colouring.
 *
 * A customer reads these as traffic lights, so the mapping is by meaning
 * rather than by workflow position: anything finished is green, anything
 * refused or cancelled is red, work under way is blue, and waiting is amber.
 */
export function StatusBadge({ status }: { status: string }): React.ReactElement {
  const label = status
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

  const tone =
    status === 'APPROVED' || status === 'COMPLETED' || status === 'APPROVED_FINAL'
      ? 'ok'
      : status === 'REJECTED' || status === 'CANCELLED' || status === 'REWORK_REQUIRED'
        ? 'danger'
        : status === 'SUBMITTED' || status === 'PENDING' || status === 'IN_REVIEW'
          ? 'warn'
          : status === 'IN_PROGRESS' || status === 'ASSIGNED' || status === 'DRAFT'
            ? 'info'
            : 'default';

  return <span className={tone === 'default' ? 'badge' : `badge badge--${tone}`}>{label}</span>;
}

export function PriorityBadge({ priority }: { priority: string }): React.ReactElement {
  const tone =
    priority === 'CRITICAL' || priority === 'URGENT'
      ? 'danger'
      : priority === 'HIGH'
        ? 'warn'
        : priority === 'LOW'
          ? 'default'
          : 'info';
  const label = priority.charAt(0) + priority.slice(1).toLowerCase();
  return <span className={tone === 'default' ? 'badge' : `badge badge--${tone}`}>{label}</span>;
}

/** Initials for an avatar placeholder. */
export function initials(...parts: Array<string | null | undefined>): string {
  const letters = parts
    .filter((p): p is string => Boolean(p?.trim()))
    .flatMap((p) => p.trim().split(/\s+/))
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase());
  return letters.join('') || '?';
}

/** Dates the way a customer reads them, not an ISO string. */
export function formatDate(value: string | null | undefined, withTime = false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

/** "3 days ago" for a message list, where exact timestamps are noise. */
export function relativeTime(value: string | null | undefined): string {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(-Math.round(seconds / size), unit);
  }
  return format.format(-seconds, 'second');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
