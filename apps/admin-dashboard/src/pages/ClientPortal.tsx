/**
 * The customer's view of Orbit Field.
 *
 * Served from the same application as the staff console rather than a second
 * deployment, and gated on the signed-in role. The security boundary is the
 * API — every client-facing query narrows on `clientId` server-side — so a
 * separate bundle would buy nothing except a third thing to deploy and keep in
 * step. What the role decides here is which navigation and which screens a
 * customer is offered; what they are actually allowed to read is decided in
 * Postgres.
 *
 * Everything a customer sees is their own company's. There is no filter to
 * widen, and no screen that shows another client's work, because the endpoints
 * behind them cannot return it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  Badge,
  Card,
  Empty,
  ErrorBanner,
  formatDate,
  Loading,
  Metric,
  Pagination,
  priorityBadge,
  relativeTime,
  statusBadge,
  type Tone,
} from '../components/ui';
import { api } from '../lib/api';

// ---------------------------------------------------------------------------
// Shared types and helpers
// ---------------------------------------------------------------------------

interface RequestRow {
  id: string;
  number: string;
  title: string;
  description: string | null;
  inspectionType: string | null;
  specialInstructions: string | null;
  status: string;
  displayStatus: string;
  priority: string;
  preferredDate: string | null;
  preferredTime: string | null;
  decisionNote: string | null;
  createdAt: string;
  site: { id: string; name: string } | null;
  asset: { id: string; name: string; tag: string } | null;
  inspection: { id: string; number: string; status: string } | null;
  reviewedBy: { firstName: string; lastName: string } | null;
  _count?: { attachments: number; comments: number };
}

/**
 * One label for a request, whatever stage it is at.
 *
 * The server already collapses an approved request into its inspection's
 * status, so "Approved" is never shown against work that is finished. This
 * only chooses how to colour it.
 */
function requestBadge(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'PENDING_APPROVAL':
      return { label: 'Pending approval', tone: 'warn' };
    case 'INFORMATION_REQUESTED':
      return { label: 'More information needed', tone: 'warn' };
    case 'REJECTED':
      return { label: 'Declined', tone: 'danger' };
    case 'CANCELLED':
      return { label: 'Withdrawn', tone: 'neutral' };
    case 'APPROVED':
      return { label: 'Approved', tone: 'ok' };
    default: {
      // Anything else is an inspection status the server passed through.
      const badge = statusBadge(status);
      return { label: badge.label, tone: badge.tone };
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

interface Summary {
  requests: {
    pending: number;
    informationRequested: number;
    approved: number;
    rejected: number;
    cancelled: number;
  };
  inspections: Record<string, number>;
}

export function ClientDashboard(): React.ReactElement {
  const summary = useQuery({
    queryKey: ['client-summary'],
    queryFn: () => api.get<Summary>('/inspection-requests/meta/summary'),
  });

  const recent = useQuery({
    queryKey: ['client-recent-requests'],
    queryFn: () => api.get<{ items: RequestRow[] }>('/inspection-requests', { pageSize: 5 }),
  });

  const reports = useQuery({
    queryKey: ['client-recent-inspections'],
    queryFn: () =>
      api.get<{
        items: Array<{
          id: string;
          number: string;
          title: string;
          status: string;
          updatedAt: string;
        }>;
      }>('/inspections', { pageSize: 5, status: 'APPROVED' }),
  });

  if (summary.isLoading) return <Loading />;

  const s = summary.data;
  const inspections = s?.inspections ?? {};
  const scheduled = (inspections.SCHEDULED ?? 0) + (inspections.DRAFT ?? 0);
  const inProgress = inspections.IN_PROGRESS ?? 0;
  const completed = inspections.APPROVED ?? 0;

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Your inspections</h1>
          <p className="page__subtitle">Requests you have raised, and the work they became.</p>
        </div>
        <Link className="btn" to="/portal/requests/new">
          Request an inspection
        </Link>
      </header>

      <div className="grid grid--4">
        <Metric
          value={String(s?.requests.pending ?? 0)}
          label="Awaiting approval"
          tone={(s?.requests.pending ?? 0) > 0 ? 'warn' : 'ok'}
        />
        <Metric value={String(s?.requests.approved ?? 0)} label="Approved" tone="ok" />
        <Metric
          value={String(s?.requests.rejected ?? 0)}
          label="Declined"
          tone={(s?.requests.rejected ?? 0) > 0 ? 'danger' : 'ok'}
        />
        <Metric
          value={String(s?.requests.informationRequested ?? 0)}
          label="Needs your reply"
          tone={(s?.requests.informationRequested ?? 0) > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="grid grid--3 mt-6">
        <Metric value={String(scheduled)} label="Scheduled visits" />
        <Metric value={String(inProgress)} label="In progress" />
        <Metric value={String(completed)} label="Completed" tone="ok" />
      </div>

      <div className="grid grid--2 mt-6">
        <Card title="Your latest requests">
          {recent.data?.items.length ? (
            <ul className="stack gap-3">
              {recent.data.items.map((r) => {
                const badge = requestBadge(r.displayStatus);
                return (
                  <li key={r.id} className="row gap-2" style={{ justifyContent: 'space-between' }}>
                    <Link to={`/portal/requests/${r.id}`}>
                      <span className="num">{r.number}</span> · {r.title}
                    </Link>
                    <Badge label={badge.label} tone={badge.tone} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty
              title="Nothing yet"
              body="Raise a request and it appears here while it is reviewed."
            />
          )}
        </Card>

        <Card title="Reports ready to download">
          {reports.data?.items.length ? (
            <ul className="stack gap-3">
              {reports.data.items.map((i) => (
                <li key={i.id} className="row gap-2" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <span className="num">{i.number}</span> · {i.title}
                  </span>
                  <span className="muted small">{relativeTime(i.updatedAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              title="No completed inspections yet"
              body="A report appears here once an inspection has been reviewed and approved."
            />
          )}
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function ClientRequests(): React.ReactElement {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const query = useQuery({
    queryKey: ['client-requests', page, status],
    queryFn: () =>
      api.get<{ items: RequestRow[]; total: number; page: number; pageSize: number }>(
        '/inspection-requests',
        { page, pageSize: 25, ...(status ? { status } : {}) },
      ),
  });

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Inspection requests</h1>
          <p className="page__subtitle">Everything you have asked for, and where it stands.</p>
        </div>
        <Link className="btn" to="/portal/requests/new">
          Request an inspection
        </Link>
      </header>

      <div className="toolbar">
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Filter by status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Any status</option>
          <option value="PENDING_APPROVAL">Pending approval</option>
          <option value="INFORMATION_REQUESTED">More information needed</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Declined</option>
          <option value="CANCELLED">Withdrawn</option>
        </select>
      </div>

      <Card flush>
        {query.isLoading ? (
          <Loading rows={5} />
        ) : !query.data?.items.length ? (
          <Empty
            title="No requests"
            body="Use “Request an inspection” to ask for work at one of your sites."
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Request</th>
                  <th>Site</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((r) => {
                  const badge = requestBadge(r.displayStatus);
                  const priority = priorityBadge(r.priority);
                  return (
                    <tr key={r.id}>
                      <td>
                        <Link className="num" to={`/portal/requests/${r.id}`}>
                          {r.number}
                        </Link>
                      </td>
                      <td>
                        <div className="table__primary">{r.title}</div>
                        <div className="table__meta">{r.inspectionType ?? '—'}</div>
                      </td>
                      <td>{r.site?.name ?? <span className="muted">—</span>}</td>
                      <td>
                        <Badge label={priority.label} tone={priority.tone} />
                      </td>
                      <td>
                        <Badge label={badge.label} tone={badge.tone} />
                      </td>
                      <td>{relativeTime(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Pagination
        page={query.data?.page ?? 1}
        pageSize={query.data?.pageSize ?? 25}
        total={query.data?.total ?? 0}
        onPage={setPage}
      />
    </>
  );
}

/** The request form. Sites and assets are the customer's own — the API returns no others. */
export function ClientNewRequest(): React.ReactElement {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<RequestRow | null>(null);
  const [form, setForm] = useState({
    title: '',
    description: '',
    inspectionType: '',
    priority: 'NORMAL',
    siteId: '',
    assetId: '',
    preferredDate: '',
    preferredTime: '',
    specialInstructions: '',
  });

  const sites = useQuery({
    queryKey: ['client-sites'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string }> }>('/sites', { pageSize: 200 }),
  });
  const assets = useQuery({
    queryKey: ['client-assets'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string; tag: string }> }>('/assets', {
        pageSize: 200,
      }),
  });

  const submit = useMutation({
    mutationFn: () =>
      api.post<RequestRow>('/inspection-requests', {
        title: form.title.trim(),
        description: form.description.trim() || null,
        inspectionType: form.inspectionType.trim() || null,
        specialInstructions: form.specialInstructions.trim() || null,
        siteId: form.siteId || null,
        assetId: form.assetId || null,
        priority: form.priority,
        preferredDate: form.preferredDate ? new Date(form.preferredDate).toISOString() : null,
        preferredTime: form.preferredTime || null,
      }),
    onSuccess: (row) => {
      void queryClient.invalidateQueries({ queryKey: ['client-requests'] });
      void queryClient.invalidateQueries({ queryKey: ['client-summary'] });
      setCreated(row);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not send the request.'),
  });

  if (created) {
    return (
      <>
        <header className="page__head">
          <div>
            <h1 className="page__title">Request sent</h1>
            <p className="page__subtitle">
              <span className="num">{created.number}</span> is with the team.
            </p>
          </div>
        </header>
        <Card title="What happens next">
          <div className="stack gap-3">
            <p>
              Somebody will review it and either approve it, decline it, or come back to you with a
              question. You will be told either way, and you can follow it on your requests page.
            </p>
            <div className="row gap-2">
              <Link className="btn" to={`/portal/requests/${created.id}`}>
                View the request
              </Link>
              <Link className="btn btn--ghost" to="/portal/requests/new">
                Raise another
              </Link>
            </div>
          </div>
        </Card>
      </>
    );
  }

  const ready = form.title.trim() !== '';

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Request an inspection</h1>
          <p className="page__subtitle">
            Tell us what you need and when. Nothing is scheduled until it has been approved.
          </p>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <Card>
        <div className="stack gap-4">
          <div className="field">
            <label className="field__label" htmlFor="rq-title">
              What needs inspecting
            </label>
            <input
              id="rq-title"
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="rq-desc">
              Description <span className="muted">(optional)</span>
            </label>
            <textarea
              id="rq-desc"
              className="input"
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          <div className="row gap-3">
            <div className="field grow">
              <label className="field__label" htmlFor="rq-type">
                Type of inspection <span className="muted">(optional)</span>
              </label>
              <input
                id="rq-type"
                className="input"
                placeholder="Safety, condition, compliance…"
                value={form.inspectionType}
                onChange={(e) => setForm({ ...form, inspectionType: e.target.value })}
              />
            </div>
            <div className="field grow">
              <label className="field__label" htmlFor="rq-priority">
                How urgent
              </label>
              <select
                id="rq-priority"
                className="select"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
          </div>

          <div className="row gap-3">
            <div className="field grow">
              <label className="field__label" htmlFor="rq-site">
                Site <span className="muted">(optional)</span>
              </label>
              <select
                id="rq-site"
                className="select"
                value={form.siteId}
                onChange={(e) => setForm({ ...form, siteId: e.target.value })}
              >
                <option value="">Not specified</option>
                {(sites.data?.items ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field grow">
              <label className="field__label" htmlFor="rq-asset">
                Equipment <span className="muted">(optional)</span>
              </label>
              <select
                id="rq-asset"
                className="select"
                value={form.assetId}
                onChange={(e) => setForm({ ...form, assetId: e.target.value })}
              >
                <option value="">Not specified</option>
                {(assets.data?.items ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.tag})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="row gap-3">
            <div className="field grow">
              <label className="field__label" htmlFor="rq-date">
                Preferred date <span className="muted">(optional)</span>
              </label>
              <input
                id="rq-date"
                className="input"
                type="date"
                value={form.preferredDate}
                onChange={(e) => setForm({ ...form, preferredDate: e.target.value })}
              />
            </div>
            <div className="field grow">
              <label className="field__label" htmlFor="rq-time">
                Preferred time <span className="muted">(optional)</span>
              </label>
              <select
                id="rq-time"
                className="select"
                value={form.preferredTime}
                onChange={(e) => setForm({ ...form, preferredTime: e.target.value })}
              >
                <option value="">No preference</option>
                <option value="morning">Morning</option>
                <option value="afternoon">Afternoon</option>
                <option value="evening">Evening</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="rq-notes">
              Anything the inspector should know <span className="muted">(optional)</span>
            </label>
            <textarea
              id="rq-notes"
              className="input"
              rows={2}
              placeholder="Access, keys, contacts, hazards…"
              value={form.specialInstructions}
              onChange={(e) => setForm({ ...form, specialInstructions: e.target.value })}
            />
          </div>

          <button
            className="btn"
            onClick={() => submit.mutate()}
            disabled={submit.isPending || !ready}
          >
            {submit.isPending ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </Card>
    </>
  );
}

/** One request, its decision, and the conversation about it. */
export function ClientRequestDetail(): React.ReactElement {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['client-request', id],
    queryFn: () =>
      api.get<
        RequestRow & {
          comments: Array<{
            id: string;
            body: string;
            createdAt: string;
            author: { firstName: string; lastName: string } | null;
          }>;
        }
      >(`/inspection-requests/${id}`),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['client-request', id] });
    void queryClient.invalidateQueries({ queryKey: ['client-requests'] });
  };

  const comment = useMutation({
    mutationFn: () => api.post(`/inspection-requests/${id}/comments`, { body: reply.trim() }),
    onSuccess: () => {
      setReply('');
      refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not send that.'),
  });

  const withdraw = useMutation({
    mutationFn: () => api.post(`/inspection-requests/${id}/cancel`, {}),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not withdraw it.'),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) {
    return <Empty title="Request not found" body="It may have been withdrawn." />;
  }

  const r = query.data;
  const badge = requestBadge(r.displayStatus);
  const canWithdraw = ['PENDING_APPROVAL', 'INFORMATION_REQUESTED'].includes(r.status);

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">
            <span className="num">{r.number}</span> · {r.title}
          </h1>
          <p className="page__subtitle">
            <Link to="/portal/requests">Requests</Link> · raised {relativeTime(r.createdAt)}
          </p>
        </div>
        <div className="row gap-2">
          <Badge label={badge.label} tone={badge.tone} />
          {canWithdraw ? (
            <button
              className="btn btn--ghost"
              onClick={() => {
                if (globalThis.confirm('Withdraw this request?')) withdraw.mutate();
              }}
              disabled={withdraw.isPending}
            >
              Withdraw
            </button>
          ) : null}
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {r.decisionNote ? (
        <Card title={r.status === 'REJECTED' ? 'Why this was declined' : 'From the team'}>
          <p>{r.decisionNote}</p>
        </Card>
      ) : null}

      <div className="grid grid--2">
        <Card title="What you asked for">
          <div className="stack gap-3">
            {r.description ? <p>{r.description}</p> : null}
            <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Type</span>
              <span>{r.inspectionType ?? '—'}</span>
            </div>
            <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Site</span>
              <span>{r.site?.name ?? '—'}</span>
            </div>
            <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Equipment</span>
              <span>{r.asset ? `${r.asset.name} (${r.asset.tag})` : '—'}</span>
            </div>
            <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
              <span className="muted">Preferred</span>
              <span>
                {r.preferredDate ? formatDate(r.preferredDate) : 'No date'}
                {r.preferredTime ? ` · ${r.preferredTime}` : ''}
              </span>
            </div>
            {r.specialInstructions ? <p className="small muted">{r.specialInstructions}</p> : null}
          </div>
        </Card>

        <Card title="The visit">
          {r.inspection ? (
            <div className="stack gap-3">
              <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Reference</span>
                <span className="num">{r.inspection.number}</span>
              </div>
              <div className="row gap-3" style={{ justifyContent: 'space-between' }}>
                <span className="muted">Status</span>
                <Badge {...statusBadge(r.inspection.status)} />
              </div>
              {r.inspection.status === 'APPROVED' ? (
                <ReportLinks inspectionId={r.inspection.id} />
              ) : (
                <p className="small muted">
                  The report becomes available once the inspection has been reviewed.
                </p>
              )}
            </div>
          ) : (
            <Empty
              title="Not scheduled yet"
              body="Once approved, the inspection appears here and you can follow its progress."
            />
          )}
        </Card>
      </div>

      <Card title={`Conversation (${r.comments?.length ?? 0})`}>
        <div className="stack gap-4">
          {r.comments?.length ? (
            <ul className="stack gap-3">
              {r.comments.map((c) => (
                <li key={c.id} className="stack gap-1">
                  <div className="row gap-2">
                    <strong>
                      {c.author ? `${c.author.firstName} ${c.author.lastName}` : 'The team'}
                    </strong>
                    <span className="muted small">{relativeTime(c.createdAt)}</span>
                  </div>
                  <p>{c.body}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="Nothing said yet" body="Replies from the team appear here." />
          )}

          <div className="field">
            <label className="field__label" htmlFor="rq-reply">
              Reply
            </label>
            <textarea
              id="rq-reply"
              className="input"
              rows={2}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
          </div>
          <button
            className="btn btn--ghost"
            onClick={() => comment.mutate()}
            disabled={comment.isPending || reply.trim() === ''}
          >
            {comment.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </Card>
    </>
  );
}

/** Download buttons for a finished inspection. */
function ReportLinks({ inspectionId }: { inspectionId: string }): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const download = async (format: 'pdf' | 'xlsx'): Promise<void> => {
    setBusy(format);
    setError(null);
    try {
      const blob = await api.blob(`/reports/inspection/${inspectionId}?format=${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inspection-${inspectionId}.${format}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not produce the report.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack gap-2">
      {error ? <ErrorBanner message={error} /> : null}
      <div className="row gap-2">
        <button className="btn" onClick={() => void download('pdf')} disabled={busy !== null}>
          {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => void download('xlsx')}
          disabled={busy !== null}
        >
          {busy === 'xlsx' ? 'Preparing…' : 'Excel'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspections and reports
// ---------------------------------------------------------------------------

interface ClientInspection {
  id: string;
  number: string;
  title: string;
  status: string;
  outcome: string;
  dueAt: string | null;
  updatedAt: string;
  site: { name: string } | null;
  assignedTo: { firstName: string; lastName: string } | null;
}

function InspectionTable({
  onlyCompleted,
  emptyTitle,
  emptyBody,
}: {
  onlyCompleted?: boolean;
  emptyTitle: string;
  emptyBody: string;
}): React.ReactElement {
  const [page, setPage] = useState(1);

  const query = useQuery({
    queryKey: ['client-inspections', page, onlyCompleted],
    queryFn: () =>
      api.get<{ items: ClientInspection[]; total: number; page: number; pageSize: number }>(
        '/inspections',
        { page, pageSize: 25, ...(onlyCompleted ? { status: 'APPROVED' } : {}) },
      ),
  });

  return (
    <>
      <Card flush>
        {query.isLoading ? (
          <Loading rows={5} />
        ) : !query.data?.items.length ? (
          <Empty title={emptyTitle} body={emptyBody} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Inspection</th>
                  <th>Site</th>
                  <th>Status</th>
                  <th>Updated</th>
                  {onlyCompleted ? <th>Report</th> : null}
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((i) => (
                  <tr key={i.id}>
                    <td className="num">{i.number}</td>
                    <td>{i.title}</td>
                    <td>{i.site?.name ?? <span className="muted">—</span>}</td>
                    <td>
                      <Badge {...statusBadge(i.status)} />
                    </td>
                    <td>{relativeTime(i.updatedAt)}</td>
                    {onlyCompleted ? (
                      <td>
                        <ReportLinks inspectionId={i.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Pagination
        page={query.data?.page ?? 1}
        pageSize={query.data?.pageSize ?? 25}
        total={query.data?.total ?? 0}
        onPage={setPage}
      />
    </>
  );
}

export function ClientInspections(): React.ReactElement {
  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Your inspections</h1>
          <p className="page__subtitle">Work scheduled at your sites, and how it is going.</p>
        </div>
      </header>
      <InspectionTable
        emptyTitle="No inspections yet"
        emptyBody="Approved requests appear here as scheduled visits."
      />
    </>
  );
}

export function ClientReports(): React.ReactElement {
  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Reports</h1>
          <p className="page__subtitle">
            Completed inspections. Each one includes the answers, the photographs and the signatures
            captured on site.
          </p>
        </div>
      </header>
      <InspectionTable
        onlyCompleted
        emptyTitle="No reports yet"
        emptyBody="A report appears here once an inspection has been reviewed and approved."
      />
    </>
  );
}

/**
 * Invoices.
 *
 * Deliberately empty and deliberately honest about it. There is no billing in
 * Orbit Field — no invoice model, no ledger, no payment provider — and a screen
 * with convincing fake rows on it would be worse than nothing, because somebody
 * would eventually try to reconcile against them.
 */
export function ClientInvoices(): React.ReactElement {
  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Invoices</h1>
          <p className="page__subtitle">Billing for the work carried out at your sites.</p>
        </div>
      </header>
      <Empty
        title="Not available yet"
        body="Invoicing is not part of Orbit Field today. Your account manager can provide statements in the meantime."
      />
    </>
  );
}
