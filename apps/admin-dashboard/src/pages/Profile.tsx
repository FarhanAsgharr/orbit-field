/**
 * Your own account.
 *
 * There was no way to see or change your own details, or your own password,
 * without being an administrator — an inspector or supervisor had no route to
 * their own record at all.
 *
 * Role and status are shown and not editable. They decide what you may do, and
 * a person who can change their own role makes every permission check in the
 * system advisory. The server refuses those fields on this endpoint regardless;
 * showing them read-only is how somebody learns that without being rejected.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import { PasswordInput } from '../components/PasswordInput';
import {
  Badge,
  Card,
  Empty,
  ErrorBanner,
  formatDate,
  Loading,
  relativeTime,
  roleBadge,
} from '../components/ui';
import { api, clearTokens } from '../lib/api';

interface ProfileData {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl: string | null;
  employeeId: string | null;
  department: string | null;
  jobTitle: string | null;
  role: string;
  status: string;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  createdAt: string;
  organization: { id: string; name: string };
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    appVersion: string | null;
    osVersion: string | null;
    lastSeenAt: string | null;
    lastSyncAt: string | null;
    revokedAt: string | null;
  }>;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function Profile(): React.ReactElement {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');

  const query = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<ProfileData>('/auth/profile'),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['profile'] });
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch('/auth/profile', {
        firstName: form!.firstName,
        lastName: form!.lastName,
        phone: form!.phone || null,
        employeeId: form!.employeeId || null,
        department: form!.department || null,
        jobTitle: form!.jobTitle || null,
        avatarUrl: form!.avatarUrl || null,
      }),
    onSuccess: () => {
      setForm(null);
      setNotice('Saved.');
      refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save your details.'),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      // Changing a password ends every session, this one included — the server
      // revokes the tokens, so staying on the page would just 401 on the next
      // request.
      clearTokens();
      globalThis.location.assign('/sign-in');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not change your password.'),
  });

  const logoutAll = useMutation({
    mutationFn: () => api.post<{ devicesRevoked: number }>('/auth/logout-all', {}),
    onSuccess: () => {
      clearTokens();
      globalThis.location.assign('/sign-in');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not sign out everywhere.'),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) {
    return <Empty title="Could not load your profile" body="Try signing in again." />;
  }

  const p = query.data;
  const badge = roleBadge(p.role);
  const active = p.devices.filter((d) => !d.revokedAt);
  const busy = save.isPending || changePassword.isPending || logoutAll.isPending;

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">
            {p.firstName} {p.lastName}
          </h1>
          <p className="page__subtitle">
            {p.email} · {p.organization.name}
          </p>
        </div>
        <div className="row gap-2">
          <Badge label={badge.label} tone={badge.tone} />
          <Badge label={p.status.toLowerCase()} tone={p.status === 'ACTIVE' ? 'ok' : 'danger'} />
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <p className="small">{notice}</p> : null}

      <div className="grid grid--2 gap-4">
        <Card title="Your details">
          {form ? (
            <div className="stack gap-3">
              <div className="row gap-3">
                <div className="field grow">
                  <label className="field__label" htmlFor="pf-first">
                    First name
                  </label>
                  <input
                    id="pf-first"
                    className="input"
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div className="field grow">
                  <label className="field__label" htmlFor="pf-last">
                    Last name
                  </label>
                  <input
                    id="pf-last"
                    className="input"
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>
              {(
                [
                  ['phone', 'Phone'],
                  ['employeeId', 'Employee ID'],
                  ['department', 'Department'],
                  ['jobTitle', 'Job title'],
                  ['avatarUrl', 'Avatar image URL'],
                ] as const
              ).map(([key, label]) => (
                <div className="field" key={key}>
                  <label className="field__label" htmlFor={`pf-${key}`}>
                    {label}
                  </label>
                  <input
                    id={`pf-${key}`}
                    className="input"
                    value={form[key] ?? ''}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                  {key === 'avatarUrl' ? (
                    <span className="field__hint">
                      A link to an image. There is no file upload here yet.
                    </span>
                  ) : null}
                </div>
              ))}
              <div className="row gap-2">
                <button className="btn" onClick={() => save.mutate()} disabled={busy}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
                <button className="btn btn--ghost" onClick={() => setForm(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="stack gap-3">
              {p.avatarUrl ? (
                <img
                  src={p.avatarUrl}
                  alt=""
                  style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }}
                />
              ) : null}
              <Row label="Email">{p.email}</Row>
              <Row label="Phone">{p.phone ?? <span className="muted">—</span>}</Row>
              <Row label="Employee ID">{p.employeeId ?? <span className="muted">—</span>}</Row>
              <Row label="Department">{p.department ?? <span className="muted">—</span>}</Row>
              <Row label="Job title">{p.jobTitle ?? <span className="muted">—</span>}</Row>
              <Row label="Role">
                {/* Not editable here: see the note at the top of the file. */}
                <Badge label={badge.label} tone={badge.tone} />
              </Row>
              <button
                className="btn btn--ghost"
                onClick={() =>
                  setForm({
                    firstName: p.firstName,
                    lastName: p.lastName,
                    phone: p.phone ?? '',
                    employeeId: p.employeeId ?? '',
                    department: p.department ?? '',
                    jobTitle: p.jobTitle ?? '',
                    avatarUrl: p.avatarUrl ?? '',
                  })
                }
              >
                Edit details
              </button>
            </div>
          )}
        </Card>

        <Card title="Session">
          <div className="stack gap-3">
            <Row label="Last signed in">{relativeTime(p.lastLoginAt)}</Row>
            <Row label="From">{p.lastLoginIp ?? <span className="muted">—</span>}</Row>
            <Row label="Password last changed">
              {p.passwordChangedAt ? (
                formatDate(p.passwordChangedAt)
              ) : (
                <span className="muted">—</span>
              )}
            </Row>
            <Row label="Account created">{formatDate(p.createdAt)}</Row>
            {p.mustChangePassword ? (
              <ErrorBanner message="Your password was set by an administrator. Change it below." />
            ) : null}
          </div>
        </Card>
      </div>

      <Card title="Change your password">
        <div className="stack gap-3">
          <PasswordInput
            label="Current password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
          />
          <PasswordInput
            label="New password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
            hint="At least 12 characters, with an uppercase letter, a lowercase letter and a number. You will be signed out everywhere."
          />
          <button
            className="btn"
            onClick={() => changePassword.mutate()}
            disabled={busy || current === '' || next === ''}
          >
            {changePassword.isPending ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </Card>

      <Card title={`Your devices (${active.length} active)`}>
        <div className="stack gap-4">
          {p.devices.length === 0 ? (
            <Empty title="No devices" body="Signing in to the app enrols one." />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Platform</th>
                  <th>Last seen</th>
                  <th>Last sync</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {p.devices.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td className="muted">
                      {d.platform} {d.appVersion ? `· v${d.appVersion}` : ''}
                    </td>
                    <td>{relativeTime(d.lastSeenAt)}</td>
                    <td>{relativeTime(d.lastSyncAt)}</td>
                    <td>
                      <Badge
                        label={d.revokedAt ? 'revoked' : 'active'}
                        tone={d.revokedAt ? 'danger' : 'ok'}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <button
            className="btn btn--ghost"
            onClick={() => {
              if (
                globalThis.confirm(
                  'Sign out of every device, including this one? You will need to sign in again.',
                )
              )
                logoutAll.mutate();
            }}
            disabled={busy || active.length === 0}
          >
            {logoutAll.isPending ? 'Signing out…' : 'Sign out of all devices'}
          </button>
        </div>
      </Card>
    </>
  );
}
