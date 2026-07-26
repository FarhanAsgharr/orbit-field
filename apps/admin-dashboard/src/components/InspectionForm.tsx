/**
 * Scheduling an inspection from the console.
 *
 * The counterpart to the offline path: an inspector creates work on their
 * phone in front of the asset, an administrator plans it a week ahead and hands
 * it to somebody. Both end in the same row.
 *
 * Two things the form is careful about, because getting either wrong wastes a
 * site visit:
 *
 *  - **Only published checklists are offered.** A draft has no questions, so an
 *    inspection against one renders as a blank form to somebody standing on a
 *    roof. The server refuses it too; filtering the list means nobody has to
 *    discover the rule by being rejected.
 *  - **Only active people are offered as assignees.** Work handed to a
 *    deactivated account is work nobody receives, and nothing about the
 *    inspection would look wrong afterwards.
 *
 * The inspection number is deliberately absent: it is allocated by the server
 * from a per-organisation sequence, because two administrators scheduling at
 * the same moment must not be handed the same reference.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import { api } from '../lib/api';
import { ErrorBanner } from './ui';

export interface InspectionRecord {
  id: string;
  number: string;
  title: string;
  description: string | null;
  notes: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  templateId: string;
  projectId: string | null;
  siteId: string | null;
  assignedToId: string | null;
}

interface Option {
  id: string;
  label: string;
}

/** Reference data for the dropdowns, loaded once and shared by both modes. */
function useReferenceData(): {
  templates: Option[];
  projects: Option[];
  sites: Option[];
  people: Option[];
  loading: boolean;
} {
  const templates = useQuery({
    queryKey: ['ref', 'templates'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string; activeVersionId: string | null }> }>(
        '/templates',
        { pageSize: 200 },
      ),
  });
  const projects = useQuery({
    queryKey: ['ref', 'projects'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string; code: string }> }>('/projects', {
        pageSize: 200,
      }),
  });
  const sites = useQuery({
    queryKey: ['ref', 'sites'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string }> }>('/sites', { pageSize: 200 }),
  });
  const people = useQuery({
    queryKey: ['ref', 'people'],
    queryFn: () =>
      api.get<{
        items: Array<{ id: string; firstName: string; lastName: string; status: string }>;
      }>('/users', { pageSize: 200 }),
  });

  return {
    // Unpublished checklists are omitted rather than shown and refused.
    templates: (templates.data?.items ?? [])
      .filter((t) => t.activeVersionId)
      .map((t) => ({ id: t.id, label: t.name })),
    projects: (projects.data?.items ?? []).map((p) => ({
      id: p.id,
      label: `${p.code} — ${p.name}`,
    })),
    sites: (sites.data?.items ?? []).map((s) => ({ id: s.id, label: s.name })),
    people: (people.data?.items ?? [])
      .filter((u) => u.status === 'ACTIVE')
      .map((u) => ({ id: u.id, label: `${u.firstName} ${u.lastName}` })),
    loading: templates.isLoading || projects.isLoading || sites.isLoading || people.isLoading,
  };
}

function Select({
  id,
  label,
  value,
  options,
  onChange,
  placeholder,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  placeholder: string;
  hint?: string;
}): React.ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  );
}

const EMPTY = {
  title: '',
  description: '',
  notes: '',
  templateId: '',
  projectId: '',
  siteId: '',
  assignedToId: '',
  priority: 'NORMAL',
  status: 'SCHEDULED',
  dueAt: '',
};

/**
 * The form itself, used for both scheduling and editing.
 *
 * `existing` switches it between POST and PATCH. The fields are the same in
 * both directions, which is the point — an administrator correcting a mistake
 * should not meet a different form from the one that made it.
 */
export function InspectionForm({
  existing,
  onDone,
  onCancel,
}: {
  existing?: InspectionRecord;
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const ref = useReferenceData();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(
    existing
      ? {
          title: existing.title,
          description: existing.description ?? '',
          notes: existing.notes ?? '',
          templateId: existing.templateId,
          projectId: existing.projectId ?? '',
          siteId: existing.siteId ?? '',
          assignedToId: existing.assignedToId ?? '',
          priority: existing.priority,
          status: existing.status,
          // `datetime-local` wants `YYYY-MM-DDTHH:mm` and nothing else.
          dueAt: existing.dueAt ? existing.dueAt.slice(0, 16) : '',
        }
      : EMPTY,
  );

  const set = (patch: Partial<typeof EMPTY>): void => setForm({ ...form, ...patch });

  const payload = (): Record<string, unknown> => ({
    title: form.title.trim(),
    description: form.description.trim() || null,
    notes: form.notes.trim() || null,
    templateId: form.templateId,
    projectId: form.projectId || null,
    siteId: form.siteId || null,
    assignedToId: form.assignedToId || null,
    priority: form.priority,
    ...(existing ? {} : { status: form.status }),
    dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
  });

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/inspections/${existing.id}`, payload())
        : api.post('/inspections', payload()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inspections'] });
      onDone();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not save the inspection.'),
  });

  const ready = form.title.trim() !== '' && form.templateId !== '';

  return (
    <div
      className="card modal"
      role="dialog"
      aria-modal="true"
      aria-label={existing ? 'Edit inspection' : 'Schedule an inspection'}
    >
      <div className="card__head">
        <h2 className="card__title">
          {existing ? `Edit ${existing.number}` : 'Schedule an inspection'}
        </h2>
        <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
      </div>

      <div className="card__body stack gap-4">
        {error ? <ErrorBanner message={error} /> : null}

        <div className="field">
          <span className="field__label">Reference</span>
          <code className="input" style={{ display: 'block' }}>
            {existing ? existing.number : 'Allocated when you save'}
          </code>
          {!existing ? (
            <span className="field__hint">
              Numbers come from a per-organisation sequence, so two people scheduling at once cannot
              be given the same one.
            </span>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="insp-title">
            Title
          </label>
          <input
            id="insp-title"
            className="input"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="insp-desc">
            Description
          </label>
          <textarea
            id="insp-desc"
            className="input"
            rows={3}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
          <span className="field__hint">What this visit is for. Visible to the inspector.</span>
        </div>

        <Select
          id="insp-template"
          label="Checklist"
          value={form.templateId}
          options={ref.templates}
          onChange={(v) => set({ templateId: v })}
          placeholder={ref.loading ? 'Loading…' : 'Choose a checklist'}
          hint="Only published checklists appear — a draft has no questions to answer."
        />

        <Select
          id="insp-project"
          label="Project"
          value={form.projectId}
          options={ref.projects}
          onChange={(v) => set({ projectId: v })}
          placeholder="No project"
        />

        <Select
          id="insp-site"
          label="Site"
          value={form.siteId}
          options={ref.sites}
          onChange={(v) => set({ siteId: v })}
          placeholder="No site"
        />

        <Select
          id="insp-assignee"
          label="Assigned inspector"
          value={form.assignedToId}
          options={ref.people}
          onChange={(v) => set({ assignedToId: v })}
          placeholder="Unassigned"
          hint="They receive it on their phone at the next sync."
        />

        <div className="row gap-3">
          <div className="field grow">
            <label className="field__label" htmlFor="insp-priority">
              Priority
            </label>
            <select
              id="insp-priority"
              className="select"
              value={form.priority}
              onChange={(e) => set({ priority: e.target.value })}
            >
              {['LOW', 'NORMAL', 'HIGH', 'CRITICAL'].map((p) => (
                <option key={p} value={p}>
                  {p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="field grow">
            <label className="field__label" htmlFor="insp-due">
              Due
            </label>
            <input
              id="insp-due"
              className="input"
              type="datetime-local"
              value={form.dueAt}
              onChange={(e) => set({ dueAt: e.target.value })}
            />
          </div>
        </div>

        {!existing ? (
          <div className="field">
            <label className="field__label" htmlFor="insp-status">
              Status
            </label>
            <select
              id="insp-status"
              className="select"
              value={form.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="SCHEDULED">Scheduled — ready for the inspector</option>
              <option value="DRAFT">Draft — not yet released</option>
            </select>
            <span className="field__hint">
              Work in progress or beyond is reached by doing the inspection, not by setting it here.
            </span>
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="insp-notes">
            Notes
          </label>
          <textarea
            id="insp-notes"
            className="input"
            rows={2}
            value={form.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
          <span className="field__hint">
            Access instructions, contacts, anything site-specific.
          </span>
        </div>

        <button className="btn" onClick={() => save.mutate()} disabled={save.isPending || !ready}>
          {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Schedule inspection'}
        </button>
      </div>
    </div>
  );
}
