/**
 * List screens: inspections, people, checklists, clients, projects, sites, devices.
 *
 * All built on `DataTable`. Kept in one module because each is a column
 * definition and little else — splitting seven ~40-line screens across seven
 * files would add navigation cost without adding clarity.
 */

import { Permission } from '@orbit/shared';
import { type Role, ROLE_RANK } from '@orbit/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import { type Column, DataTable } from '../components/DataTable';
import { PasswordInput } from '../components/PasswordInput';
import {
  Badge,
  Bar,
  Card,
  Empty,
  ErrorBanner,
  formatBytes,
  formatDate,
  Loading,
  outcomeBadge,
  priorityBadge,
  relativeTime,
  roleBadge,
  statusBadge,
} from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

// ---------------------------------------------------------------------------
// Inspections
// ---------------------------------------------------------------------------

interface InspectionRow {
  id: string;
  number: string;
  title: string;
  status: string;
  outcome: string;
  priority: string;
  score: number | null;
  answeredFields: number;
  totalFields: number;
  dueAt: string | null;
  updatedAt: string;
  template: { name: string } | null;
  site: { name: string } | null;
  client: { name: string } | null;
  assignedTo: { firstName: string; lastName: string } | null;
  _count: { attachments: number; responses: number };
}

export function Inspections(): React.ReactElement {
  const [status, setStatus] = useState<string>('');
  const [outcome, setOutcome] = useState<string>('');

  const columns: Array<Column<InspectionRow>> = [
    {
      key: 'number',
      header: 'Reference',
      sortable: true,
      width: '150px',
      render: (row) => (
        <Link className="num" to={`/inspections/${row.id}`}>
          {row.number}
        </Link>
      ),
    },
    {
      key: 'title',
      header: 'Inspection',
      render: (row) => (
        <div>
          <div className="table__primary">{row.title}</div>
          <div className="table__meta">{row.template?.name ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'site',
      header: 'Site / client',
      render: (row) => (
        <div>
          <div>{row.site?.name ?? '—'}</div>
          <div className="table__meta">{row.client?.name ?? ''}</div>
        </div>
      ),
    },
    {
      key: 'assignee',
      header: 'Inspector',
      render: (row) =>
        row.assignedTo ? (
          `${row.assignedTo.firstName} ${row.assignedTo.lastName}`
        ) : (
          <span className="muted">Unassigned</span>
        ),
    },
    {
      key: 'progress',
      header: 'Progress',
      width: '130px',
      render: (row) => {
        const share = row.totalFields > 0 ? row.answeredFields / row.totalFields : 0;
        return (
          <div className="stack gap-1">
            <Bar value={share} tone={share === 1 ? 'ok' : 'accent'} />
            <span className="table__meta num">
              {row.answeredFields}/{row.totalFields}
            </span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => {
        const badge = statusBadge(row.status);
        return <Badge label={badge.label} tone={badge.tone} glyph={badge.glyph} />;
      },
    },
    {
      key: 'outcome',
      header: 'Result',
      render: (row) => {
        if (row.outcome === 'PENDING') return <span className="muted">—</span>;
        const badge = outcomeBadge(row.outcome);
        return <Badge label={badge.label} tone={badge.tone} glyph={badge.glyph} />;
      },
    },
    {
      key: 'score',
      header: 'Score',
      numeric: true,
      sortable: true,
      width: '80px',
      render: (row) => (row.score !== null ? `${Math.round(row.score)}%` : '—'),
    },
    {
      key: 'dueAt',
      header: 'Due',
      sortable: true,
      numeric: true,
      width: '130px',
      render: (row) => {
        if (!row.dueAt) return <span className="muted">—</span>;
        const overdue =
          Date.parse(row.dueAt) < Date.now() &&
          !['APPROVED', 'CANCELLED', 'ARCHIVED', 'SUBMITTED', 'UNDER_REVIEW'].includes(row.status);
        return (
          <span style={{ color: overdue ? 'var(--danger)' : undefined }}>
            {relativeTime(row.dueAt)}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Inspections</h1>
          <p className="page__subtitle">Every inspection across the organisation.</p>
        </div>
      </header>

      <DataTable<InspectionRow>
        endpoint="/inspections"
        queryKey={['inspections', status, outcome]}
        columns={columns}
        rowKey={(row) => row.id}
        searchPlaceholder="Search reference, title, site, or notes"
        extraQuery={{ status: status || undefined, outcome: outcome || undefined }}
        defaultSort={{ by: 'updatedAt', dir: 'desc' }}
        emptyTitle="No inspections yet"
        emptyBody="Work created in the field app will appear here as soon as a device syncs."
        filters={
          <>
            <select
              className="select"
              style={{ width: 'auto' }}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">Any status</option>
              <option value="DRAFT">Draft</option>
              <option value="SCHEDULED">Scheduled</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="SUBMITTED">Submitted</option>
              <option value="UNDER_REVIEW">Under review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
            <select
              className="select"
              style={{ width: 'auto' }}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              aria-label="Filter by result"
            >
              <option value="">Any result</option>
              <option value="PASS">Pass</option>
              <option value="PASS_WITH_OBSERVATIONS">Pass with observations</option>
              <option value="FAIL">Fail</option>
            </select>
          </>
        }
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  department: string | null;
  jobTitle: string | null;
  lastLoginAt: string | null;
  _count: { devices: number; assignedInspections: number };
}

export function People(): React.ReactElement {
  const { can, user } = useSession();
  const [role, setRole] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);

  /*
   * Who this operator may act on.
   *
   * Mirrors `canManageUser` on the server: strictly below your own rank, and
   * never yourself. The server enforces it regardless — this only decides
   * whether to draw a control, because a button whose sole outcome is a 403 is
   * a worse way to learn the rule than not offering it.
   */
  const myRank = ROLE_RANK[(user?.role ?? 'VIEWER') as Role] ?? 0;
  const manageable = (row: UserRow): boolean =>
    row.id !== user?.id && myRank > (ROLE_RANK[row.role as Role] ?? 0);

  const columns: Array<Column<UserRow>> = [
    {
      key: 'name',
      header: 'Person',
      sortable: true,
      render: (row) => (
        <div>
          <div className="table__primary">
            {row.firstName} {row.lastName}
          </div>
          <div className="table__meta">{row.email}</div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (row) => {
        const badge = roleBadge(row.role);
        return <Badge label={badge.label} tone={badge.tone} />;
      },
    },
    {
      key: 'jobTitle',
      header: 'Job title',
      render: (row) => row.jobTitle ?? <span className="muted">—</span>,
    },
    {
      key: 'department',
      header: 'Department',
      render: (row) => row.department ?? <span className="muted">—</span>,
    },
    {
      key: 'status',
      header: 'Account',
      render: (row) => (
        <Badge
          label={row.status.toLowerCase()}
          tone={row.status === 'ACTIVE' ? 'ok' : row.status === 'INVITED' ? 'info' : 'danger'}
        />
      ),
    },
    {
      key: 'devices',
      header: 'Devices',
      numeric: true,
      width: '90px',
      render: (row) => row._count.devices,
    },
    {
      key: 'work',
      header: 'Assigned',
      numeric: true,
      width: '90px',
      render: (row) => row._count.assignedInspections,
    },
    {
      key: 'lastLoginAt',
      header: 'Last signed in',
      sortable: true,
      numeric: true,
      render: (row) => relativeTime(row.lastLoginAt),
    },
    {
      key: 'actions',
      header: '',
      width: '90px',
      render: (row) =>
        can(Permission.USER_UPDATE) && manageable(row) ? (
          <button className="btn btn--ghost btn--sm" onClick={() => setEditing(row)}>
            Edit
          </button>
        ) : (
          // Deliberately blank rather than a disabled button: there is nothing
          // this operator can do to this person, and an inert control only
          // invites the question.
          <span className="muted">—</span>
        ),
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">People</h1>
          <p className="page__subtitle">Who can sign in, and what they are allowed to do.</p>
        </div>
      </header>

      {editing ? <EditMemberPanel member={editing} onClose={() => setEditing(null)} /> : null}

      <DataTable<UserRow>
        endpoint="/users"
        queryKey={['users', role]}
        columns={columns}
        rowKey={(row) => row.id}
        searchPlaceholder="Search name, email, or department"
        extraQuery={{ role: role || undefined }}
        defaultSort={{ by: 'createdAt', dir: 'desc' }}
        emptyTitle="No people yet"
        filters={
          <select
            className="select"
            style={{ width: 'auto' }}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Filter by role"
          >
            <option value="">Any role</option>
            {[
              'SUPER_ADMIN',
              'ADMIN',
              'MANAGER',
              'SUPERVISOR',
              'INSPECTOR',
              'TECHNICIAN',
              'VIEWER',
            ].map((r) => (
              <option key={r} value={r}>
                {roleBadge(r).label}
              </option>
            ))}
          </select>
        }
        toolbarAction={can(Permission.USER_INVITE) ? <InviteUserButton /> : null}
      />
    </>
  );
}

const EMPTY_INVITE = {
  email: '',
  firstName: '',
  lastName: '',
  role: 'INSPECTOR',
  password: '',
  department: '',
  jobTitle: '',
};

/**
 * Edit a colleague, or take their access away.
 *
 * Deactivation rather than deletion, and the wording says so plainly. Audit
 * trails, historical inspections and signatures all reference the user id, so
 * removing the row would rewrite who did what — the opposite of what a
 * compliance record is for. The server refuses a hard delete regardless; this
 * exists so the person clicking it knows that before they click.
 *
 * Role changes end every session that user has open. That is deliberate: their
 * existing token still asserts the old role until it does.
 */
function EditMemberPanel({
  member,
  onClose,
}: {
  member: UserRow;
  onClose: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [form, setForm] = useState({
    email: member.email,
    firstName: member.firstName,
    lastName: member.lastName,
    role: member.role,
    jobTitle: member.jobTitle ?? '',
    department: member.department ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  /*
   * Whether a permanent delete is even possible.
   *
   * The server decides — it counts inspections, audit entries, templates and
   * sync history — and says so on the detail endpoint. Offering "delete
   * permanently" and then refusing it is a worse way to communicate the rule
   * than only offering what will work.
   */
  const detail = useQuery({
    queryKey: ['user-detail', member.id],
    queryFn: () =>
      api.get<{ deletable: boolean; usage: Record<string, number> }>(`/users/${member.id}`),
  });

  const myRank = ROLE_RANK[(user?.role ?? 'VIEWER') as Role] ?? 0;
  const assignable = (
    ['ADMIN', 'MANAGER', 'SUPERVISOR', 'INSPECTOR', 'TECHNICIAN', 'VIEWER'] as Role[]
  ).filter((r) => myRank > ROLE_RANK[r]);

  const done = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/users/${member.id}`, {
        email: form.email.trim(),
        firstName: form.firstName,
        lastName: form.lastName,
        role: form.role,
        jobTitle: form.jobTitle || null,
        department: form.department || null,
      }),
    onSuccess: done,
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save the changes.'),
  });

  const deactivate = useMutation({
    mutationFn: () => api.delete<{ openInspections: number }>(`/users/${member.id}`),
    onSuccess: done,
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not deactivate the account.'),
  });

  const reactivate = useMutation({
    mutationFn: () => api.patch(`/users/${member.id}`, { status: 'ACTIVE' }),
    onSuccess: done,
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not reactivate the account.'),
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post(`/users/${member.id}/reset-password`, { password: newPassword }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      // Not closed: the administrator still has to pass the new password on.
      setNotice(
        'Password reset. They are signed out of every device and must use the new password.',
      );
      setError(null);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not reset the password.'),
  });

  const destroy = useMutation({
    mutationFn: () => api.delete(`/users/${member.id}/permanent`),
    onSuccess: done,
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not delete the account.'),
  });

  const busy =
    save.isPending ||
    deactivate.isPending ||
    reactivate.isPending ||
    resetPassword.isPending ||
    destroy.isPending;

  if (confirmingRemoval) {
    return (
      <div className="card popover" role="dialog" aria-label="Remove access">
        <div className="card__head">
          <h2 className="card__title">Remove access</h2>
          <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
        <div className="card__body stack gap-4">
          {error ? <ErrorBanner message={error} /> : null}
          <p>
            <strong>
              {member.firstName} {member.lastName}
            </strong>{' '}
            will be signed out of every device immediately and will not be able to sign in again.
          </p>
          <p className="small muted">
            The account is deactivated, not deleted — their name stays on the inspections they
            carried out and the audit trail stays intact.
            {member._count.assignedInspections > 0 ? (
              <>
                {' '}
                They currently have{' '}
                <strong>{member._count.assignedInspections} assigned inspection(s)</strong>, which
                will need reassigning to somebody else.
              </>
            ) : null}
          </p>
          <button className="btn btn--danger" onClick={() => deactivate.mutate()} disabled={busy}>
            {deactivate.isPending ? 'Removing…' : 'Remove access'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card popover" role="dialog" aria-label="Edit person">
      <div className="card__head">
        <h2 className="card__title">
          {member.firstName} {member.lastName}
        </h2>
        <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
      <div className="card__body stack gap-4">
        {error ? <ErrorBanner message={error} /> : null}
        {notice ? <p className="small">{notice}</p> : null}

        <div className="row gap-3">
          <div className="field grow">
            <label className="field__label" htmlFor="edit-first">
              First name
            </label>
            <input
              id="edit-first"
              className="input"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            />
          </div>
          <div className="field grow">
            <label className="field__label" htmlFor="edit-last">
              Last name
            </label>
            <input
              id="edit-last"
              className="input"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="edit-email">
            Email
          </label>
          <input
            id="edit-email"
            className="input"
            type="email"
            autoComplete="off"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          {form.email.trim() !== member.email ? (
            <span className="field__hint">
              This is how they sign in — tell them before they next open the app.
            </span>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="edit-role">
            Role
          </label>
          <select
            id="edit-role"
            className="select"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {/* The current role stays selectable even if it is at or above the
                operator's own rank, so opening the panel cannot silently
                propose a demotion. */}
            {Array.from(new Set([member.role, ...assignable])).map((r) => (
              <option key={r} value={r}>
                {roleBadge(r).label}
              </option>
            ))}
          </select>
          {form.role !== member.role ? (
            <span className="field__hint">
              Changing the role signs them out everywhere — their current session still claims the
              old one until it does.
            </span>
          ) : null}
        </div>

        <div className="row gap-3">
          <div className="field grow">
            <label className="field__label" htmlFor="edit-job">
              Job title
            </label>
            <input
              id="edit-job"
              className="input"
              value={form.jobTitle}
              onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
            />
          </div>
          <div className="field grow">
            <label className="field__label" htmlFor="edit-dept">
              Department
            </label>
            <input
              id="edit-dept"
              className="input"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
            />
          </div>
        </div>

        <button className="btn" onClick={() => save.mutate()} disabled={busy}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>

        <hr className="rule" />

        {/* Reset, rather than "send a reset link": there is no mail provider,
            so the administrator sets the password and hands it over. */}
        <div className="field">
          <PasswordInput
            label="Set a new password"
            value={newPassword}
            autoComplete="new-password"
            onChange={(e) => setNewPassword(e.target.value)}
            hint="Their old password stops working immediately and every device is signed out."
          />
          <button
            className="btn btn--ghost"
            onClick={() => {
              setError(null);
              setNotice(null);
              resetPassword.mutate();
            }}
            disabled={busy || newPassword === ''}
          >
            {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
          </button>
        </div>

        <hr className="rule" />

        {member.status === 'DEACTIVATED' ? (
          <>
            <p className="small muted">
              This account is deactivated. They cannot sign in until it is restored.
            </p>
            <button className="btn" onClick={() => reactivate.mutate()} disabled={busy}>
              {reactivate.isPending ? 'Restoring…' : 'Reactivate account'}
            </button>
          </>
        ) : (
          <button
            className="btn btn--ghost"
            onClick={() => {
              setError(null);
              setConfirmingRemoval(true);
            }}
            disabled={busy}
          >
            Deactivate account…
          </button>
        )}

        {detail.data?.deletable ? (
          <button
            className="btn btn--ghost"
            onClick={() => {
              setError(null);
              // No second dialog: there is nothing to lose. The server has
              // already confirmed this person has no history at all.
              if (globalThis.confirm(`Permanently delete ${member.email}? This cannot be undone.`))
                destroy.mutate();
            }}
            disabled={busy}
          >
            {destroy.isPending ? 'Deleting…' : 'Delete permanently'}
          </button>
        ) : detail.data ? (
          <p className="small muted">
            Cannot be deleted permanently — this person has a history in the system (
            {Object.entries(detail.data.usage)
              .map(
                ([k, n]) =>
                  `${n} ${k
                    .replace(/([A-Z])/g, ' $1')
                    .toLowerCase()
                    .trim()}`,
              )
              .join(', ')}
            ). Deactivating keeps their name on the work they did.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Create a colleague's account.
 *
 * The administrator sets the password and hands it over directly. There is no
 * email invitation: this installation has no mail provider, and an invitation
 * that cannot be delivered creates an account nobody can ever sign in to —
 * it exists, it has no password, and the app tells the recipient their
 * credentials are wrong. Requiring a password here makes that state
 * unreachable.
 *
 * The role list is filtered to what this operator may actually grant. The
 * server enforces the same rule (`canAssignRole`: strictly below your own
 * rank), but offering a role that will be rejected is a worse way to learn it.
 */
function InviteUserButton(): React.ReactElement {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_INVITE);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const actorRank = ROLE_RANK[(user?.role ?? 'VIEWER') as Role] ?? 0;
  const assignable = (
    ['ADMIN', 'MANAGER', 'SUPERVISOR', 'INSPECTOR', 'TECHNICIAN', 'VIEWER'] as Role[]
  ).filter((r) => actorRank > ROLE_RANK[r]);

  const close = (): void => {
    setOpen(false);
    setForm(EMPTY_INVITE);
    setError(null);
    setCreated(null);
  };

  const ready =
    form.email.trim() !== '' &&
    form.firstName.trim() !== '' &&
    form.lastName.trim() !== '' &&
    form.password !== '';

  const invite = useMutation({
    mutationFn: () =>
      api.post('/users', {
        email: form.email.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        role: form.role,
        password: form.password,
        department: form.department.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      // The panel stays open: the administrator still has to pass the password
      // on, and closing takes the only copy of it off the screen.
      setCreated({ email: form.email.trim(), password: form.password });
      setError(null);
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not create the account.'),
  });

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Add someone
      </button>
    );
  }

  if (created) {
    return (
      <div className="card popover" role="dialog" aria-label="Account created">
        <div className="card__head">
          <h2 className="card__title">Account created</h2>
          <button className="btn btn--ghost btn--sm" onClick={close}>
            Done
          </button>
        </div>
        <div className="card__body stack gap-4">
          <p>
            Give these to <strong>{created.email}</strong>. They sign in to the Orbit Field app on
            their phone with exactly this email and password.
          </p>
          <div className="field">
            <span className="field__label">Email</span>
            <code className="input" style={{ display: 'block' }}>
              {created.email}
            </code>
          </div>
          <div className="field">
            <span className="field__label">Password</span>
            <code className="input" style={{ display: 'block' }}>
              {created.password}
            </code>
            <span className="field__hint">
              This is the only time it is shown. If it is lost, use Reset password on their row.
            </span>
          </div>
          <button
            className="btn"
            onClick={() => {
              setCreated(null);
              setForm(EMPTY_INVITE);
            }}
          >
            Add another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card popover" role="dialog" aria-label="Add someone">
      <div className="card__head">
        <h2 className="card__title">Add someone</h2>
        <button className="btn btn--ghost btn--sm" onClick={close}>
          Cancel
        </button>
      </div>
      <div className="card__body stack gap-4">
        {error ? <ErrorBanner message={error} /> : null}

        <div className="row gap-3">
          <div className="field grow">
            <label className="field__label" htmlFor="inv-first">
              First name
            </label>
            <input
              id="inv-first"
              className="input"
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            />
          </div>
          <div className="field grow">
            <label className="field__label" htmlFor="inv-last">
              Last name
            </label>
            <input
              id="inv-last"
              className="input"
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="inv-email">
            Email
          </label>
          <input
            id="inv-email"
            className="input"
            type="email"
            autoComplete="off"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <span className="field__hint">This is the username they sign in with.</span>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="inv-role">
            Role
          </label>
          <select
            id="inv-role"
            className="select"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {assignable.map((r) => (
              <option key={r} value={r}>
                {roleBadge(r).label}
              </option>
            ))}
          </select>
        </div>

        <div className="row gap-3">
          <div className="field grow">
            <label className="field__label" htmlFor="inv-dept">
              Department
            </label>
            <input
              id="inv-dept"
              className="input"
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
            />
          </div>
          <div className="field grow">
            <label className="field__label" htmlFor="inv-job">
              Job title
            </label>
            <input
              id="inv-job"
              className="input"
              value={form.jobTitle}
              onChange={(e) => setForm({ ...form, jobTitle: e.target.value })}
            />
          </div>
        </div>

        <PasswordInput
          label="Password"
          value={form.password}
          autoComplete="new-password"
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          hint="At least 12 characters, with an uppercase letter, a lowercase letter and a number. It must not contain their name or email."
        />

        <button
          className="btn"
          onClick={() => invite.mutate()}
          disabled={invite.isPending || !ready}
        >
          {invite.isPending ? 'Saving…' : 'Create account'}
        </button>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  discipline: string | null;
  isArchived: boolean;
  activeVersionId: string | null;
  createdBy: { firstName: string; lastName: string } | null;
  versions: Array<{ id: string; version: number; publishedAt: string | null }>;
  _count: { inspections: number; versions: number };
}

export function Templates(): React.ReactElement {
  const columns: Array<Column<TemplateRow>> = [
    {
      key: 'name',
      header: 'Checklist',
      sortable: true,
      render: (row) => (
        <div>
          <div className="table__primary">{row.name}</div>
          {row.description ? (
            <div className="table__meta truncate" style={{ maxWidth: 380 }}>
              {row.description}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (row) => row.category ?? <span className="muted">—</span>,
    },
    {
      key: 'published',
      header: 'Published version',
      render: (row) => {
        const active = row.versions.find((v) => v.id === row.activeVersionId);
        return active ? (
          <Badge label={`v${active.version}`} tone="ok" glyph="✓" />
        ) : (
          <Badge label="Draft only" tone="warn" glyph="○" />
        );
      },
    },
    {
      key: 'versions',
      header: 'Versions',
      numeric: true,
      width: '90px',
      render: (row) => row._count.versions,
    },
    {
      key: 'used',
      header: 'Inspections',
      numeric: true,
      width: '110px',
      render: (row) => row._count.inspections,
    },
    {
      key: 'state',
      header: 'State',
      render: (row) =>
        row.isArchived ? (
          <Badge label="Archived" tone="neutral" glyph="▣" />
        ) : (
          <Badge label="Available" tone="ok" glyph="●" />
        ),
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Checklists</h1>
          <p className="page__subtitle">
            Publishing a version freezes it. Inspections in progress keep the version they started
            on.
          </p>
        </div>
      </header>

      <DataTable<TemplateRow>
        endpoint="/templates"
        queryKey={['templates']}
        columns={columns}
        rowKey={(row) => row.id}
        searchPlaceholder="Search checklists"
        defaultSort={{ by: 'updatedAt', dir: 'desc' }}
        emptyTitle="No checklists yet"
        emptyBody="A checklist defines the questions an inspector answers on site."
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

interface ClientRow {
  id: string;
  name: string;
  code: string | null;
  contactName: string | null;
  contactEmail: string | null;
  isActive: boolean;
  _count: { projects: number; sites: number; inspections: number };
}

export function Clients(): React.ReactElement {
  const columns: Array<Column<ClientRow>> = [
    {
      key: 'name',
      header: 'Client',
      sortable: true,
      render: (row) => <span className="table__primary">{row.name}</span>,
    },
    {
      key: 'code',
      header: 'Code',
      render: (row) =>
        row.code ? <span className="num">{row.code}</span> : <span className="muted">—</span>,
    },
    {
      key: 'contact',
      header: 'Contact',
      render: (row) =>
        row.contactName ? (
          <div>
            <div>{row.contactName}</div>
            <div className="table__meta">{row.contactEmail ?? ''}</div>
          </div>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'projects',
      header: 'Projects',
      numeric: true,
      width: '90px',
      render: (row) => row._count.projects,
    },
    {
      key: 'sites',
      header: 'Sites',
      numeric: true,
      width: '80px',
      render: (row) => row._count.sites,
    },
    {
      key: 'inspections',
      header: 'Inspections',
      numeric: true,
      width: '110px',
      render: (row) => row._count.inspections,
    },
    {
      key: 'active',
      header: 'State',
      render: (row) => (
        <Badge
          label={row.isActive ? 'Active' : 'Inactive'}
          tone={row.isActive ? 'ok' : 'neutral'}
        />
      ),
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Clients</h1>
          <p className="page__subtitle">Organisations you carry out inspections for.</p>
        </div>
      </header>
      <DataTable<ClientRow>
        endpoint="/clients"
        queryKey={['clients']}
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search clients"
        emptyTitle="No clients yet"
        emptyBody="Add a client to group projects, sites, and reports."
      />
    </>
  );
}

interface ProjectRow {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  client: { name: string } | null;
  manager: { firstName: string; lastName: string } | null;
  _count: { sites: number; inspections: number; members: number };
}

export function Projects(): React.ReactElement {
  const columns: Array<Column<ProjectRow>> = [
    {
      key: 'name',
      header: 'Project',
      sortable: true,
      render: (row) => (
        <div>
          <div className="table__primary">{row.name}</div>
          <div className="table__meta num">{row.code}</div>
        </div>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      render: (row) => row.client?.name ?? <span className="muted">—</span>,
    },
    {
      key: 'manager',
      header: 'Manager',
      render: (row) =>
        row.manager ? (
          `${row.manager.firstName} ${row.manager.lastName}`
        ) : (
          <span className="muted">Unassigned</span>
        ),
    },
    {
      key: 'sites',
      header: 'Sites',
      numeric: true,
      width: '80px',
      render: (row) => row._count.sites,
    },
    {
      key: 'inspections',
      header: 'Inspections',
      numeric: true,
      width: '110px',
      render: (row) => row._count.inspections,
    },
    {
      key: 'active',
      header: 'State',
      render: (row) => (
        <Badge label={row.isActive ? 'Active' : 'Closed'} tone={row.isActive ? 'ok' : 'neutral'} />
      ),
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Projects</h1>
          <p className="page__subtitle">
            Programmes of work, each with its own sites and inspectors.
          </p>
        </div>
      </header>
      <DataTable<ProjectRow>
        endpoint="/projects"
        queryKey={['projects']}
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search projects"
        emptyTitle="No projects yet"
      />
    </>
  );
}

interface SiteRow {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusMeters: number | null;
  isActive: boolean;
  client: { name: string } | null;
  project: { name: string } | null;
  _count: { inspections: number; assets: number };
}

export function Sites(): React.ReactElement {
  const columns: Array<Column<SiteRow>> = [
    {
      key: 'name',
      header: 'Site',
      sortable: true,
      render: (row) => (
        <div>
          <div className="table__primary">{row.name}</div>
          {row.address ? (
            <div className="table__meta truncate" style={{ maxWidth: 320 }}>
              {row.address}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      render: (row) => row.client?.name ?? <span className="muted">—</span>,
    },
    {
      key: 'project',
      header: 'Project',
      render: (row) => row.project?.name ?? <span className="muted">—</span>,
    },
    {
      key: 'location',
      header: 'Location',
      render: (row) =>
        row.latitude !== null && row.longitude !== null ? (
          <div>
            <div className="num small">
              {row.latitude.toFixed(4)}, {row.longitude.toFixed(4)}
            </div>
            {row.geofenceRadiusMeters ? (
              <div className="table__meta">Geofence {row.geofenceRadiusMeters} m</div>
            ) : null}
          </div>
        ) : (
          // Said plainly: a site with no coordinates cannot verify attendance.
          <span className="muted">Not located</span>
        ),
    },
    {
      key: 'assets',
      header: 'Assets',
      numeric: true,
      width: '80px',
      render: (row) => row._count.assets,
    },
    {
      key: 'inspections',
      header: 'Inspections',
      numeric: true,
      width: '110px',
      render: (row) => row._count.inspections,
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Sites</h1>
          <p className="page__subtitle">
            Physical locations. Coordinates let the app confirm attendance.
          </p>
        </div>
      </header>
      <DataTable<SiteRow>
        endpoint="/sites"
        queryKey={['sites']}
        columns={columns}
        rowKey={(r) => r.id}
        searchPlaceholder="Search sites"
        emptyTitle="No sites yet"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  model: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
  userId: string;
}

export function Devices(): React.ReactElement {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<DeviceRecord[]>({
    queryKey: ['devices-all'],
    queryFn: () => api.get<DeviceRecord[]>('/devices', { includeRevoked: true }),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/devices/${id}`, { reason: 'Revoked from the operations console' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['devices-all'] }),
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not revoke that device.'),
  });

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Devices</h1>
          <p className="page__subtitle">
            Revoking a device signs it out and stops it syncing. Work already on it stays there
            until somebody signs in again.
          </p>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <Card flush>
        {isLoading ? (
          <Loading rows={5} />
        ) : !data || data.length === 0 ? (
          <Empty
            title="No devices enrolled"
            body="A device appears here the first time somebody signs in on it."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Platform</th>
                  <th>App</th>
                  <th style={{ textAlign: 'right' }}>Last seen</th>
                  <th style={{ textAlign: 'right' }}>Last sync</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((device) => (
                  <tr key={device.id}>
                    <td>
                      <div className="table__primary">{device.name}</div>
                      <div className="table__meta">{device.model ?? device.platform}</div>
                    </td>
                    <td className="table__meta">
                      {device.platform} {device.osVersion}
                    </td>
                    <td className="table__meta num">{device.appVersion}</td>
                    <td className="table__num table__meta">{relativeTime(device.lastSeenAt)}</td>
                    <td className="table__num table__meta">{relativeTime(device.lastSyncAt)}</td>
                    <td>
                      {device.revokedAt ? (
                        <Badge label="Revoked" tone="danger" glyph="✕" />
                      ) : (
                        <Badge label="Active" tone="ok" glyph="●" />
                      )}
                    </td>
                    <td className="table__actions">
                      {!device.revokedAt && can(Permission.DEVICE_REVOKE) ? (
                        <button
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Revoke ${device.name}? It will be signed out immediately.`,
                              )
                            ) {
                              revoke.mutate(device.id);
                            }
                          }}
                          disabled={revoke.isPending}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export { formatBytes, formatDate, priorityBadge };
