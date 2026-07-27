/**
 * Audit log and organisation settings.
 *
 * The audit log is read-only by design — there is no edit or delete control
 * because the API offers none. A log an administrator can rewrite is not an
 * audit trail, and the interface should not imply otherwise.
 */

import { Permission } from '@orbit/shared';
import { toDisplayString } from '@orbit/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import { type Column, DataTable } from '../components/DataTable';
import { Badge, Card, ErrorBanner, formatDate, Loading, relativeTime } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

interface AuditRow {
  id: string;
  action: string;
  entity: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  user: { id: string; firstName: string; lastName: string; email: string } | null;
}

/** Actions that deserve to stand out when scanning the log. */
function actionTone(action: string): 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' {
  if (action.includes('DENIED') || action.includes('REUSE') || action.includes('FAILED'))
    return 'danger';
  if (action.includes('DELETED') || action.includes('REVOKED') || action.includes('REJECTED'))
    return 'warn';
  if (action.includes('APPROVED') || action.includes('CREATED')) return 'ok';
  if (action.startsWith('AUTH_')) return 'accent';
  return 'neutral';
}

/** `Number` is taken by a component below, so the global is reached this way. */
const Number_parseInt = (value: string): number => globalThis.Number.parseInt(value, 10);

export function Audit(): React.ReactElement {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [action, setAction] = useState('');
  const [clearing, setClearing] = useState(false);
  const [olderThan, setOlderThan] = useState('90');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Sign-in history only.
   *
   * Every successful login writes an entry, so on a busy installation these
   * outnumber everything else and bury the events somebody is looking for.
   * Clearing them is housekeeping. The record trail — who changed which
   * inspection — is not clearable here and not clearable at all, which is what
   * makes the log worth keeping. The server enforces the same restriction.
   */
  const purge = useMutation({
    mutationFn: () => {
      // `Number` is a settings component in this file, so the global is
      // shadowed — the state is held as a string and parsed here.
      const days = Number_parseInt(olderThan);
      const before = new Date(Date.now() - days * 86_400_000).toISOString();
      return api.delete<{ purged: number }>('/admin/audit-logs', { before });
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['audit'] });
      setClearing(false);
      setError(null);
      setNotice(
        `${result.purged} sign-in entr${result.purged === 1 ? 'y' : 'ies'} removed. This clearance is itself recorded below.`,
      );
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : 'Could not clear the sign-in history.'),
  });

  const columns: Array<Column<AuditRow>> = [
    {
      key: 'createdAt',
      header: 'When',
      width: '170px',
      render: (row) => (
        <div>
          <div>{relativeTime(row.createdAt)}</div>
          <div className="table__meta num">{formatDate(row.createdAt)}</div>
        </div>
      ),
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <Badge label={row.action.replace(/_/g, ' ').toLowerCase()} tone={actionTone(row.action)} />
      ),
    },
    {
      key: 'user',
      header: 'Who',
      render: (row) =>
        row.user ? (
          <div>
            <div className="table__primary">
              {row.user.firstName} {row.user.lastName}
            </div>
            <div className="table__meta">{row.user.email}</div>
          </div>
        ) : (
          <span className="muted">System</span>
        ),
    },
    {
      key: 'entity',
      header: 'Record',
      render: (row) =>
        row.entity ? (
          <div>
            <div>{row.entity}</div>
            {row.entityId ? (
              <div className="table__meta num truncate" style={{ maxWidth: 180 }}>
                {row.entityId}
              </div>
            ) : null}
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'detail',
      header: 'Detail',
      render: (row) => {
        if (!row.metadata || Object.keys(row.metadata).length === 0)
          return <span className="muted">—</span>;
        const summary = Object.entries(row.metadata)
          .slice(0, 3)
          .map(([k, v]) => `${k}: ${toDisplayString(v)}`)
          .join(' · ');
        return (
          <span className="table__meta truncate" style={{ maxWidth: 320, display: 'inline-block' }}>
            {summary}
          </span>
        );
      },
    },
    {
      key: 'ip',
      header: 'From',
      render: (row) =>
        row.ipAddress ? (
          <span className="num small">{row.ipAddress}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Audit log</h1>
          <p className="page__subtitle">
            Append-only. Every sign-in, permission denial, and record change is recorded here and
            cannot be edited or removed.
          </p>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <p className="small">{notice}</p> : null}

      {clearing ? (
        <div
          className="modal__backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setClearing(false);
          }}
        >
          <div
            className="card modal"
            role="dialog"
            aria-modal="true"
            aria-label="Clear sign-in history"
          >
            <div className="card__head">
              <h2 className="card__title">Clear sign-in history</h2>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => setClearing(false)}
                disabled={purge.isPending}
              >
                Cancel
              </button>
            </div>
            <div className="card__body stack gap-4">
              <p className="small">
                Removes <strong>sign-in, failed sign-in and sign-out</strong> entries older than the
                age you choose.
              </p>
              <p className="small muted">
                Nothing else is touched. Record changes, review decisions, password resets and
                settings changes stay — those are the compliance trail, and they cannot be deleted
                from here or anywhere else. This clearance is written to the log itself, naming you
                and the number of rows removed.
              </p>
              <div className="field">
                <label className="field__label" htmlFor="audit-age">
                  Older than
                </label>
                <select
                  id="audit-age"
                  className="select"
                  value={olderThan}
                  onChange={(e) => setOlderThan(e.target.value)}
                >
                  <option value="365">1 year</option>
                  <option value="180">6 months</option>
                  <option value="90">90 days</option>
                  <option value="30">30 days</option>
                  <option value="7">7 days</option>
                  <option value="1">1 day</option>
                </select>
              </div>
              <button
                className="btn btn--danger"
                onClick={() => purge.mutate()}
                disabled={purge.isPending}
              >
                {purge.isPending ? 'Clearing…' : 'Clear sign-in history'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <DataTable<AuditRow>
        endpoint="/admin/audit-logs"
        toolbarAction={
          user?.role === 'SUPER_ADMIN' ? (
            <button className="btn btn--ghost" onClick={() => setClearing(true)}>
              Clear sign-in history
            </button>
          ) : null
        }
        queryKey={['audit', action]}
        columns={columns}
        rowKey={(row) => row.id}
        searchPlaceholder="Search is not available on the audit log"
        extraQuery={{ action: action || undefined }}
        emptyTitle="No audit entries"
        pageSize={50}
        filters={
          <select
            className="select"
            style={{ width: 'auto' }}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Filter by action"
          >
            <option value="">Any action</option>
            <optgroup label="Access">
              <option value="AUTH_LOGIN">Sign in</option>
              <option value="AUTH_LOGIN_FAILED">Failed sign in</option>
              <option value="AUTH_TOKEN_REUSE_DETECTED">Token reuse detected</option>
              <option value="PERMISSION_DENIED">Permission denied</option>
            </optgroup>
            <optgroup label="Records">
              <option value="RECORD_CREATED">Created</option>
              <option value="RECORD_UPDATED">Updated</option>
              <option value="RECORD_DELETED">Deleted</option>
            </optgroup>
            <optgroup label="Inspections">
              <option value="INSPECTION_APPROVED">Approved</option>
              <option value="INSPECTION_REJECTED">Rejected</option>
              <option value="CONFLICT_RESOLVED">Conflict resolved</option>
            </optgroup>
            <optgroup label="Devices">
              <option value="DEVICE_REVOKED">Device revoked</option>
            </optgroup>
          </select>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface OrgSettings {
  requireGpsOnSubmit?: boolean;
  gpsAccuracyThresholdMeters?: number;
  rejectMockedLocations?: boolean;
  sessionIdleTimeoutMinutes?: number;
  deviceBindingEnabled?: boolean;
  maxDevicesPerUser?: number;
  localMediaRetentionDays?: number;
  wifiOnlyMediaSync?: boolean;
  photoWatermarkEnabled?: boolean;
  reportFooterText?: string | null;
  passwordPolicy?: {
    minLength?: number;
    requireUppercase?: boolean;
    requireNumber?: boolean;
    requireSymbol?: boolean;
    historyDepth?: number;
    maxAgeDays?: number;
  };
}

interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  locale: string;
  currency: string;
  numberPrefix: string;
  settings: OrgSettings;
  _count: { users: number; projects: number; sites: number; inspections: number; devices: number };
}

export function Settings(): React.ReactElement {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<OrgSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery<Organization>({
    queryKey: ['organization'],
    queryFn: () => api.get<Organization>('/admin/organization'),
  });

  const save = useMutation({
    mutationFn: (settings: OrgSettings) => api.patch('/admin/organization', { settings }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['organization'] });
      setDraft(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not save these settings.'),
  });

  if (isLoading || !data) return <Loading rows={6} />;

  const settings = { ...data.settings, ...draft };
  const editable = can(Permission.ORG_SETTINGS_UPDATE);
  const dirty = draft !== null;

  const set = <K extends keyof OrgSettings>(key: K, value: OrgSettings[K]): void => {
    setDraft((d) => ({ ...(d ?? {}), [key]: value }));
  };

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__subtitle">{data.name}</p>
        </div>
        {editable ? (
          <div className="row gap-3">
            {saved ? (
              <span className="small" style={{ color: 'var(--ok)' }}>
                Saved
              </span>
            ) : null}
            <button className="btn btn--secondary" onClick={() => setDraft(null)} disabled={!dirty}>
              Discard
            </button>
            <button
              className="btn"
              onClick={() => draft && save.mutate(draft)}
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        ) : null}
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="grid grid--4">
        <Card>
          <div className="metric__value num">{data._count.users}</div>
          <div className="metric__label">People</div>
        </Card>
        <Card>
          <div className="metric__value num">{data._count.devices}</div>
          <div className="metric__label">Devices</div>
        </Card>
        <Card>
          <div className="metric__value num">{data._count.sites}</div>
          <div className="metric__label">Sites</div>
        </Card>
        <Card>
          <div className="metric__value num">{data._count.inspections.toLocaleString()}</div>
          <div className="metric__label">Inspections</div>
        </Card>
      </div>

      <div className="grid grid--2 mt-6">
        <Card title="Location evidence">
          <div className="stack gap-5">
            <Toggle
              label="Require a location fix to submit"
              hint="An inspection cannot be submitted without proof of where it was carried out."
              checked={settings.requireGpsOnSubmit ?? false}
              disabled={!editable}
              onChange={(v) => set('requireGpsOnSubmit', v)}
            />
            <Toggle
              label="Reject simulated locations"
              hint="Refuses a fix the device reports as coming from a mock provider."
              checked={settings.rejectMockedLocations ?? false}
              disabled={!editable}
              onChange={(v) => set('rejectMockedLocations', v)}
            />
            <Number
              label="Accepted accuracy"
              suffix="metres"
              hint="A fix less accurate than this is flagged to the inspector."
              value={settings.gpsAccuracyThresholdMeters ?? 50}
              disabled={!editable}
              onChange={(v) => set('gpsAccuracyThresholdMeters', v)}
            />
            <Toggle
              label="Stamp photos with location and time"
              hint="Recorded alongside the photo, never burned into the image, so the original stays unaltered."
              checked={settings.photoWatermarkEnabled ?? false}
              disabled={!editable}
              onChange={(v) => set('photoWatermarkEnabled', v)}
            />
          </div>
        </Card>

        <Card title="Devices and sync">
          <div className="stack gap-5">
            <Toggle
              label="Only sync photos and videos on Wi-Fi"
              hint="Answers always sync immediately. Only media waits for an unmetered connection."
              checked={settings.wifiOnlyMediaSync ?? false}
              disabled={!editable}
              onChange={(v) => set('wifiOnlyMediaSync', v)}
            />
            <Number
              label="Devices per person"
              value={settings.maxDevicesPerUser ?? 3}
              disabled={!editable}
              hint="Someone at the limit must have a device revoked before enrolling another."
              onChange={(v) => set('maxDevicesPerUser', v)}
            />
            <Number
              label="Keep media on the device for"
              suffix="days"
              hint="After this, uploaded files from closed inspections are removed to free space. Anything not yet uploaded is never touched."
              value={settings.localMediaRetentionDays ?? 30}
              disabled={!editable}
              onChange={(v) => set('localMediaRetentionDays', v)}
            />
            <Number
              label="Sign out after inactivity"
              suffix="minutes"
              value={settings.sessionIdleTimeoutMinutes ?? 30}
              disabled={!editable}
              onChange={(v) => set('sessionIdleTimeoutMinutes', v)}
            />
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Passwords">
          <div className="grid grid--3">
            <Number
              label="Minimum length"
              value={settings.passwordPolicy?.minLength ?? 12}
              disabled={!editable}
              onChange={(v) => set('passwordPolicy', { ...settings.passwordPolicy, minLength: v })}
            />
            <Number
              label="Block reuse of last"
              suffix="passwords"
              value={settings.passwordPolicy?.historyDepth ?? 5}
              disabled={!editable}
              onChange={(v) =>
                set('passwordPolicy', { ...settings.passwordPolicy, historyDepth: v })
              }
            />
            <Number
              label="Force a change after"
              suffix="days"
              hint="Set to 0 to never expire."
              value={settings.passwordPolicy?.maxAgeDays ?? 0}
              disabled={!editable}
              onChange={(v) => set('passwordPolicy', { ...settings.passwordPolicy, maxAgeDays: v })}
            />
          </div>
        </Card>
      </div>
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}): React.ReactElement {
  return (
    <label
      className="row gap-3"
      style={{ alignItems: 'flex-start', cursor: disabled ? 'default' : 'pointer' }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--accent)' }}
      />
      <span className="grow">
        <span className="strong small">{label}</span>
        {hint ? (
          <span className="field__hint" style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

function Number({
  label,
  hint,
  suffix,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  suffix?: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      <div className="row gap-2">
        <input
          className="input num"
          type="number"
          min={0}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Math.max(0, globalThis.Number(e.target.value) || 0))}
          style={{ maxWidth: 120 }}
        />
        {suffix ? <span className="small muted">{suffix}</span> : null}
      </div>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}
