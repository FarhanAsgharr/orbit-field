/**
 * Your details, and your company's.
 *
 * Two records behind one page, because a customer does not think of them as
 * separate: the person (name, phone, photo, password) lives on the user row,
 * the company (address, logo, website, tax numbers) on the client row. Each
 * saves independently so a failed company update does not lose a password
 * change.
 *
 * Email is shown and not editable. It is the login identity and the address
 * the company has on file — changing it from here would let somebody lock
 * themselves out with a typo and give support nothing to search on. It is an
 * administrator's to change.
 */

import { useMutation } from '@tanstack/react-query';
import React, { useState } from 'react';

import { Shell } from '../components/Shell';
import { PasswordField } from '../components/PasswordField';
import { Card, Field, Notice } from '../components/ui';
import { api, ApiRequestError } from '../lib/api';
import { useSession } from '../lib/session';

export function Profile(): React.ReactElement {
  const { user, company, refresh } = useSession();

  const [person, setPerson] = useState({
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    phone: user?.phone ?? '',
    avatarUrl: user?.avatarUrl ?? '',
  });

  const [org, setOrg] = useState({
    contactName: company?.contactName ?? '',
    contactDesignation: company?.contactDesignation ?? '',
    contactPhone: company?.contactPhone ?? '',
    whatsapp: company?.whatsapp ?? '',
    website: company?.website ?? '',
    industry: company?.industry ?? '',
    registrationNumber: company?.registrationNumber ?? '',
    taxNumber: company?.taxNumber ?? '',
    country: company?.country ?? '',
    state: company?.state ?? '',
    city: company?.city ?? '',
    postalCode: company?.postalCode ?? '',
    address: company?.address ?? '',
    logoUrl: company?.logoUrl ?? '',
  });

  const [passwords, setPasswords] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  /** Empty strings mean "clear it", which the API expects as null. */
  const nullable = (value: string): string | null => (value.trim() ? value.trim() : null);

  const savePerson = useMutation({
    mutationFn: () =>
      api.patch('/auth/profile', {
        firstName: person.firstName.trim(),
        lastName: person.lastName.trim(),
        phone: nullable(person.phone),
        avatarUrl: nullable(person.avatarUrl),
      }),
    onSuccess: async () => {
      await refresh();
      setNotice({ kind: 'ok', text: 'Your details were saved.' });
    },
    onError: (e) =>
      setNotice({
        kind: 'error',
        text: e instanceof Error ? e.message : 'That could not be saved.',
      }),
  });

  const saveCompany = useMutation({
    mutationFn: () =>
      api.patch('/portal/company', {
        contactName: org.contactName.trim() || undefined,
        contactDesignation: nullable(org.contactDesignation),
        contactPhone: org.contactPhone.trim() || undefined,
        whatsapp: nullable(org.whatsapp),
        website: nullable(org.website),
        industry: nullable(org.industry),
        registrationNumber: nullable(org.registrationNumber),
        taxNumber: nullable(org.taxNumber),
        country: org.country.trim() || undefined,
        state: org.state.trim() || undefined,
        city: org.city.trim() || undefined,
        postalCode: nullable(org.postalCode),
        address: org.address.trim() || undefined,
        logoUrl: nullable(org.logoUrl),
      }),
    onSuccess: async () => {
      await refresh();
      setNotice({ kind: 'ok', text: 'Your company details were saved.' });
    },
    onError: (e) =>
      setNotice({
        kind: 'error',
        text: e instanceof Error ? e.message : 'That could not be saved.',
      }),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      }),
    onSuccess: () => {
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPasswordError(null);
      setNotice({ kind: 'ok', text: 'Your password was changed.' });
    },
    onError: (e) => {
      setPasswordError(
        e instanceof ApiRequestError
          ? (e.fields?.newPassword ?? e.message)
          : e instanceof Error
            ? e.message
            : 'The password could not be changed.',
      );
    },
  });

  return (
    <Shell title="Profile" subtitle="Your details and your company's record.">
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

      <Card title="Your details">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            savePerson.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="First name" required>
              <input
                className="input"
                value={person.firstName}
                onChange={(e) => setPerson({ ...person, firstName: e.target.value })}
                required
              />
            </Field>
            <Field label="Last name">
              <input
                className="input"
                value={person.lastName}
                onChange={(e) => setPerson({ ...person, lastName: e.target.value })}
              />
            </Field>
            <Field label="Email" hint="Contact the team if this needs to change">
              <input className="input" value={user?.email ?? ''} disabled readOnly />
            </Field>
            <Field label="Phone number">
              <input
                className="input"
                type="tel"
                value={person.phone}
                onChange={(e) => setPerson({ ...person, phone: e.target.value })}
              />
            </Field>
            <Field
              label="Profile photo"
              hint="A link to an image — paste the address of a hosted photo"
              full
            >
              <input
                className="input"
                type="url"
                placeholder="https://…"
                value={person.avatarUrl}
                onChange={(e) => setPerson({ ...person, avatarUrl: e.target.value })}
              />
            </Field>
          </div>
          <div className="form-actions" style={{ marginTop: 20 }}>
            <button className="btn btn--primary" type="submit" disabled={savePerson.isPending}>
              {savePerson.isPending ? 'Saving…' : 'Save my details'}
            </button>
          </div>
        </form>
      </Card>

      <Card title="Company">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveCompany.mutate();
          }}
        >
          <div className="form-grid">
            <Field label="Company name" hint="Contact the team if this needs to change">
              <input className="input" value={company?.name ?? ''} disabled readOnly />
            </Field>
            <Field label="Industry">
              <input
                className="input"
                value={org.industry}
                onChange={(e) => setOrg({ ...org, industry: e.target.value })}
              />
            </Field>
            <Field label="Contact person">
              <input
                className="input"
                value={org.contactName}
                onChange={(e) => setOrg({ ...org, contactName: e.target.value })}
              />
            </Field>
            <Field label="Designation">
              <input
                className="input"
                value={org.contactDesignation}
                onChange={(e) => setOrg({ ...org, contactDesignation: e.target.value })}
              />
            </Field>
            <Field label="Phone number">
              <input
                className="input"
                type="tel"
                value={org.contactPhone}
                onChange={(e) => setOrg({ ...org, contactPhone: e.target.value })}
              />
            </Field>
            <Field label="WhatsApp number">
              <input
                className="input"
                type="tel"
                value={org.whatsapp}
                onChange={(e) => setOrg({ ...org, whatsapp: e.target.value })}
              />
            </Field>
            <Field label="Website">
              <input
                className="input"
                value={org.website}
                onChange={(e) => setOrg({ ...org, website: e.target.value })}
              />
            </Field>
            <Field label="Company registration number">
              <input
                className="input"
                value={org.registrationNumber}
                onChange={(e) => setOrg({ ...org, registrationNumber: e.target.value })}
              />
            </Field>
            <Field label="Tax number">
              <input
                className="input"
                value={org.taxNumber}
                onChange={(e) => setOrg({ ...org, taxNumber: e.target.value })}
              />
            </Field>
            <Field label="Country">
              <input
                className="input"
                value={org.country}
                onChange={(e) => setOrg({ ...org, country: e.target.value })}
              />
            </Field>
            <Field label="State or province">
              <input
                className="input"
                value={org.state}
                onChange={(e) => setOrg({ ...org, state: e.target.value })}
              />
            </Field>
            <Field label="City">
              <input
                className="input"
                value={org.city}
                onChange={(e) => setOrg({ ...org, city: e.target.value })}
              />
            </Field>
            <Field label="Postal code">
              <input
                className="input"
                value={org.postalCode}
                onChange={(e) => setOrg({ ...org, postalCode: e.target.value })}
              />
            </Field>
            <Field label="Company logo" hint="A link to your logo image" full>
              <input
                className="input"
                type="url"
                placeholder="https://…"
                value={org.logoUrl}
                onChange={(e) => setOrg({ ...org, logoUrl: e.target.value })}
              />
            </Field>
            <Field label="Complete address" full>
              <textarea
                className="textarea"
                style={{ minHeight: 80 }}
                value={org.address}
                onChange={(e) => setOrg({ ...org, address: e.target.value })}
              />
            </Field>
          </div>
          <div className="form-actions" style={{ marginTop: 20 }}>
            <button className="btn btn--primary" type="submit" disabled={saveCompany.isPending}>
              {saveCompany.isPending ? 'Saving…' : 'Save company details'}
            </button>
          </div>
        </form>
      </Card>

      <Card title="Password">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (passwords.newPassword !== passwords.confirmPassword) {
              setPasswordError('The two passwords do not match.');
              return;
            }
            changePassword.mutate();
          }}
        >
          {passwordError && <Notice>{passwordError}</Notice>}
          <div className="form-grid" style={{ marginTop: passwordError ? 16 : 0 }}>
            <PasswordField
              label="Current password"
              required
              autoComplete="current-password"
              value={passwords.currentPassword}
              onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })}
            />
            <PasswordField
              label="New password"
              required
              hint="At least 12 characters, mixed case, a number and a symbol"
              autoComplete="new-password"
              value={passwords.newPassword}
              onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })}
            />
            <PasswordField
              label="Confirm new password"
              required
              autoComplete="new-password"
              value={passwords.confirmPassword}
              onChange={(e) => setPasswords({ ...passwords, confirmPassword: e.target.value })}
            />
          </div>
          <div className="form-actions" style={{ marginTop: 20 }}>
            <button className="btn btn--primary" type="submit" disabled={changePassword.isPending}>
              {changePassword.isPending ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </Card>
    </Shell>
  );
}
