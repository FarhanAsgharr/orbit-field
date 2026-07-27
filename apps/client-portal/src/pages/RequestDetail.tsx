/**
 * One request, end to end.
 *
 * The three things a customer wants from this page, in order: where has it got
 * to, what did I send, and what has been said about it. The timeline is first
 * because "where has it got to" is why they opened the page at all.
 *
 * The conversation is here rather than only on the Messages page because a
 * message about a request belongs with the request. Messages is a cross-request
 * inbox for people who want one view of everything; this is the thread in
 * context.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Attachments } from '../components/Attachments';
import { Shell } from '../components/Shell';
import {
  Card,
  formatDate,
  initials,
  Loading,
  Notice,
  PriorityBadge,
  relativeTime,
  StatusBadge,
} from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';

interface Comment {
  id: string;
  body: string;
  internal: boolean;
  createdAt: string;
  author: { id: string; firstName: string; lastName: string } | null;
}

interface RequestDetailData {
  id: string;
  number: string;
  title: string;
  description: string | null;
  inspectionType: string | null;
  specialInstructions: string | null;
  projectName: string | null;
  siteName: string | null;
  siteAddress: string | null;
  priority: string;
  status: string;
  displayStatus: string;
  preferredDate: string | null;
  decisionNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  site: { id: string; name: string } | null;
  inspection: { id: string; number: string; status: string } | null;
  comments: Comment[];
}

/** The stages a customer is shown, and which of them this request has passed. */
function timeline(
  request: RequestDetailData,
): Array<{ label: string; hint: string; done: boolean }> {
  const inspection = request.inspection;
  const status = inspection?.status;
  const decided =
    request.status !== 'PENDING_APPROVAL' && request.status !== 'INFORMATION_REQUESTED';

  return [
    { label: 'Request submitted', hint: formatDate(request.createdAt, true), done: true },
    {
      label: 'Reviewed by the team',
      hint: decided
        ? `${request.status === 'APPROVED' ? 'Approved' : request.status === 'REJECTED' ? 'Declined' : 'Closed'} ${formatDate(request.reviewedAt)}`
        : 'Waiting for a decision',
      done: decided,
    },
    {
      label: 'Inspector assigned',
      hint: inspection ? `Inspection ${inspection.number}` : 'Not yet scheduled',
      done: Boolean(inspection) && status !== 'DRAFT',
    },
    {
      label: 'Inspection carried out',
      hint: status === 'IN_PROGRESS' ? 'On site now' : 'Not started',
      done: ['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'COMPLETED', 'REWORK_REQUIRED'].includes(
        status ?? '',
      ),
    },
    {
      label: 'Reviewed and signed off',
      hint:
        status === 'IN_REVIEW' || status === 'SUBMITTED'
          ? 'With a supervisor'
          : status === 'REWORK_REQUIRED'
            ? 'Sent back for rework'
            : 'Not yet',
      done: ['APPROVED', 'COMPLETED'].includes(status ?? ''),
    },
    {
      label: 'Report available',
      hint: ['APPROVED', 'COMPLETED'].includes(status ?? '') ? 'Ready to download' : 'Not yet',
      done: ['APPROVED', 'COMPLETED'].includes(status ?? ''),
    },
  ];
}

export function RequestDetail(): React.ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const threadEnd = useRef<HTMLDivElement>(null);

  const request = useQuery({
    queryKey: ['request', id],
    queryFn: () => api.get<RequestDetailData>(`/inspection-requests/${id}`),
    enabled: Boolean(id),
  });

  // A new message should be visible without scrolling for it.
  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [request.data?.comments.length]);

  const send = useMutation({
    mutationFn: (body: string) => api.post(`/inspection-requests/${id}/comments`, { body }),
    onSuccess: () => {
      setMessage('');
      void queryClient.invalidateQueries({ queryKey: ['request', id] });
      void queryClient.invalidateQueries({ queryKey: ['messages'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Your message could not be sent.'),
  });

  const cancel = useMutation({
    mutationFn: () => api.post(`/inspection-requests/${id}/cancel`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['request', id] });
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
      void queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'That could not be cancelled.'),
  });

  if (request.isLoading) {
    return (
      <Shell title="Request">
        <Loading />
      </Shell>
    );
  }

  if (request.isError || !request.data) {
    return (
      <Shell title="Request">
        <Notice>That request could not be found. It may belong to another account.</Notice>
        <div className="form-actions">
          <Link className="btn" to="/client/requests">
            Back to my requests
          </Link>
        </div>
      </Shell>
    );
  }

  const data = request.data;
  const open = data.status === 'PENDING_APPROVAL' || data.status === 'INFORMATION_REQUESTED';

  return (
    <Shell
      title={data.title}
      subtitle={`${data.number} · raised ${formatDate(data.createdAt)}`}
      actions={
        <>
          <StatusBadge status={data.displayStatus} />
          <PriorityBadge priority={data.priority} />
          {open && (
            <button
              type="button"
              className="btn btn--danger btn--sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Withdraw
            </button>
          )}
        </>
      }
    >
      {error && <Notice>{error}</Notice>}

      {data.status === 'INFORMATION_REQUESTED' && (
        <Notice kind="info">
          The team has asked for more information. Reply below and your request goes straight back
          into the queue.
        </Notice>
      )}
      {data.decisionNote && (
        <Notice kind={data.status === 'REJECTED' ? 'error' : 'info'}>{data.decisionNote}</Notice>
      )}

      <Card title="Progress">
        <ul className="timeline">
          {timeline(data).map((step) => (
            <li key={step.label}>
              <span className={step.done ? 'timeline__dot timeline__dot--done' : 'timeline__dot'} />
              <div>
                <div className="timeline__label">{step.label}</div>
                <div className="faint">{step.hint}</div>
              </div>
            </li>
          ))}
        </ul>
        {data.inspection && ['APPROVED', 'COMPLETED'].includes(data.inspection.status) && (
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => navigate('/client/reports')}
            >
              Download the report
            </button>
          </div>
        )}
      </Card>

      <Card title="Details">
        <dl className="details">
          <div>
            <dt className="details__term">Project</dt>
            <dd className="details__value">{data.projectName ?? '—'}</dd>
          </div>
          <div>
            <dt className="details__term">Site</dt>
            <dd className="details__value">{data.site?.name ?? data.siteName ?? '—'}</dd>
          </div>
          <div>
            <dt className="details__term">Address</dt>
            <dd className="details__value">{data.siteAddress ?? '—'}</dd>
          </div>
          <div>
            <dt className="details__term">Type</dt>
            <dd className="details__value">{data.inspectionType ?? '—'}</dd>
          </div>
          <div>
            <dt className="details__term">Preferred date</dt>
            <dd className="details__value">{formatDate(data.preferredDate)}</dd>
          </div>
          <div>
            <dt className="details__term">Inspection</dt>
            <dd className="details__value">{data.inspection?.number ?? 'Not created yet'}</dd>
          </div>
        </dl>
        {data.description && (
          <div style={{ marginTop: 20 }}>
            <dt className="details__term">Problem description</dt>
            <p className="details__value" style={{ whiteSpace: 'pre-wrap' }}>
              {data.description}
            </p>
          </div>
        )}
        {data.specialInstructions && (
          <div style={{ marginTop: 16 }}>
            <dt className="details__term">Access instructions</dt>
            <p className="details__value" style={{ whiteSpace: 'pre-wrap' }}>
              {data.specialInstructions}
            </p>
          </div>
        )}
      </Card>

      <Card title="Files">
        <Attachments requestId={data.id} readOnly={!open} />
      </Card>

      <Card title="Messages" flush>
        {data.comments.length === 0 ? (
          <div className="thread">
            <p className="muted">
              No messages yet. Anything you write here goes to the team handling this request.
            </p>
          </div>
        ) : (
          <div className="thread">
            {data.comments.map((comment) => {
              const mine = comment.author?.id === user?.id;
              const name = comment.author
                ? `${comment.author.firstName} ${comment.author.lastName}`.trim()
                : 'Removed user';
              return (
                <div className={mine ? 'message message--mine' : 'message'} key={comment.id}>
                  <span className="message__avatar" aria-hidden="true">
                    {initials(comment.author?.firstName, comment.author?.lastName)}
                  </span>
                  <div className="message__bubble">
                    <div className="message__meta">
                      {mine ? 'You' : name} · {relativeTime(comment.createdAt)}
                    </div>
                    <div className="message__text">{comment.body}</div>
                  </div>
                </div>
              );
            })}
            <div ref={threadEnd} />
          </div>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = message.trim();
            if (text) send.mutate(text);
          }}
        >
          <textarea
            className="textarea"
            value={message}
            placeholder="Write a message to the team…"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line — the convention every
              // messaging app has taught people.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const text = message.trim();
                if (text) send.mutate(text);
              }
            }}
          />
          <button
            className="btn btn--primary"
            type="submit"
            disabled={send.isPending || !message.trim()}
          >
            Send
          </button>
        </form>
      </Card>
    </Shell>
  );
}
