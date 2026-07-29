/**
 * The portal's front door.
 *
 * Whose portal this is comes from the server rather than being hard-coded, so
 * a customer sees the name of the company they actually deal with — the same
 * call tells the page whether to offer registration at all.
 */

import React, { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';

import { usePortalPath, useTenant } from '../App';
import { PasswordField } from '../components/PasswordField';
import { Field, Notice } from '../components/ui';
import { useSession } from '../lib/session';

export function AuthAside({ organizationName }: { organizationName?: string | null }) {
  return (
    <aside className="auth__aside">
      <div className="auth__mark">
        <span className="auth__glyph" aria-hidden="true" />
        Orbit Field
      </div>
      <div>
        <h2>Inspections, without the phone calls.</h2>
        <ul className="auth__points">
          <li>
            <span aria-hidden="true">→</span> Ask for an inspection and attach the drawings with it
          </li>
          <li>
            <span aria-hidden="true">→</span> Watch it move from request to site visit to report
          </li>
          <li>
            <span aria-hidden="true">→</span> Message the team on the request itself
          </li>
          <li>
            <span aria-hidden="true">→</span> Download every finished report whenever you need it
          </li>
        </ul>
      </div>
      <p style={{ opacity: 0.75, fontSize: 13 }}>
        {organizationName ? `Client portal for ${organizationName}` : 'Client portal'}
      </p>
    </aside>
  );
}

export function Login(): React.ReactElement {
  const { signIn, status, busy, error, setError } = useSession();
  const location = useLocation();
  const path = usePortalPath();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const tenant = useTenant();

  if (status === 'authenticated') {
    const to = (location.state as { from?: string } | null)?.from ?? path('/dashboard');
    return <Navigate to={to} replace />;
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    void signIn(email.trim(), password).catch(() => undefined);
  };

  return (
    <div className="auth">
      <AuthAside organizationName={tenant.name} />
      <div className="auth__panel">
        <form className="auth__form" onSubmit={submit} noValidate>
          <div>
            <h1>Sign in</h1>
            <p className="main__subtitle">Your inspections with {tenant.name}.</p>
          </div>

          {error && <Notice>{error}</Notice>}

          <Field label="Email" required>
            <input
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              required
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(null);
              }}
            />
          </Field>

          <PasswordField
            label="Password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
          />

          <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          {tenant.registrationOpen ? (
            <p className="faint" style={{ textAlign: 'center' }}>
              New here? <Link to={path('/register')}>Create a company account</Link>
            </p>
          ) : (
            <p className="faint" style={{ textAlign: 'center' }}>
              {tenant.name} creates client accounts directly. Contact them for a login.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
