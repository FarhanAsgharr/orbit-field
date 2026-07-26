/**
 * One inspection, in full.
 *
 * Every reference number in the list has linked here since the list was
 * written, and until now nothing was registered at `/inspections/:id` — the
 * link fell through to the catch-all route and produced "Not found". The
 * record was reachable by API and by no human.
 *
 * What it shows is ordered by the question an administrator actually has:
 * where is this up to, who has it, what did they answer, and what evidence did
 * they attach. Progress and answers come first; identifiers last.
 */

import { Permission } from '@orbit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { InspectionForm, type InspectionRecord } from '../components/InspectionForm';
import {
  Badge,
  Bar,
  Card,
  Empty,
  ErrorBanner,
  formatDate,
  Loading,
  outcomeBadge,
  priorityBadge,
  relativeTime,
  statusBadge,
} from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

interface Detail extends InspectionRecord {
  outcome: string;
  score: number | null;
  answeredFields: number;
  totalFields: number;
  criticalFailures: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  template: { name: string } | null;
  project: { name: string; code: string } | null;
  site: { name: string } | null;
  client: { name: string } | null;
  assignedTo: { firstName: string; lastName: string } | null;
  createdBy: { firstName: string; lastName: string } | null;
  reviewedBy: { firstName: string; lastName: string } | null;
  responses?: Array<{
    id: string;
    fieldId: string;
    value: unknown;
    isFailure?: boolean;
    notes?: string | null;
  }>;
  attachments?: Array<{ id: string; fileName: string; kind: string; sizeBytes: number }>;
  signatures?: Array<{ id: string; role: string; signerName: string; signedAt: string }>;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function InspectionDetail(): React.ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['inspection', id],
    queryFn: () => api.get<Detail>(`/inspections/${id}`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['inspection', id] });
    void queryClient.invalidateQueries({ queryKey: ['inspections'] });
  };

  const archive = useMutation({
    mutationFn: (archived: boolean) => api.post(`/inspections/${id}/archive`, { archived }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not archive.'),
  });

  const duplicate = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/inspections/${id}/duplicate`, {}),
    onSuccess: (created) => {
      refresh();
      navigate(`/inspections/${created.id}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not duplicate.'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/inspections/${id}`),
    onSuccess: () => {
      refresh();
      navigate('/inspections');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not delete.'),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) {
    return (
      <Empty
        title="Inspection not found"
        body="It may have been deleted, or it belongs to another organisation."
      />
    );
  }

  const it = query.data;
  const status = statusBadge(it.status);
  const outcome = outcomeBadge(it.outcome);
  const priority = priorityBadge(it.priority);
  const share = it.totalFields > 0 ? it.answeredFields / it.totalFields : 0;
  const busy = archive.isPending || duplicate.isPending || remove.isPending;
  // Submitted work is a compliance record; archiving is how it gets out of the
  // way, and the server refuses a delete regardless.
  const deletable = ['DRAFT', 'SCHEDULED', 'IN_PROGRESS'].includes(it.status);

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">
            <span className="num">{it.number}</span> · {it.title}
          </h1>
          <p className="page__subtitle">
            <Link to="/inspections">Inspections</Link> · {it.template?.name ?? 'No checklist'}
          </p>
        </div>
        <div className="row gap-2">
          {can(Permission.INSPECTION_UPDATE_ANY) ? (
            <button className="btn" onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </button>
          ) : null}
          {can(Permission.INSPECTION_CREATE) ? (
            <button className="btn btn--ghost" onClick={() => duplicate.mutate()} disabled={busy}>
              Duplicate
            </button>
          ) : null}
          {can(Permission.INSPECTION_ARCHIVE) ? (
            <button
              className="btn btn--ghost"
              onClick={() => archive.mutate(!it.isArchived)}
              disabled={busy}
            >
              {it.isArchived ? 'Unarchive' : 'Archive'}
            </button>
          ) : null}
          {can(Permission.INSPECTION_DELETE) && deletable ? (
            <button
              className="btn btn--ghost"
              onClick={() => {
                if (globalThis.confirm(`Delete ${it.number}? This removes it from every device.`))
                  remove.mutate();
              }}
              disabled={busy}
            >
              Delete
            </button>
          ) : null}
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {editing ? (
        <div
          className="modal__backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditing(false);
          }}
        >
          <InspectionForm
            existing={it}
            onDone={() => {
              setEditing(false);
              refresh();
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : null}

      <div className="grid grid--3 gap-4">
        <Card title="Where it stands">
          <div className="stack gap-3">
            <Row label="Status">
              <Badge label={status.label} tone={status.tone} glyph={status.glyph} />
            </Row>
            <Row label="Result">
              {it.outcome === 'PENDING' ? (
                <span className="muted">Not yet decided</span>
              ) : (
                <Badge label={outcome.label} tone={outcome.tone} glyph={outcome.glyph} />
              )}
            </Row>
            <Row label="Priority">
              <Badge label={priority.label} tone={priority.tone} />
            </Row>
            <Row label="Score">
              {it.score !== null ? `${Math.round(it.score)}%` : <span className="muted">—</span>}
            </Row>
            {it.criticalFailures > 0 ? (
              <Row label="Critical failures">
                <Badge label={String(it.criticalFailures)} tone="danger" />
              </Row>
            ) : null}
            <div className="stack gap-1">
              <Bar value={share} tone={share === 1 ? 'ok' : 'accent'} />
              <span className="table__meta num">
                {it.answeredFields}/{it.totalFields} answered
              </span>
            </div>
            {it.rejectionReason ? (
              <ErrorBanner message={`Sent back: ${it.rejectionReason}`} />
            ) : null}
          </div>
        </Card>

        <Card title="Who and where">
          <div className="stack gap-3">
            <Row label="Assigned to">
              {it.assignedTo ? (
                `${it.assignedTo.firstName} ${it.assignedTo.lastName}`
              ) : (
                <span className="muted">Unassigned</span>
              )}
            </Row>
            <Row label="Client">{it.client?.name ?? <span className="muted">—</span>}</Row>
            <Row label="Project">{it.project?.name ?? <span className="muted">—</span>}</Row>
            <Row label="Site">{it.site?.name ?? <span className="muted">—</span>}</Row>
            <Row label="Due">
              {it.dueAt ? relativeTime(it.dueAt) : <span className="muted">No date</span>}
            </Row>
          </div>
        </Card>

        <Card title="History">
          <div className="stack gap-3">
            <Row label="Created">{formatDate(it.createdAt)}</Row>
            <Row label="Created by">
              {it.createdBy ? (
                `${it.createdBy.firstName} ${it.createdBy.lastName}`
              ) : (
                <span className="muted">—</span>
              )}
            </Row>
            <Row label="Last updated">{relativeTime(it.updatedAt)}</Row>
            <Row label="Submitted">
              {it.submittedAt ? formatDate(it.submittedAt) : <span className="muted">—</span>}
            </Row>
            <Row label="Reviewed by">
              {it.reviewedBy ? (
                `${it.reviewedBy.firstName} ${it.reviewedBy.lastName}`
              ) : (
                <span className="muted">—</span>
              )}
            </Row>
          </div>
        </Card>
      </div>

      {it.description || it.notes ? (
        <Card title="Brief">
          <div className="stack gap-3">
            {it.description ? <p>{it.description}</p> : null}
            {it.notes ? <p className="small muted">{it.notes}</p> : null}
          </div>
        </Card>
      ) : null}

      <Card title={`Answers (${it.responses?.length ?? 0})`}>
        {it.responses && it.responses.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Question</th>
                <th>Answer</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {it.responses.map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.fieldId}</td>
                  <td>
                    {r.isFailure ? (
                      <Badge label={String(JSON.stringify(r.value))} tone="danger" />
                    ) : (
                      String(JSON.stringify(r.value))
                    )}
                  </td>
                  <td className="muted">{r.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty
            title="No answers yet"
            body="They appear here as soon as the inspector's device syncs."
          />
        )}
      </Card>

      <div className="grid grid--2 gap-4">
        <Card title={`Evidence (${it.attachments?.length ?? 0})`}>
          {it.attachments && it.attachments.length > 0 ? (
            <ul className="stack gap-2">
              {it.attachments.map((a) => (
                <li key={a.id} className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <span>{a.fileName}</span>
                  <Badge label={a.kind.toLowerCase()} tone="info" />
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No photographs" body="Evidence uploaded in the field appears here." />
          )}
        </Card>

        <Card title={`Signatures (${it.signatures?.length ?? 0})`}>
          {it.signatures && it.signatures.length > 0 ? (
            <ul className="stack gap-2">
              {it.signatures.map((s) => (
                <li key={s.id} className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <span>{s.signerName}</span>
                  <span className="muted">
                    {s.role.toLowerCase()} · {formatDate(s.signedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Not signed" body="A signature is captured when the work is submitted." />
          )}
        </Card>
      </div>
    </>
  );
}
