/**
 * Asking for an inspection.
 *
 * Files are attached *after* the request exists, not before, because an
 * attachment belongs to a request row — there is nothing to attach to until
 * one has been created. So the page has two states: the form, then the same
 * page showing the created request with an upload area. That is honest about
 * what happened (the request is in) and avoids the failure mode where a
 * 20 MB upload dies and takes a filled-in form with it.
 *
 * Location is asked for in words rather than as a dropdown of sites. A new
 * customer has no sites on file — those are created by staff once work is
 * real — so a picker would be an empty menu on the one form that must work on
 * day one.
 */

import { useMutation } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Attachments } from '../components/Attachments';
import { Shell } from '../components/Shell';
import { Card, Field, Notice } from '../components/ui';
import { api, ApiRequestError } from '../lib/api';

const PRIORITIES = [
  { value: 'LOW', label: 'Low — whenever it suits' },
  { value: 'NORMAL', label: 'Normal — in the usual course of work' },
  { value: 'HIGH', label: 'High — needed soon' },
  { value: 'CRITICAL', label: 'Critical — safety or operations at risk' },
];

interface Created {
  id: string;
  number: string;
}

export function NewRequest(): React.ReactElement {
  const navigate = useNavigate();
  const [created, setCreated] = useState<Created | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    title: '',
    projectName: '',
    siteName: '',
    siteAddress: '',
    inspectionType: '',
    description: '',
    priority: 'NORMAL',
    preferredDate: '',
    specialInstructions: '',
  });

  const set =
    (key: keyof typeof form) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
      setFieldErrors((current) => {
        if (!(key in current)) return current;
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
    };

  const submit = useMutation({
    mutationFn: () =>
      api.post<Created>('/inspection-requests', {
        title: form.title.trim(),
        description: form.description.trim() || null,
        projectName: form.projectName.trim() || null,
        siteName: form.siteName.trim() || null,
        siteAddress: form.siteAddress.trim() || null,
        inspectionType: form.inspectionType.trim() || null,
        specialInstructions: form.specialInstructions.trim() || null,
        priority: form.priority,
        // A date input gives a bare day; the API wants an instant.
        preferredDate: form.preferredDate
          ? new Date(`${form.preferredDate}T09:00:00`).toISOString()
          : null,
      }),
    onSuccess: (request) => {
      setCreated(request);
      setError(null);
      setFieldErrors({});
    },
    onError: (err) => {
      if (err instanceof ApiRequestError) {
        setFieldErrors(err.fields ?? {});
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'The request could not be submitted.');
      }
    },
  });

  if (created) {
    return (
      <Shell
        title="Request submitted"
        subtitle={`Reference ${created.number}. Attach anything that helps, then you are done.`}
      >
        <Notice kind="ok">
          Your request is with the team. You will see it move through the stages on the request
          page, and you can message them there at any time.
        </Notice>

        <Card title="Attach drawings, photos or documents">
          <Attachments requestId={created.id} />
        </Card>

        <div className="form-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => navigate(`/client/requests/${created.id}`)}
          >
            View the request
          </button>
          <Link className="btn" to="/client/requests">
            All my requests
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Create a request" subtitle="Tell the team what you need looked at.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit.mutate();
        }}
        noValidate
      >
        <div className="stack">
          {error && <Notice>{error}</Notice>}

          <Card title="What needs inspecting">
            <div className="form-grid">
              <Field
                label="Title"
                required
                hint="A short summary — this is what the team sees first"
                error={fieldErrors.title}
                full
              >
                <input
                  className="input"
                  value={form.title}
                  onChange={set('title')}
                  required
                  maxLength={300}
                  placeholder="Annual fire safety inspection — Tower B"
                />
              </Field>
              <Field label="Project name" error={fieldErrors.projectName}>
                <input className="input" value={form.projectName} onChange={set('projectName')} />
              </Field>
              <Field label="Site name" error={fieldErrors.siteName}>
                <input className="input" value={form.siteName} onChange={set('siteName')} />
              </Field>
              <Field label="Site address" error={fieldErrors.siteAddress} full>
                <textarea
                  className="textarea"
                  style={{ minHeight: 70 }}
                  value={form.siteAddress}
                  onChange={set('siteAddress')}
                  placeholder="Where should the inspector go?"
                />
              </Field>
              <Field
                label="Type of inspection"
                hint="Optional"
                error={fieldErrors.inspectionType}
                full
              >
                <input
                  className="input"
                  value={form.inspectionType}
                  onChange={set('inspectionType')}
                  placeholder="Electrical, structural, fire safety…"
                />
              </Field>
              <Field
                label="Problem description"
                hint="What is wrong, or what needs checking?"
                error={fieldErrors.description}
                full
              >
                <textarea
                  className="textarea"
                  value={form.description}
                  onChange={set('description')}
                />
              </Field>
            </div>
          </Card>

          <Card title="When and how urgent">
            <div className="form-grid">
              <Field label="Priority" required error={fieldErrors.priority}>
                <select className="select" value={form.priority} onChange={set('priority')}>
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Preferred date"
                hint="We will confirm what is possible"
                error={fieldErrors.preferredDate}
              >
                <input
                  className="input"
                  type="date"
                  value={form.preferredDate}
                  onChange={set('preferredDate')}
                  min={new Date().toISOString().slice(0, 10)}
                />
              </Field>
              <Field label="Access or site instructions" hint="Optional" full>
                <textarea
                  className="textarea"
                  style={{ minHeight: 70 }}
                  value={form.specialInstructions}
                  onChange={set('specialInstructions')}
                  placeholder="Gate code, who to ask for, parking, permits needed…"
                />
              </Field>
            </div>
          </Card>

          <Notice kind="info">
            You can attach drawings, photos and documents on the next step, once the request has a
            reference.
          </Notice>

          <div className="form-actions">
            <button
              className="btn btn--primary"
              type="submit"
              disabled={submit.isPending || !form.title.trim()}
            >
              {submit.isPending ? 'Submitting…' : 'Submit request'}
            </button>
            <Link className="btn btn--ghost" to="/client/requests">
              Cancel
            </Link>
          </div>
        </div>
      </form>
    </Shell>
  );
}
