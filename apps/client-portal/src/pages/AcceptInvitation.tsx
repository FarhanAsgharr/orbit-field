/**
 * Accepting an invitation.
 *
 * The only way an account comes into existence now. Everything about the
 * person — their company, their name, the address they will sign in with —
 * came from the invitation an administrator issued, so the one thing this page
 * asks for is a password.
 *
 * There is no form to fill in and nothing to get wrong, which is the point:
 * the old registration form let somebody type a company name that did not
 * match the company they were actually dealing with.
 *
 * A link that has expired, been used, been cancelled or never existed produces
 * exactly the same screen, because the server answers all four identically.
 * Anything more helpful here would tell somebody holding a guessed link
 * whether they guessed a real one.
 */

import type { InvitationDetails } from '@orbit/types';
import { useMutation, useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { usePortalPath, useTenant } from '../App';
import { PasswordField } from '../components/PasswordField';
import { Loading, Notice } from '../components/ui';
import { api, ApiRequestError } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthAside } from './Login';

export function AcceptInvitation(): React.ReactElement {
  const { token = '' } = useParams();
  const tenant = useTenant();
  const path = usePortalPath();
  const navigate = useNavigate();
  const { signIn } = useSession();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const invitation = useQuery({
    queryKey: ['invitation', token],
    queryFn: () =>
      api.get<InvitationDetails>(`/portal/invitations/${token}`, { company: tenant.slug }),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      api.post<{ userId: string; email: string }>(`/portal/invitations/${token}/accept`, {
        password,
        organizationSlug: tenant.slug,
      }),
  });

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    // Checked here only: the confirmation exists to catch a typo in this
    // browser, so the server never needs to see it.
    if (password !== confirm) {
      setFieldError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await accept.mutateAsync();
      // Straight in: they have just chosen the password, so asking for it
      // again on a sign-in screen is a step that earns nothing.
      await signIn(invitation.data!.email, password);
      navigate(path('/dashboard'), { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError && err.fields?.password) {
        setFieldError(err.fields.password);
      } else {
        setError(
          err instanceof Error ? err.message : 'That did not work. Ask for a new invitation.',
        );
      }
      setBusy(false);
    }
  };

  if (invitation.isLoading) return <Loading label="Checking your invitation…" />;

  if (invitation.isError || !invitation.data) {
    return (
      <div className="auth">
        <AuthAside organizationName={tenant.name} />
        <div className="auth__panel">
          <div className="auth__form">
            <h1>This invitation is not valid</h1>
            <Notice>
              The link may have expired, or already been used. Ask {tenant.name} to send you a new
              one.
            </Notice>
          </div>
        </div>
      </div>
    );
  }

  const data = invitation.data;
  const expires = new Date(data.expiresAt);

  return (
    <div className="auth">
      <AuthAside organizationName={data.organizationName} />
      <div className="auth__panel">
        <form className="auth__form" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <h1>Set your password</h1>
            <p className="main__subtitle">
              {data.organizationName} has invited you to their client portal.
            </p>
          </div>

          {error && <Notice>{error}</Notice>}

          {/*
            Everything below comes from the invitation and none of it is
            editable. Showing it is how the recipient confirms the link was
            meant for them before committing to a password.
          */}
          <dl className="details" style={{ gridTemplateColumns: '1fr' }}>
            <div>
              <dt className="details__term">Company</dt>
              <dd className="details__value">{data.organizationName}</dd>
            </div>
            <div>
              <dt className="details__term">Your company</dt>
              <dd className="details__value">{data.clientName}</dd>
            </div>
            {(data.firstName || data.lastName) && (
              <div>
                <dt className="details__term">Contact person</dt>
                <dd className="details__value">
                  {`${data.firstName ?? ''} ${data.lastName ?? ''}`.trim()}
                </dd>
              </div>
            )}
            <div>
              <dt className="details__term">Email</dt>
              <dd className="details__value">{data.email}</dd>
            </div>
          </dl>

          <PasswordField
            label="Password"
            required
            hint="At least 12 characters, with upper and lower case, a number and a symbol"
            error={fieldError ?? undefined}
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <PasswordField
            label="Confirm password"
            required
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />

          <button
            className="btn btn--primary btn--block"
            type="submit"
            disabled={busy || !password || !confirm}
          >
            {busy ? 'Activating your account…' : 'Activate my account'}
          </button>

          <p className="faint" style={{ textAlign: 'center' }}>
            This invitation is valid until{' '}
            {expires.toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
            .
          </p>
        </form>
      </div>
    </div>
  );
}

/**
 * What is left where the registration form used to be.
 *
 * The route is kept so an old link explains itself rather than looking broken.
 */
export function RegistrationClosed(): React.ReactElement {
  const tenant = useTenant();
  const path = usePortalPath();

  return (
    <div className="auth">
      <AuthAside organizationName={tenant.name} />
      <div className="auth__panel">
        <div className="auth__form">
          <h1>Registration is by invitation only</h1>
          <Notice kind="info">
            Accounts on this portal are created by {tenant.name}. Please contact your service
            provider for an invitation link.
          </Notice>
          <a className="btn btn--block" href={path('/login')}>
            Back to sign in
          </a>
        </div>
      </div>
    </div>
  );
}
