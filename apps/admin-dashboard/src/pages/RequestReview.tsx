/**
 * The review queue.
 *
 * Where customer requests arrive and are decided. Approving one creates the
 * inspection in the same transaction on the server, so this screen is the only
 * place the decision is made — there is no second step where somebody has to
 * remember to schedule the work that was just promised.
 *
 * The three decisions are deliberately not equal. Approve needs a checklist,
 * because an inspection without one cannot be carried out. Decline and "ask a
 * question" both need a reason, because a customer who is told no with no
 * explanation will simply ask again.
 */

import { Permission } from '@orbit/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';

import { AttachmentUpload } from '../components/AttachmentUpload';
import { type Column, DataTable } from '../components/DataTable';
import {
  Badge,
  Card,
  Empty,
  ErrorBanner,
  formatDate,
  Loading,
  priorityBadge,
  relativeTime,
} from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';

interface RequestRow {
  id: string;
  number: string;
  title: string;
  status: string;
  displayStatus: string;
  priority: string;
  createdAt: string;
  preferredDate: string | null;
  client: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  requestedBy: { firstName: string; lastName: string } | null;
  inspection: { id: string; number: string; status: string } | null;
  _count: { attachments: number; comments: number };
}

const statusTone = (status: string): 'ok' | 'warn' | 'danger' | 'neutral' | 'info' => {
  if (status === 'PENDING_APPROVAL') return 'warn';
  if (status === 'INFORMATION_REQUESTED') return 'warn';
  if (status === 'REJECTED') return 'danger';
  if (status === 'CANCELLED') return 'neutral';
  return 'ok';
};

export function InspectionRequests(): React.ReactElement {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const [open, setOpen] = useState<string | null>(null);

  const columns: Array<Column<RequestRow>> = [
    {
      key: 'number',
      header: 'Reference',
      width: '150px',
      render: (row) => <span className="num">{row.number}</span>,
    },
    {
      key: 'title',
      header: 'Request',
      render: (row) => (
        <div>
          <div className="table__primary">{row.title}</div>
          <div className="table__meta">
            {row.requestedBy
              ? `${row.requestedBy.firstName} ${row.requestedBy.lastName}`
              : 'Unknown'}
          </div>
        </div>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      render: (row) => row.client?.name ?? <span className="muted">—</span>,
    },
    {
      key: 'site',
      header: 'Site',
      render: (row) => row.site?.name ?? <span className="muted">—</span>,
    },
    {
      key: 'files',
      header: 'Files',
      numeric: true,
      width: '70px',
      render: (row) =>
        row._count.attachments > 0 ? (
          <Badge label={String(row._count.attachments)} tone="info" />
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'priority',
      header: 'Priority',
      width: '110px',
      render: (row) => <Badge {...priorityBadge(row.priority)} />,
    },
    {
      key: 'preferred',
      header: 'Wanted by',
      width: '130px',
      render: (row) =>
        row.preferredDate ? formatDate(row.preferredDate) : <span className="muted">Any time</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge
          label={row.displayStatus.replace(/_/g, ' ').toLowerCase()}
          tone={statusTone(row.status)}
        />
      ),
    },
    {
      key: 'raised',
      header: 'Raised',
      numeric: true,
      width: '120px',
      render: (row) => relativeTime(row.createdAt),
    },
    {
      key: 'actions',
      header: '',
      width: '80px',
      render: (row) => (
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(row.id)}>
          Review
        </button>
      ),
    },
  ];

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Inspection requests</h1>
          <p className="page__subtitle">
            What customers have asked for. Approving one schedules the inspection.
          </p>
        </div>
      </header>

      {open ? (
        <ReviewPanel
          id={open}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            void queryClient.invalidateQueries({ queryKey: ['requests'] });
          }}
          canDecide={can(Permission.INSPECTION_ASSIGN)}
        />
      ) : null}

      <DataTable<RequestRow>
        endpoint="/inspection-requests"
        queryKey={['requests', status]}
        columns={columns}
        rowKey={(row) => row.id}
        searchPlaceholder="Search reference or title"
        extraQuery={{ status: status || undefined }}
        emptyTitle={status ? 'Nothing waiting' : 'No requests yet'}
        emptyBody="Requests raised in the client portal arrive here."
        filters={
          <select
            className="select"
            style={{ width: 'auto' }}
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="PENDING_APPROVAL">Waiting on a decision</option>
            <option value="INFORMATION_REQUESTED">Waiting on the customer</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Declined</option>
            <option value="CANCELLED">Withdrawn</option>
            <option value="">Everything</option>
          </select>
        }
      />
    </>
  );
}

/** The decision itself. */
function ReviewPanel({
  id,
  onClose,
  onDone,
  canDecide,
}: {
  id: string;
  onClose: () => void;
  onDone: () => void;
  canDecide: boolean;
}): React.ReactElement {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION'>('APPROVE');
  const [note, setNote] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [assignedToId, setAssignedToId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const request = useQuery({
    queryKey: ['request', id],
    queryFn: () =>
      api.get<
        RequestRow & {
          description: string | null;
          inspectionType: string | null;
          specialInstructions: string | null;
          preferredTime: string | null;
          comments: Array<{
            id: string;
            body: string;
            internal: boolean;
            createdAt: string;
            author: { firstName: string; lastName: string } | null;
          }>;
        }
      >(`/inspection-requests/${id}`),
  });

  const templates = useQuery({
    queryKey: ['ref', 'templates'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string; activeVersionId: string | null }> }>(
        '/templates',
        { pageSize: 200 },
      ),
  });
  const people = useQuery({
    queryKey: ['ref', 'people'],
    queryFn: () =>
      api.get<{
        items: Array<{
          id: string;
          firstName: string;
          lastName: string;
          role: string;
          status: string;
        }>;
      }>('/users', { pageSize: 200 }),
  });

  const decide = useMutation({
    mutationFn: () =>
      api.post(`/inspection-requests/${id}/decide`, {
        decision,
        note: note.trim() || undefined,
        ...(decision === 'APPROVE'
          ? {
              templateId,
              assignedToId: assignedToId || null,
              supervisorId: supervisorId || null,
              dueAt: dueAt ? new Date(dueAt).toISOString() : null,
            }
          : {}),
      }),
    onSuccess: onDone,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not record the decision.'),
  });

  const r = request.data;
  const decided = r ? !['PENDING_APPROVAL', 'INFORMATION_REQUESTED'].includes(r.status) : false;
  const staff = (people.data?.items ?? []).filter(
    (u) => u.status === 'ACTIVE' && u.role !== 'CLIENT',
  );
  const publishedTemplates = (templates.data?.items ?? []).filter((t) => t.activeVersionId);
  const ready = decision === 'APPROVE' ? templateId !== '' : note.trim() !== '';

  return (
    <div
      className="modal__backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card modal" role="dialog" aria-modal="true" aria-label="Review request">
        <div className="card__head">
          <h2 className="card__title">{r ? `${r.number} · ${r.title}` : 'Request'}</h2>
          <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={decide.isPending}>
            Close
          </button>
        </div>

        <div className="card__body stack gap-4">
          {request.isLoading ? <Loading /> : null}
          {error ? <ErrorBanner message={error} /> : null}

          {r ? (
            <>
              <div className="stack gap-2">
                <div className="row gap-2">
                  <Badge
                    label={r.displayStatus.replace(/_/g, ' ').toLowerCase()}
                    tone={statusTone(r.status)}
                  />
                  <Badge {...priorityBadge(r.priority)} />
                  <span className="muted small">{r.client?.name}</span>
                </div>
                {r.description ? <p>{r.description}</p> : null}
                <p className="small muted">
                  {r.site?.name ?? 'No site'}
                  {r.inspectionType ? ` · ${r.inspectionType}` : ''}
                  {r.preferredDate ? ` · wanted by ${formatDate(r.preferredDate)}` : ''}
                  {r.preferredTime ? ` (${r.preferredTime})` : ''}
                </p>
                {r.specialInstructions ? (
                  <p className="small muted">On site: {r.specialInstructions}</p>
                ) : null}
              </div>

              {/* Read-only once decided: by then the files belong to the
                  inspection and are part of the record. */}
              <Card title={`Files (${r._count?.attachments ?? 0})`}>
                <AttachmentUpload requestId={r.id} readOnly={decided} />
              </Card>

              {r.comments?.length ? (
                <Card title={`Conversation (${r.comments.length})`}>
                  <ul className="stack gap-2">
                    {r.comments.map((c) => (
                      <li key={c.id} className="stack gap-1">
                        <div className="row gap-2">
                          <strong>
                            {c.author ? `${c.author.firstName} ${c.author.lastName}` : 'Unknown'}
                          </strong>
                          {c.internal ? <Badge label="internal" tone="neutral" /> : null}
                          <span className="muted small">{relativeTime(c.createdAt)}</span>
                        </div>
                        <p className="small">{c.body}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              {decided ? (
                <Empty
                  title="Already decided"
                  body={
                    r.inspection
                      ? `Approved — inspection ${r.inspection.number} was created.`
                      : r.status === 'REJECTED'
                        ? 'This request was declined.'
                        : 'This request was withdrawn.'
                  }
                />
              ) : !canDecide ? (
                <Empty title="Read only" body="You do not have permission to decide requests." />
              ) : (
                <div className="stack gap-4">
                  <div className="row gap-2">
                    {(
                      [
                        ['APPROVE', 'Approve'],
                        ['REQUEST_INFORMATION', 'Ask a question'],
                        ['REJECT', 'Decline'],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        className={`btn${decision === value ? '' : ' btn--ghost'}`}
                        onClick={() => setDecision(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {decision === 'APPROVE' ? (
                    <>
                      <div className="field">
                        <label className="field__label" htmlFor="rv-template">
                          Checklist
                        </label>
                        <select
                          id="rv-template"
                          className="select"
                          value={templateId}
                          onChange={(e) => setTemplateId(e.target.value)}
                        >
                          <option value="">Choose a checklist</option>
                          {publishedTemplates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                        <span className="field__hint">
                          Only published checklists — a draft has no questions to answer.
                        </span>
                      </div>

                      <div className="row gap-3">
                        <div className="field grow">
                          <label className="field__label" htmlFor="rv-inspector">
                            Inspector
                          </label>
                          <select
                            id="rv-inspector"
                            className="select"
                            value={assignedToId}
                            onChange={(e) => setAssignedToId(e.target.value)}
                          >
                            <option value="">Assign later</option>
                            {staff.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="field grow">
                          <label className="field__label" htmlFor="rv-supervisor">
                            Supervisor
                          </label>
                          <select
                            id="rv-supervisor"
                            className="select"
                            value={supervisorId}
                            onChange={(e) => setSupervisorId(e.target.value)}
                          >
                            <option value="">None</option>
                            {staff.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.firstName} {u.lastName}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="field">
                        <label className="field__label" htmlFor="rv-due">
                          Due
                        </label>
                        <input
                          id="rv-due"
                          className="input"
                          type="datetime-local"
                          value={dueAt}
                          onChange={(e) => setDueAt(e.target.value)}
                        />
                        <span className="field__hint">
                          Left empty, the customer&apos;s preferred date is used.
                        </span>
                      </div>
                    </>
                  ) : null}

                  <div className="field">
                    <label className="field__label" htmlFor="rv-note">
                      {decision === 'APPROVE'
                        ? 'Note to the customer (optional)'
                        : 'What to tell them'}
                    </label>
                    <textarea
                      id="rv-note"
                      className="input"
                      rows={3}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    {decision !== 'APPROVE' ? (
                      <span className="field__hint">
                        Required. A customer told no with no reason will simply ask again.
                      </span>
                    ) : null}
                  </div>

                  <button
                    className="btn"
                    onClick={() => decide.mutate()}
                    disabled={decide.isPending || !ready}
                  >
                    {decide.isPending
                      ? 'Recording…'
                      : decision === 'APPROVE'
                        ? 'Approve and schedule'
                        : decision === 'REJECT'
                          ? 'Decline'
                          : 'Ask the customer'}
                  </button>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
