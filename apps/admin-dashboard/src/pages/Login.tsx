/**
 * Sign in and create account.
 *
 * One screen with two modes rather than two routes: the two forms share a
 * container, and somebody who lands here unsure which they need can switch
 * without losing what they have typed.
 *
 * The create-account tab is hidden entirely when the installation has signup
 * disabled — offering a button that always returns 403 is worse than not
 * offering it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useSession } from '../lib/auth';
import { api } from '../lib/api';
import { ErrorBanner } from '../components/ui';
import { PasswordInput } from '../components/PasswordInput';

type Mode = 'signIn' | 'register';

/** Client-side mirror of the server's password policy. Advisory; the API decides. */
function assessPassword(password: string, context: { email?: string; firstName?: string }): {
  score: number;
  problems: string[];
} {
  const problems: string[] = [];
  if (password.length < 12) problems.push('At least 12 characters');
  if (!/[A-Z]/.test(password)) problems.push('An uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('A lowercase letter');
  if (!/\d/.test(password)) problems.push('A number');

  const lower = password.toLowerCase();
  for (const value of Object.values(context)) {
    if (!value || value.length < 3) continue;
    if (lower.includes(value.toLowerCase().split('@')[0] ?? '')) {
      problems.push('Must not contain your name or email');
      break;
    }
  }

  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  return { score: Math.min(4, score), problems };
}

export function Login(): React.ReactElement {
  const { signIn, signUp, busy, error } = useSession();
  const [mode, setMode] = useState<Mode>('signIn');
  const [signupAvailable, setSignupAvailable] = useState<boolean | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [touched, setTouched] = useState(false);

  // Asked once, unauthenticated, so the tab can be hidden rather than failing.
  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ available: boolean }>('/auth/signup-available')
      .then((r) => { if (!cancelled) setSignupAvailable(r.available); })
      .catch(() => { if (!cancelled) setSignupAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  const emailInvalid = touched && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const assessment = useMemo(
    () => assessPassword(password, { email, firstName }),
    [password, email, firstName],
  );

  const registerReady =
    email.trim() !== '' &&
    !emailInvalid &&
    firstName.trim() !== '' &&
    lastName.trim() !== '' &&
    organizationName.trim().length >= 2 &&
    assessment.problems.length === 0;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setTouched(true);

    try {
      if (mode === 'signIn') {
        if (!email.trim() || !password) return;
        await signIn(email.trim(), password);
      } else {
        if (!registerReady) return;
        await signUp({
          email: email.trim(),
          password,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          organizationName: organizationName.trim(),
        });
      }
    } catch {
      // The session context owns the message.
    }
  };

  const strengthColour =
    assessment.score >= 4 ? 'var(--ok)' : assessment.score >= 3 ? 'var(--warn)' : 'var(--danger)';

  return (
    <div className="login">
      <form className="login__card" onSubmit={(e) => void submit(e)}>
        <div className="login__brand">
          <span className="rail__glyph" aria-hidden="true" />
          <div>
            <div className="login__title">Orbit Field</div>
            <div className="small muted">Operations console</div>
          </div>
        </div>

        {/* The tab strip only appears where there is a genuine choice. */}
        {signupAvailable ? (
          <div className="tabs" role="tablist" aria-label="Sign in or create an account">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signIn'}
              className={`tabs__tab${mode === 'signIn' ? ' tabs__tab--active' : ''}`}
              onClick={() => setMode('signIn')}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`tabs__tab${mode === 'register' ? ' tabs__tab--active' : ''}`}
              onClick={() => setMode('register')}
            >
              Create account
            </button>
          </div>
        ) : null}

        {error ? <ErrorBanner message={error} /> : null}

        <div className="stack gap-4">
          {mode === 'register' ? (
            <>
              <div className="field">
                <label className="field__label" htmlFor="organizationName">Company or team name</label>
                <input
                  id="organizationName"
                  className="input"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  disabled={busy}
                  autoComplete="organization"
                  placeholder="Northwind Utilities"
                  required
                />
                <span className="field__hint">
                  This becomes your workspace. You can invite colleagues once you are in.
                </span>
              </div>

              <div className="row gap-3">
                <div className="field grow">
                  <label className="field__label" htmlFor="firstName">First name</label>
                  <input
                    id="firstName"
                    className="input"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    disabled={busy}
                    autoComplete="given-name"
                    required
                  />
                </div>
                <div className="field grow">
                  <label className="field__label" htmlFor="lastName">Last name</label>
                  <input
                    id="lastName"
                    className="input"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    disabled={busy}
                    autoComplete="family-name"
                    required
                  />
                </div>
              </div>
            </>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor="email">Email</label>
            <input
              id="email"
              className={`input${emailInvalid ? ' input--error' : ''}`}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={busy}
              required
            />
            {emailInvalid ? <span className="field__error">Enter a valid email address.</span> : null}
          </div>

          <PasswordInput
            id="password"
            label="Password"
            // A password manager offered the wrong entry here is a real
            // annoyance, so the two modes declare different intents.
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            required
            // While choosing a new password the user is reading it against the
            // strength rules below, so it stays visible until they move on.
            persistReveal={mode === 'register'}
            hint={
              mode === 'register' && password.length > 0 ? (
                <div className="stack gap-2 mt-2">
                  <div className="bar">
                    <div
                      className="bar__fill"
                      style={{ width: `${(assessment.score / 4) * 100}%`, background: strengthColour }}
                    />
                  </div>
                  {assessment.problems.length > 0 ? (
                    <ul className="stack gap-1" style={{ margin: 0, paddingLeft: 16 }}>
                      {assessment.problems.map((problem) => (
                        <li key={problem} className="small muted">{problem}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="small" style={{ color: 'var(--ok)' }}>
                      Strong enough
                    </span>
                  )}
                </div>
              ) : null
            }
          />

          <button
            className="btn"
            type="submit"
            disabled={busy || (mode === 'register' && !registerReady)}
            style={{ width: '100%', height: 38 }}
          >
            {busy
              ? mode === 'register' ? 'Creating your workspace…' : 'Signing in…'
              : mode === 'register' ? 'Create account' : 'Sign in'}
          </button>

          {mode === 'register' ? (
            // Says what actually happens next, so the empty dashboard that
            // follows is expected rather than alarming.
            <p className="small muted" style={{ textAlign: 'center' }}>
              You will be signed in as the administrator of a new workspace, with one starter
              checklist ready to edit.
            </p>
          ) : (
            <p className="small muted" style={{ textAlign: 'center' }}>
              For supervisors and administrators. Field inspections are carried out in the Orbit
              Field mobile app.
            </p>
          )}
        </div>
      </form>
    </div>
  );
}
