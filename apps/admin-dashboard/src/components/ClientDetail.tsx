/**
 * A client's full record, and what staff can do to it.
 *
 * Exists because the Clients table cannot show twenty-two fields and should not
 * try. The table answers "which client", this answers "everything about this
 * one" — including the portal logins attached to it, which is the part with no
 * home anywhere else in the console.
 *
 * The four actions are here rather than on the table row on purpose. Deactivate,
 * reactivate, delete and reset-password all change something a customer will
 * notice, and putting them behind a click into the record means nobody fires
 * one by aiming badly at a dense table.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import { api } from '../lib/api';
import { PORTAL_URL } from '../lib/config';
import { PasswordInput } from './PasswordInput';
import { Badge, ErrorBanner } from './ui';

export interface ClientPortalUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  lastLoginAt: string | null;
}

export interface ClientRecord {
  id: string;
  name: string;
  code: string | null;
  logoUrl: string | null;
  industry: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  website: string | null;
  contactName: string | null;
  contactDesignation: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  whatsapp: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  postalCode: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  portalUsers?: ClientPortalUser[];
  _count: { projects: number; sites: number; inspections: number; requests: number };
}

const show = (value: string | null | undefined): React.ReactNode =>
  value?.trim() ? value : <span className="muted">—</span>;

const date = (value: string | null | undefined): string => {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
};

function Row({ term, children }: { term: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="small muted">{term}</div>
      <div>{children}</div>
    </div>
  );
}

export function ClientDetail({
  client,
  onEdit,
  onClose,
}: {
  client: ClientRecord;
  onEdit: () => void;
  onClose: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<ClientPortalUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [creatingLogin, setCreatingLogin] = useState(false);
  const [newLogin, setNewLogin] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
  });
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  // Re-read on open: the row in the table may be a page or two old, and the
  // portal logins are not carried on the list response the table caches.
  const record = useQuery({
    queryKey: ['client', client.id],
    queryFn: () => api.get<ClientRecord>(`/clients/${client.id}`),
    initialData: client,
  });

  const data = record.data;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
    void queryClient.invalidateQueries({ queryKey: ['client', client.id] });
  };

  const setActive = useMutation({
    mutationFn: (isActive: boolean) => api.patch(`/clients/${client.id}`, { isActive }),
    onSuccess: (_result, isActive) => {
      setError(null);
      setNotice(isActive ? 'Client reactivated.' : 'Client deactivated.');
      refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'That could not be changed.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/clients/${client.id}`),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'That client could not be deleted.'),
  });

  /*
   * Resetting a portal password goes through the ordinary user endpoint.
   *
   * A client login is a User row like any other, so this is the same call an
   * administrator makes for a member of staff — same audit entry, same policy
   * check, same forced change on next sign-in. A second reset path for
   * customers would be a second place for that policy to drift.
   */
  const resetPassword = useMutation({
    mutationFn: () => api.post(`/users/${resetFor!.id}/reset-password`, { password: newPassword }),
    onSuccess: () => {
      setNotice(`Password reset for ${resetFor!.email}. Send it to them securely.`);
      setError(null);
      setResetFor(null);
      setNewPassword('');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'That password could not be reset.'),
  });

  /*
   * Give somebody at this company a way in.
   *
   * A client can register themselves through the portal, but that cannot be
   * the only route: an organisation that has turned self-registration off, or
   * a customer an administrator took on over the phone, needs staff to be able
   * to create the login. It is the ordinary `POST /users` call with role
   * CLIENT — same rank check, same password policy, same audit entry — with
   * the company taken from the record already on screen rather than picked
   * from a list, because there is only one right answer here.
   */
  const createLogin = useMutation({
    mutationFn: () =>
      api.post('/users', {
        email: newLogin.email.trim(),
        firstName: newLogin.firstName.trim(),
        lastName: newLogin.lastName.trim(),
        role: 'CLIENT',
        clientId: client.id,
        password: newLogin.password,
      }),
    onSuccess: () => {
      // Shown once, and the administrator still has to pass it on, so the
      // panel stays open rather than closing over the only copy.
      setIssued({ email: newLogin.email.trim(), password: newLogin.password });
      setCreatingLogin(false);
      setNewLogin({ firstName: '', lastName: '', email: '', password: '' });
      setError(null);
      refresh();
    },
    onError: (e) =>
      setError(e instanceof Error ? e.message : 'That portal login could not be created.'),
  });

  const loginReady =
    newLogin.firstName.trim() !== '' &&
    newLogin.email.trim() !== '' &&
    newLogin.password.length >= 12;
  return (
    <div
      className="card modal modal--wide"
      role="dialog"
      aria-modal="true"
      aria-label={`${data.name} details`}
    >
      <header className="card__head">
        <div className="row gap-3">
          {data.logoUrl ? (
            <img
              src={data.logoUrl}
              alt=""
              width={40}
              height={40}
              style={{ borderRadius: 8, objectFit: 'contain' }}
            />
          ) : null}
          <div>
            <h2 className="card__title">{data.name}</h2>
            <p className="small muted">
              {data.code ? `${data.code} · ` : ''}Client since {date(data.createdAt).split(',')[0]}
            </p>
          </div>
          <Badge
            label={data.isActive ? 'Active' : 'Deactivated'}
            tone={data.isActive ? 'ok' : 'neutral'}
          />
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onClose} aria-label="Close">
          Close
        </button>
      </header>

      <div className="card__body stack gap-4">
        {error ? <ErrorBanner message={error} /> : null}
        {notice ? (
          <p className="small" style={{ color: 'var(--ok)' }}>
            {notice}
          </p>
        ) : null}

        <div className="row gap-5">
          <div>
            <div className="metric__value">{data._count.requests}</div>
            <div className="metric__label">Requests</div>
          </div>
          <div>
            <div className="metric__value">{data._count.projects}</div>
            <div className="metric__label">Projects</div>
          </div>
          <div>
            <div className="metric__value">{data._count.sites}</div>
            <div className="metric__label">Sites</div>
          </div>
          <div>
            <div className="metric__value">{data._count.inspections}</div>
            <div className="metric__label">Inspections</div>
          </div>
        </div>

        <section>
          <h3 className="card__title">Company</h3>
          <div className="grid grid--4">
            <Row term="Industry">{show(data.industry)}</Row>
            <Row term="Registration number">{show(data.registrationNumber)}</Row>
            <Row term="Tax number">{show(data.taxNumber)}</Row>
            <Row term="Website">
              {data.website ? (
                <a href={data.website} target="_blank" rel="noreferrer noopener">
                  {data.website}
                </a>
              ) : (
                <span className="muted">—</span>
              )}
            </Row>
          </div>
        </section>

        <section>
          <h3 className="card__title">Contact</h3>
          <div className="grid grid--4">
            <Row term="Contact person">{show(data.contactName)}</Row>
            <Row term="Designation">{show(data.contactDesignation)}</Row>
            <Row term="Email">{show(data.contactEmail)}</Row>
            <Row term="Phone">{show(data.contactPhone)}</Row>
            <Row term="WhatsApp">{show(data.whatsapp)}</Row>
          </div>
        </section>

        <section>
          <h3 className="card__title">Address</h3>
          <div className="grid grid--4">
            <Row term="Country">{show(data.country)}</Row>
            <Row term="State or province">{show(data.state)}</Row>
            <Row term="City">{show(data.city)}</Row>
            <Row term="Postal code">{show(data.postalCode)}</Row>
          </div>
          <div style={{ marginTop: 12 }}>
            <Row term="Complete address">{show(data.address)}</Row>
          </div>
        </section>

        {data.notes ? (
          <section>
            <h3 className="card__title">Notes</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{data.notes}</p>
          </section>
        ) : null}

        <section>
          <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
            <h3 className="card__title">Portal logins</h3>
            {!creatingLogin && !issued ? (
              <button
                className="btn btn--sm"
                onClick={() => {
                  setCreatingLogin(true);
                  setIssued(null);
                  setError(null);
                }}
              >
                Create account
              </button>
            ) : null}
          </div>

          {issued ? (
            <div className="stack gap-2" style={{ marginTop: 12 }}>
              <p className="small">
                Give these to <strong>{issued.email}</strong> along with the portal address:{' '}
                <code>{PORTAL_URL}</code>
              </p>
              <div className="field">
                <span className="field__label">Password</span>
                <code className="input" style={{ display: 'block' }}>
                  {issued.password}
                </code>
                <span className="field__hint">
                  This is the only time it is shown. If it is lost, use Reset password below.
                </span>
              </div>
              <div className="row gap-2">
                <button className="btn btn--sm" onClick={() => setIssued(null)}>
                  Done
                </button>
              </div>
            </div>
          ) : null}

          {creatingLogin ? (
            <form
              className="stack gap-3"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                createLogin.mutate();
              }}
            >
              <div className="row gap-3">
                <div className="field grow">
                  <label className="field__label" htmlFor="cl-first">
                    First name
                  </label>
                  <input
                    id="cl-first"
                    className="input"
                    value={newLogin.firstName}
                    onChange={(e) => setNewLogin({ ...newLogin, firstName: e.target.value })}
                    required
                  />
                </div>
                <div className="field grow">
                  <label className="field__label" htmlFor="cl-last">
                    Last name
                  </label>
                  <input
                    id="cl-last"
                    className="input"
                    value={newLogin.lastName}
                    onChange={(e) => setNewLogin({ ...newLogin, lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="cl-email">
                  Email
                </label>
                <input
                  id="cl-email"
                  className="input"
                  type="email"
                  autoComplete="off"
                  value={newLogin.email}
                  onChange={(e) => setNewLogin({ ...newLogin, email: e.target.value })}
                  required
                />
                <span className="field__hint">This is the username they sign in with.</span>
              </div>
              <PasswordInput
                label="Password"
                value={newLogin.password}
                autoComplete="new-password"
                onChange={(e) => setNewLogin({ ...newLogin, password: e.target.value })}
                hint="At least 12 characters, with an uppercase letter, a lowercase letter and a number. It must not contain their name or email."
              />
              <div className="row gap-2">
                <button
                  className="btn btn--primary btn--sm"
                  type="submit"
                  disabled={createLogin.isPending || !loginReady}
                >
                  {createLogin.isPending ? 'Creating…' : 'Create account'}
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => setCreatingLogin(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {(data.portalUsers?.length ?? 0) === 0 ? (
            creatingLogin || issued ? null : (
              <p className="muted small">
                Nobody from this company can sign in to the portal yet. Create an account to give
                them access, or they can register themselves at the portal.
              </p>
            )
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Email</th>
                  <th>State</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.portalUsers?.map((portalUser) => (
                  <tr key={portalUser.id}>
                    <td>{`${portalUser.firstName} ${portalUser.lastName}`.trim()}</td>
                    <td className="small">{portalUser.email}</td>
                    <td>
                      <Badge
                        label={portalUser.status === 'ACTIVE' ? 'Active' : 'Suspended'}
                        tone={portalUser.status === 'ACTIVE' ? 'ok' : 'neutral'}
                      />
                    </td>
                    <td className="small muted">{date(portalUser.lastLoginAt)}</td>
                    <td>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          setResetFor(portalUser);
                          setNewPassword('');
                        }}
                      >
                        Reset password
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {resetFor ? (
            <form
              className="stack gap-2"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                resetPassword.mutate();
              }}
            >
              <label className="field">
                <span className="field__label">New password for {resetFor.email}</span>
                <input
                  className="input"
                  type="text"
                  value={newPassword}
                  autoComplete="off"
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={12}
                />
                <span className="field__hint">
                  Send it to them over a channel you trust — it is shown here once.
                </span>
              </label>
              <div className="row gap-2">
                <button
                  className="btn btn--primary btn--sm"
                  type="submit"
                  disabled={resetPassword.isPending}
                >
                  {resetPassword.isPending ? 'Resetting…' : 'Reset password'}
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => setResetFor(null)}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : null}
        </section>
      </div>

      <footer
        className="card__head"
        style={{ borderTop: '1px solid var(--border)', borderBottom: 0 }}
      >
        <div className="row gap-2">
          <button className="btn btn--primary" onClick={onEdit}>
            Edit client
          </button>
          <button
            className="btn"
            disabled={setActive.isPending}
            onClick={() => setActive.mutate(!data.isActive)}
          >
            {data.isActive ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>

        {/*
          Deletion is soft server-side, but it removes the client from every
          list staff use, so it asks twice. The confirm is inline rather than a
          browser dialog because a second modal over a modal is where people
          click through without reading.
        */}
        {confirmDelete ? (
          <div className="row gap-2">
            <span className="small">Delete {data.name}?</span>
            <button
              className="btn btn--danger btn--sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
      </footer>
    </div>
  );
}
