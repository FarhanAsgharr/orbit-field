/**
 * Authoring a checklist.
 *
 * The Templates page listed checklists and offered nothing else — no create,
 * no edit, no publish — while the API has had eleven routes for exactly that
 * since it was written. "Admins create Inspection Templates" was a step of the
 * documented workflow that could only be performed by calling the API by hand.
 *
 * Two rules shape this screen, and both come from the server:
 *
 *  - **A published version is immutable.** Editing one creates a new draft;
 *    the old version keeps rendering the questions an inspection was started
 *    with, which is what makes a two-year-old report reproducible. So the
 *    editor is only offered on a draft, and a published version is shown
 *    read-only with "Create a new draft" next to it.
 *  - **A checklist with no questions cannot be published.** It would reach an
 *    inspector as a blank form on a roof. Publish is disabled until there is
 *    something to answer.
 */

import { Permission } from '@orbit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Badge, Card, Empty, ErrorBanner, formatDate, Loading } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

const FIELD_TYPES = [
  'PASS_FAIL',
  'TEXT',
  'TEXT_AREA',
  'NUMBER',
  'SINGLE_CHOICE',
  'MULTI_CHOICE',
  'RATING',
  'DATE',
  'PHOTO',
  'SIGNATURE',
] as const;

/** Types where the inspector picks from a list, so options are required. */
const NEEDS_OPTIONS = new Set(['PASS_FAIL', 'SINGLE_CHOICE', 'MULTI_CHOICE']);

interface EditorField {
  id?: string;
  key: string;
  label: string;
  type: string;
  order: number;
  options: Array<{ value: string; label: string; score?: number; isFailure?: boolean }>;
  validation: { required?: boolean };
}

interface EditorSection {
  id?: string;
  title: string;
  order: number;
  fields: EditorField[];
}

interface Version {
  id: string;
  version: number;
  publishedAt: string | null;
  retiredAt: string | null;
  changeNote: string | null;
  definition?: { sections?: EditorSection[] };
}

interface TemplateDetailData {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  discipline: string | null;
  activeVersionId: string | null;
  isArchived: boolean;
  /** Summaries only — these deliberately carry no definition. */
  versions: Version[];
  /** The resolved version, with its definition. Defaults to the active one. */
  version: (Version & { definition?: { sections?: EditorSection[] } }) | null;
}

const passFailOptions = () => [
  { value: 'pass', label: 'Acceptable', score: 1 },
  { value: 'fail', label: 'Defect found', score: 0, isFailure: true },
];

const blankField = (order: number): EditorField => ({
  key: `field_${order + 1}`,
  label: '',
  type: 'PASS_FAIL',
  order,
  options: passFailOptions(),
  validation: { required: true },
});

export function TemplateDetail(): React.ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [sections, setSections] = useState<EditorSection[] | null>(null);
  const [meta, setMeta] = useState<{ name: string; category: string; description: string } | null>(
    null,
  );

  /*
   * Two requests, because the endpoint splits the data.
   *
   * `versions[]` carries summaries with no definition; the questions come back
   * in a separate `version` object which defaults to the *active* one. An
   * author works on the newest version, which on a template with a published
   * release is not the active one — so the definition has to be asked for by
   * id. Reading `versions[0].definition` returns undefined, and saving that
   * would replace the checklist with nothing.
   */
  const query = useQuery({
    queryKey: ['template', id],
    queryFn: () => api.get<TemplateDetailData>(`/templates/${id}`),
  });

  const latestId = query.data?.versions?.[0]?.id;
  const needsFetch = Boolean(latestId && query.data?.version?.id !== latestId);

  const latestVersion = useQuery({
    queryKey: ['template-version', id, latestId],
    enabled: needsFetch,
    queryFn: () =>
      api.get<TemplateDetailData>(`/templates/${id}`, { versionId: latestId as string }),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['template', id] });
    void queryClient.invalidateQueries({ queryKey: ['template-version', id] });
    void queryClient.invalidateQueries({ queryKey: ['templates'] });
    void queryClient.invalidateQueries({ queryKey: ['ref'] });
  };

  /** The newest version — the one an author works on. */
  const latest = query.data?.versions?.[0];
  const isDraft = latest ? latest.publishedAt === null : false;

  const resolved = needsFetch ? latestVersion.data?.version : query.data?.version;
  const stored = (resolved?.definition?.sections ?? []) as EditorSection[];
  const editing = sections ?? stored;

  const saveDraft = useMutation({
    mutationFn: () =>
      api.patch(`/templates/${id}/versions/${latest!.id}`, {
        definition: { sections: editing },
      }),
    onSuccess: () => {
      setSections(null);
      refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the checklist.'),
  });

  const saveMeta = useMutation({
    mutationFn: () =>
      api.patch(`/templates/${id}`, {
        name: meta!.name,
        category: meta!.category || null,
        description: meta!.description || null,
      }),
    onSuccess: () => {
      setMeta(null);
      refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the details.'),
  });

  const newDraft = useMutation({
    mutationFn: () => api.post(`/templates/${id}/versions`, {}),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not create a draft.'),
  });

  const publish = useMutation({
    mutationFn: () => api.post(`/templates/${id}/versions/${latest!.id}/publish`, {}),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not publish.'),
  });

  const clone = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/templates/${id}/clone`, {}),
    onSuccess: (created) => {
      refresh();
      navigate(`/templates/${created.id}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not clone.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/templates/${id}`),
    onSuccess: () => {
      refresh();
      navigate('/templates');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not delete.'),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) {
    return <Empty title="Checklist not found" body="It may have been deleted." />;
  }

  const t = query.data;
  const busy =
    saveDraft.isPending ||
    saveMeta.isPending ||
    newDraft.isPending ||
    publish.isPending ||
    clone.isPending ||
    remove.isPending;

  const fieldCount = editing.reduce((n, s) => n + s.fields.length, 0);
  const mutate = (next: EditorSection[]): void => setSections(next);

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">{t.name}</h1>
          <p className="page__subtitle">
            <Link to="/templates">Checklists</Link> · {t.category ?? 'Uncategorised'}
            {t.isArchived ? ' · archived' : ''}
          </p>
        </div>
        <div className="row gap-2">
          {can(Permission.TEMPLATE_WRITE) ? (
            <button className="btn btn--ghost" onClick={() => clone.mutate()} disabled={busy}>
              Duplicate
            </button>
          ) : null}
          {can(Permission.TEMPLATE_DELETE) ? (
            <button
              className="btn btn--ghost"
              onClick={() => {
                if (globalThis.confirm(`Delete "${t.name}"?`)) remove.mutate();
              }}
              disabled={busy}
            >
              Delete
            </button>
          ) : null}
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <Card title="Details">
        {meta ? (
          <div className="stack gap-3">
            <div className="field">
              <label className="field__label" htmlFor="tpl-name">
                Name
              </label>
              <input
                id="tpl-name"
                className="input"
                value={meta.name}
                onChange={(e) => setMeta({ ...meta, name: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="tpl-cat">
                Category
              </label>
              <input
                id="tpl-cat"
                className="input"
                value={meta.category}
                onChange={(e) => setMeta({ ...meta, category: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="tpl-desc">
                Description
              </label>
              <textarea
                id="tpl-desc"
                className="input"
                rows={2}
                value={meta.description}
                onChange={(e) => setMeta({ ...meta, description: e.target.value })}
              />
            </div>
            <div className="row gap-2">
              <button className="btn" onClick={() => saveMeta.mutate()} disabled={busy}>
                {saveMeta.isPending ? 'Saving…' : 'Save details'}
              </button>
              <button className="btn btn--ghost" onClick={() => setMeta(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="stack gap-3">
            <p>{t.description ?? <span className="muted">No description.</span>}</p>
            {can(Permission.TEMPLATE_WRITE) ? (
              <button
                className="btn btn--ghost"
                onClick={() =>
                  setMeta({
                    name: t.name,
                    category: t.category ?? '',
                    description: t.description ?? '',
                  })
                }
              >
                Edit details
              </button>
            ) : null}
          </div>
        )}
      </Card>

      <Card
        title={
          latest
            ? `Version ${latest.version}${isDraft ? ' — draft' : ' — published'}`
            : 'No versions yet'
        }
      >
        {!latest ? (
          <Empty title="Nothing to edit" body="This checklist has no version." />
        ) : !isDraft ? (
          <div className="stack gap-3">
            <p className="small muted">
              Published versions cannot be changed. An inspection renders the questions it was
              started with, so editing this one would rewrite what a finished report says. Create a
              draft to make changes — in-flight work keeps this version.
            </p>
            {can(Permission.TEMPLATE_WRITE) ? (
              <button className="btn" onClick={() => newDraft.mutate()} disabled={busy}>
                {newDraft.isPending ? 'Creating…' : 'Create a new draft'}
              </button>
            ) : null}
          </div>
        ) : needsFetch && latestVersion.isLoading ? (
          <Loading />
        ) : (
          <div className="stack gap-4">
            {editing.map((section, si) => (
              <div key={si} className="card" style={{ padding: 'var(--s-3)' }}>
                <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <input
                    className="input"
                    aria-label={`Section ${si + 1} title`}
                    value={section.title}
                    placeholder="Section title"
                    onChange={(e) => {
                      const next = [...editing];
                      next[si] = { ...section, title: e.target.value };
                      mutate(next);
                    }}
                  />
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => mutate(editing.filter((_, i) => i !== si))}
                  >
                    Remove section
                  </button>
                </div>

                <div className="stack gap-3" style={{ marginTop: 'var(--s-3)' }}>
                  {section.fields.map((field, fi) => (
                    <div key={fi} className="row gap-2" style={{ alignItems: 'flex-start' }}>
                      <input
                        className="input grow"
                        aria-label={`Question ${fi + 1}`}
                        placeholder="Question the inspector answers"
                        value={field.label}
                        onChange={(e) => {
                          const next = [...editing];
                          const fields = [...section.fields];
                          fields[fi] = { ...field, label: e.target.value };
                          next[si] = { ...section, fields };
                          mutate(next);
                        }}
                      />
                      <select
                        className="select"
                        aria-label={`Question ${fi + 1} type`}
                        style={{ width: '160px' }}
                        value={field.type}
                        onChange={(e) => {
                          const type = e.target.value;
                          const next = [...editing];
                          const fields = [...section.fields];
                          fields[fi] = {
                            ...field,
                            type,
                            // A choice question with no options cannot be
                            // answered, and the server refuses to publish it.
                            options: NEEDS_OPTIONS.has(type) ? passFailOptions() : [],
                          };
                          next[si] = { ...section, fields };
                          mutate(next);
                        }}
                      >
                        {FIELD_TYPES.map((ft) => (
                          <option key={ft} value={ft}>
                            {ft.replace(/_/g, ' ').toLowerCase()}
                          </option>
                        ))}
                      </select>
                      <label className="row gap-1" style={{ whiteSpace: 'nowrap' }}>
                        <input
                          type="checkbox"
                          checked={field.validation?.required !== false}
                          aria-label={`Question ${fi + 1} required`}
                          onChange={(e) => {
                            const next = [...editing];
                            const fields = [...section.fields];
                            fields[fi] = { ...field, validation: { required: e.target.checked } };
                            next[si] = { ...section, fields };
                            mutate(next);
                          }}
                        />
                        <span className="small">Required</span>
                      </label>
                      <button
                        className="btn btn--ghost btn--sm"
                        aria-label={`Remove question ${fi + 1}`}
                        onClick={() => {
                          const next = [...editing];
                          next[si] = {
                            ...section,
                            fields: section.fields.filter((_, i) => i !== fi),
                          };
                          mutate(next);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      const next = [...editing];
                      next[si] = {
                        ...section,
                        fields: [...section.fields, blankField(section.fields.length)],
                      };
                      mutate(next);
                    }}
                  >
                    Add question
                  </button>
                </div>
              </div>
            ))}

            <button
              className="btn btn--ghost"
              onClick={() =>
                mutate([...editing, { title: 'New section', order: editing.length, fields: [] }])
              }
            >
              Add section
            </button>

            <div className="row gap-2">
              <button className="btn" onClick={() => saveDraft.mutate()} disabled={busy}>
                {saveDraft.isPending ? 'Saving…' : 'Save draft'}
              </button>
              {can(Permission.TEMPLATE_PUBLISH) ? (
                <button
                  className="btn"
                  onClick={() => publish.mutate()}
                  disabled={busy || fieldCount === 0}
                  title={
                    fieldCount === 0
                      ? 'A checklist with no questions would reach an inspector as a blank form.'
                      : undefined
                  }
                >
                  {publish.isPending ? 'Publishing…' : 'Publish'}
                </button>
              ) : null}
              <span className="small muted">
                {fieldCount} question{fieldCount === 1 ? '' : 's'}
                {fieldCount === 0 ? ' — add one before publishing' : ''}
              </span>
            </div>
          </div>
        )}
      </Card>

      <Card title={`Version history (${t.versions?.length ?? 0})`}>
        {t.versions && t.versions.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Version</th>
                <th>State</th>
                <th>Published</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {t.versions.map((v) => (
                <tr key={v.id}>
                  <td className="num">v{v.version}</td>
                  <td>
                    <Badge
                      label={
                        v.id === t.activeVersionId ? 'active' : v.publishedAt ? 'retired' : 'draft'
                      }
                      tone={v.id === t.activeVersionId ? 'ok' : v.publishedAt ? 'neutral' : 'warn'}
                    />
                  </td>
                  <td>
                    {v.publishedAt ? formatDate(v.publishedAt) : <span className="muted">—</span>}
                  </td>
                  <td className="muted">{v.changeNote ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No versions" body="" />
        )}
      </Card>
    </>
  );
}
