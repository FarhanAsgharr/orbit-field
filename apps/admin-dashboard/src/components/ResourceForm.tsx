/**
 * Create and edit the reference data an organisation is built from.
 *
 * Clients, projects, sites and assets already had a complete REST surface —
 * `buildResourceRouter` gives each of them list, read, create, update and
 * delete, and each write reaches devices through the change log. What was
 * missing was any way to reach it: every one of those console pages was a
 * read-only table. An administrator setting up a new company could see the
 * empty lists and had nothing to press, so the whole chain — project, then
 * site, then asset, then an inspection against them — could only be built by
 * calling the API by hand.
 *
 * One component covers all four because the server treats them the same way.
 * The differences that matter are which fields exist and which are required,
 * so those are declared per resource and everything else is shared.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import { api } from '../lib/api';
import { ErrorBanner } from './ui';

/** Everything a field on these forms can hold. Deliberately not `unknown`. */
type FieldValue = string | number | boolean | null;

/** Narrow an API value to something a text input can render. */
const asText = (v: FieldValue): string => (v === null || v === undefined ? '' : String(v));

type FieldKind = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date';

interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
  /** Reference list to populate a select from, e.g. `/clients`. */
  source?: 'clients' | 'projects' | 'sites' | 'people';
  options?: Array<{ value: string; label: string }>;
}

export interface ResourceSpec {
  /** API path and query key, e.g. `projects`. */
  endpoint: string;
  singular: string;
  fields: FieldSpec[];
}

export const RESOURCES: Record<string, ResourceSpec> = {
  clients: {
    endpoint: 'clients',
    singular: 'client',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', required: true },
      { key: 'code', label: 'Reference code', kind: 'text' },
      { key: 'contactName', label: 'Contact', kind: 'text' },
      { key: 'contactEmail', label: 'Contact email', kind: 'text' },
      { key: 'contactPhone', label: 'Contact phone', kind: 'text' },
      { key: 'address', label: 'Address', kind: 'textarea' },
    ],
  },
  projects: {
    endpoint: 'projects',
    singular: 'project',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', required: true },
      { key: 'code', label: 'Project code', kind: 'text', required: true },
      { key: 'clientId', label: 'Client', kind: 'select', source: 'clients' },
      {
        key: 'managerId',
        label: 'Project manager',
        kind: 'select',
        source: 'people',
        hint: 'Accountable for the work in this project.',
      },
      { key: 'description', label: 'Description', kind: 'textarea' },
      { key: 'startDate', label: 'Starts', kind: 'date' },
      { key: 'endDate', label: 'Ends', kind: 'date' },
      {
        key: 'isActive',
        label: 'Active',
        kind: 'checkbox',
        hint: 'Clear this to archive the project without deleting its history.',
      },
    ],
  },
  sites: {
    endpoint: 'sites',
    singular: 'site',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', required: true },
      { key: 'code', label: 'Site code', kind: 'text' },
      { key: 'clientId', label: 'Client', kind: 'select', source: 'clients' },
      { key: 'projectId', label: 'Project', kind: 'select', source: 'projects' },
      { key: 'address', label: 'Address', kind: 'textarea' },
      { key: 'region', label: 'Region', kind: 'text', hint: 'Used to group sites in reports.' },
      { key: 'latitude', label: 'Latitude', kind: 'number' },
      { key: 'longitude', label: 'Longitude', kind: 'number' },
      {
        key: 'geofenceRadiusMeters',
        label: 'Geofence radius (m)',
        kind: 'number',
        hint: 'Needs coordinates — a radius with no centre never applies.',
      },
      { key: 'contactName', label: 'Site contact', kind: 'text' },
      { key: 'contactPhone', label: 'Contact phone', kind: 'text' },
      { key: 'isActive', label: 'Active', kind: 'checkbox' },
    ],
  },
  assets: {
    endpoint: 'assets',
    singular: 'asset',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', required: true },
      {
        key: 'tag',
        label: 'Asset tag',
        kind: 'text',
        required: true,
        hint: 'The label on the equipment.',
      },
      { key: 'siteId', label: 'Site', kind: 'select', source: 'sites' },
      { key: 'category', label: 'Type', kind: 'text' },
      { key: 'manufacturer', label: 'Manufacturer', kind: 'text' },
      { key: 'model', label: 'Model', kind: 'text' },
      { key: 'serialNumber', label: 'Serial number', kind: 'text' },
      {
        key: 'qrCode',
        label: 'QR code',
        kind: 'text',
        hint: 'What an inspector scans on site to open this asset.',
      },
      { key: 'barcode', label: 'Barcode', kind: 'text' },
      { key: 'latitude', label: 'Latitude', kind: 'number' },
      { key: 'longitude', label: 'Longitude', kind: 'number' },
      { key: 'isActive', label: 'Active', kind: 'checkbox' },
    ],
  },
};

/** Options for a select, drawn from the resource it points at. */
function useOptions(source: FieldSpec['source']): Array<{ value: string; label: string }> {
  const path =
    source === 'people'
      ? '/users'
      : source === 'clients'
        ? '/clients'
        : source === 'projects'
          ? '/projects'
          : '/sites';

  const query = useQuery({
    queryKey: ['ref', source],
    enabled: Boolean(source),
    queryFn: () =>
      api.get<{
        items: Array<{
          id: string;
          name?: string;
          code?: string;
          firstName?: string;
          lastName?: string;
          status?: string;
        }>;
      }>(path, { pageSize: 200 }),
  });

  return (query.data?.items ?? [])
    .filter((i) => (source === 'people' ? i.status === 'ACTIVE' : true))
    .map((i) => ({
      value: i.id,
      label:
        source === 'people'
          ? `${i.firstName ?? ''} ${i.lastName ?? ''}`.trim()
          : i.code
            ? `${i.code} — ${i.name ?? ''}`
            : (i.name ?? i.id),
    }));
}

function Field({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: FieldValue;
  onChange: (v: FieldValue) => void;
}): React.ReactElement {
  const id = `res-${spec.key}`;
  const options = useOptions(spec.source);

  if (spec.kind === 'checkbox') {
    return (
      <label className="row gap-2" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value !== false}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>
          {spec.label}
          {spec.hint ? <span className="field__hint"> — {spec.hint}</span> : null}
        </span>
      </label>
    );
  }

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {spec.label}
        {spec.required ? '' : <span className="muted"> (optional)</span>}
      </label>

      {spec.kind === 'select' ? (
        <select
          id={id}
          className="select"
          value={asText(value)}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">None</option>
          {(spec.options ?? options).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : spec.kind === 'textarea' ? (
        <textarea
          id={id}
          className="input"
          rows={3}
          value={asText(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={spec.kind === 'number' ? 'number' : spec.kind === 'date' ? 'date' : 'text'}
          step={spec.kind === 'number' ? 'any' : undefined}
          value={asText(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {spec.hint ? <span className="field__hint">{spec.hint}</span> : null}
    </div>
  );
}

export function ResourceForm({
  spec,
  existing,
  onDone,
  onCancel,
}: {
  spec: ResourceSpec;
  existing?: Record<string, FieldValue> & { id: string };
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, FieldValue>>(() => {
    const initial: Record<string, FieldValue> = {};
    for (const f of spec.fields) {
      const raw = existing?.[f.key] as FieldValue;
      // `date` inputs want YYYY-MM-DD; the API returns full ISO timestamps.
      initial[f.key] =
        f.kind === 'date' && typeof raw === 'string' ? raw.slice(0, 10) : (raw ?? '');
    }
    return initial;
  });

  const payload = (): Record<string, FieldValue> => {
    const out: Record<string, FieldValue> = {};
    for (const f of spec.fields) {
      const v = form[f.key];
      if (f.kind === 'checkbox') {
        out[f.key] = v !== false;
      } else if (f.kind === 'number') {
        // An empty number field means "not set", not zero.
        out[f.key] = v === '' || v === null || v === undefined ? null : Number(v);
      } else if (f.kind === 'date') {
        out[f.key] = v ? new Date(asText(v ?? null)).toISOString() : null;
      } else if (f.kind === 'select') {
        out[f.key] = v || null;
      } else {
        const text = asText(v ?? null).trim();
        out[f.key] = text === '' ? (f.required ? '' : null) : text;
      }
    }
    return out;
  };

  const save = useMutation({
    mutationFn: () =>
      existing
        ? api.patch(`/${spec.endpoint}/${existing.id}`, payload())
        : api.post(`/${spec.endpoint}`, payload()),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [spec.endpoint] });
      // The selects on other forms read these lists too.
      void queryClient.invalidateQueries({ queryKey: ['ref'] });
      onDone();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : `Could not save the ${spec.singular}.`),
  });

  const ready = spec.fields
    .filter((f) => f.required)
    .every((f) => asText(form[f.key] ?? null).trim() !== '');

  return (
    <div
      className="card modal"
      role="dialog"
      aria-modal="true"
      aria-label={existing ? `Edit ${spec.singular}` : `New ${spec.singular}`}
    >
      <div className="card__head">
        <h2 className="card__title">
          {existing ? `Edit ${spec.singular}` : `New ${spec.singular}`}
        </h2>
        <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </button>
      </div>

      <div className="card__body stack gap-4">
        {error ? <ErrorBanner message={error} /> : null}

        {spec.fields.map((f) => (
          <Field
            key={f.key}
            spec={f}
            value={form[f.key] ?? null}
            onChange={(v) => setForm((prev) => ({ ...prev, [f.key]: v }))}
          />
        ))}

        <button className="btn" onClick={() => save.mutate()} disabled={save.isPending || !ready}>
          {save.isPending ? 'Saving…' : existing ? 'Save changes' : `Create ${spec.singular}`}
        </button>
      </div>
    </div>
  );
}

/**
 * The button, the modal, and the row action, wired together.
 *
 * Returned as a pair so a list page adds create and edit in two lines rather
 * than repeating the modal plumbing four times.
 */
export function useResourceEditor(key: keyof typeof RESOURCES): {
  toolbarAction: React.ReactNode;
  editAction: (row: Record<string, FieldValue> & { id: string }) => React.ReactNode;
  modal: React.ReactNode;
} {
  const spec = RESOURCES[key]!;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<(Record<string, FieldValue> & { id: string }) | null>(
    null,
  );

  const close = (): void => {
    setCreating(false);
    setEditing(null);
  };

  const open = creating || editing !== null;

  return {
    toolbarAction: (
      <button className="btn" onClick={() => setCreating(true)}>
        New {spec.singular}
      </button>
    ),
    editAction: (row) => (
      <button className="btn btn--ghost btn--sm" onClick={() => setEditing(row)}>
        Edit
      </button>
    ),
    modal: open ? (
      <div
        className="modal__backdrop"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <ResourceForm spec={spec} existing={editing ?? undefined} onDone={close} onCancel={close} />
      </div>
    ) : null,
  };
}
