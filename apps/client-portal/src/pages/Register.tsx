/**
 * Company registration.
 *
 * A long form, split into the four things it is actually asking about, because
 * a single column of eighteen inputs reads as a wall and gets abandoned. Only
 * the fields the company genuinely needs to start work are required; the rest
 * are marked optional and can be filled in later from the profile page.
 *
 * On success the account is created and signed in immediately. Making somebody
 * fill in eighteen fields and then type their password again on a login screen
 * is a needless step at the exact moment they are most likely to leave.
 */

import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';

import { PasswordField } from '../components/PasswordField';
import { Field, Notice } from '../components/ui';
import { api, ApiRequestError, registerClient } from '../lib/api';
import { useSession } from '../lib/session';
import { AuthAside } from './Login';

interface Availability {
  available: boolean;
  organizationName: string | null;
  reason?: string;
}

/** Common enough to be worth offering; "Other" keeps it from being a cage. */
const INDUSTRIES = [
  'Construction',
  'Real estate',
  'Facilities management',
  'Manufacturing',
  'Oil and gas',
  'Utilities',
  'Transport and logistics',
  'Hospitality',
  'Retail',
  'Healthcare',
  'Education',
  'Government',
  'Other',
];

interface FormState {
  companyName: string;
  industry: string;
  registrationNumber: string;
  taxNumber: string;
  contactName: string;
  contactDesignation: string;
  email: string;
  contactPhone: string;
  whatsapp: string;
  country: string;
  state: string;
  city: string;
  address: string;
  postalCode: string;
  website: string;
  notes: string;
  password: string;
  confirmPassword: string;
}

const EMPTY: FormState = {
  companyName: '',
  industry: '',
  registrationNumber: '',
  taxNumber: '',
  contactName: '',
  contactDesignation: '',
  email: '',
  contactPhone: '',
  whatsapp: '',
  country: '',
  state: '',
  city: '',
  address: '',
  postalCode: '',
  website: '',
  notes: '',
  password: '',
  confirmPassword: '',
};

export function Register(): React.ReactElement {
  const { status, signIn } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const availability = useQuery({
    queryKey: ['portal-registration'],
    queryFn: () => api.get<Availability>('/portal/registration'),
    retry: false,
  });

  if (status === 'authenticated') return <Navigate to="/client/dashboard" replace />;

  const set =
    (key: keyof FormState) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
      setFieldErrors((current) => {
        if (!(key in current)) return current;
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
    };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);

    // Checked here rather than server-side: the confirmation field exists only
    // to catch a typo in this browser, so the server never needs to see it.
    if (form.password !== form.confirmPassword) {
      setFieldErrors({ confirmPassword: 'The two passwords do not match.' });
      return;
    }

    setBusy(true);
    try {
      const { confirmPassword: _drop, ...payload } = form;
      await registerClient(payload);
      // Straight in — the account exists and they just typed the password.
      await signIn(form.email.trim(), form.password);
      navigate('/client/dashboard', { replace: true });
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setFieldErrors(err.fields ?? {});
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'The account could not be created.');
      }
      setBusy(false);
    }
  };

  if (availability.data && !availability.data.available) {
    return (
      <div className="auth">
        <AuthAside organizationName={availability.data.organizationName} />
        <div className="auth__panel">
          <div className="auth__form">
            <h1>Registration is closed</h1>
            <Notice kind="info">{availability.data.reason}</Notice>
            <Link className="btn btn--block" to="/client/login">
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <AuthAside organizationName={availability.data?.organizationName} />
      <div className="auth__panel">
        <form className="auth__form auth__form--wide" onSubmit={(e) => void submit(e)} noValidate>
          <div>
            <h1>Create a company account</h1>
            <p className="main__subtitle">
              {availability.data?.organizationName
                ? `Register with ${availability.data.organizationName} to request inspections online.`
                : 'Register to request inspections online.'}
            </p>
          </div>

          {error && <Notice>{error}</Notice>}

          <fieldset className="fieldset">
            <legend className="fieldset__legend">Company information</legend>
            <div className="form-grid">
              <Field label="Company name" required error={fieldErrors.companyName} full>
                <input
                  className="input"
                  value={form.companyName}
                  onChange={set('companyName')}
                  required
                  autoComplete="organization"
                />
              </Field>
              <Field label="Industry" error={fieldErrors.industry}>
                <select className="select" value={form.industry} onChange={set('industry')}>
                  <option value="">Select an industry</option>
                  {INDUSTRIES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Company registration number" error={fieldErrors.registrationNumber}>
                <input
                  className="input"
                  value={form.registrationNumber}
                  onChange={set('registrationNumber')}
                />
              </Field>
              <Field label="Tax number" error={fieldErrors.taxNumber}>
                <input className="input" value={form.taxNumber} onChange={set('taxNumber')} />
              </Field>
              <Field label="Website" hint="Optional — acme.com is fine" error={fieldErrors.website}>
                <input className="input" value={form.website} onChange={set('website')} />
              </Field>
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset__legend">Contact person</legend>
            <div className="form-grid">
              <Field label="Full name" required error={fieldErrors.contactName}>
                <input
                  className="input"
                  value={form.contactName}
                  onChange={set('contactName')}
                  required
                  autoComplete="name"
                />
              </Field>
              <Field label="Designation" error={fieldErrors.contactDesignation}>
                <input
                  className="input"
                  value={form.contactDesignation}
                  onChange={set('contactDesignation')}
                  placeholder="Facilities Manager"
                />
              </Field>
              <Field
                label="Email"
                required
                hint="This is how you sign in"
                error={fieldErrors.email}
              >
                <input
                  className="input"
                  type="email"
                  value={form.email}
                  onChange={set('email')}
                  required
                  autoComplete="email"
                />
              </Field>
              <Field label="Mobile number" required error={fieldErrors.contactPhone}>
                <input
                  className="input"
                  type="tel"
                  value={form.contactPhone}
                  onChange={set('contactPhone')}
                  required
                  autoComplete="tel"
                />
              </Field>
              <Field label="WhatsApp number" error={fieldErrors.whatsapp}>
                <input
                  className="input"
                  type="tel"
                  value={form.whatsapp}
                  onChange={set('whatsapp')}
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset__legend">Address</legend>
            <div className="form-grid">
              <Field label="Country" required error={fieldErrors.country}>
                <input
                  className="input"
                  value={form.country}
                  onChange={set('country')}
                  required
                  autoComplete="country-name"
                />
              </Field>
              <Field label="State or province" required error={fieldErrors.state}>
                <input
                  className="input"
                  value={form.state}
                  onChange={set('state')}
                  required
                  autoComplete="address-level1"
                />
              </Field>
              <Field label="City" required error={fieldErrors.city}>
                <input
                  className="input"
                  value={form.city}
                  onChange={set('city')}
                  required
                  autoComplete="address-level2"
                />
              </Field>
              <Field label="Postal code" error={fieldErrors.postalCode}>
                <input
                  className="input"
                  value={form.postalCode}
                  onChange={set('postalCode')}
                  autoComplete="postal-code"
                />
              </Field>
              <Field label="Complete address" required error={fieldErrors.address} full>
                <textarea
                  className="textarea"
                  style={{ minHeight: 80 }}
                  value={form.address}
                  onChange={set('address')}
                  required
                  autoComplete="street-address"
                />
              </Field>
            </div>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset__legend">Account</legend>
            <div className="form-grid">
              <PasswordField
                label="Password"
                required
                hint="At least 12 characters, with upper and lower case, a number and a symbol"
                error={fieldErrors.password}
                value={form.password}
                onChange={set('password')}
                autoComplete="new-password"
              />
              <PasswordField
                label="Confirm password"
                required
                error={fieldErrors.confirmPassword}
                value={form.confirmPassword}
                onChange={set('confirmPassword')}
                autoComplete="new-password"
              />
              <Field label="Anything we should know" hint="Optional" full>
                <textarea
                  className="textarea"
                  style={{ minHeight: 80 }}
                  value={form.notes}
                  onChange={set('notes')}
                />
              </Field>
            </div>
          </fieldset>

          <div className="form-actions">
            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Creating your account…' : 'Create account'}
            </button>
            <Link className="btn btn--ghost" to="/client/login">
              I already have an account
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
