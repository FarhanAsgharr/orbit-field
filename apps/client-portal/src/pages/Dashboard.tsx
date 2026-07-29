/**
 * What is happening with my work.
 *
 * The question a customer opens the portal to answer, so it is answered above
 * the fold: how many requests are waiting on the company, how many are being
 * worked on, and what changed recently. Everything else is a link away.
 */

import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { usePortalPath } from '../App';
import { Shell } from '../components/Shell';
import { Card, Empty, formatDate, Loading, Notice, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import type { RequestSummary } from './Requests';

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

export function Dashboard(): React.ReactElement {
  const path = usePortalPath();
  const { user } = useSession();
  const navigate = useNavigate();

  const summary = useQuery({
    queryKey: ['summary'],
    queryFn: () => api.get<Summary>('/inspection-requests/meta/summary'),
  });

  const recent = useQuery({
    queryKey: ['requests', 'recent'],
    queryFn: () =>
      api.get<{ items: RequestSummary[] }>('/inspection-requests', { page: 1, pageSize: 6 }),
  });

  const counts = summary.data;
  const inspections = counts?.inspections ?? {};
  const inProgress =
    (inspections.IN_PROGRESS ?? 0) + (inspections.ASSIGNED ?? 0) + (inspections.DRAFT ?? 0);
  const inReview = (inspections.SUBMITTED ?? 0) + (inspections.IN_REVIEW ?? 0);
  const completed = (inspections.APPROVED ?? 0) + (inspections.COMPLETED ?? 0);

  return (
    <Shell
      title={`Welcome back, ${user?.firstName ?? ''}`.trim()}
      subtitle="Your inspection requests and their progress."
      actions={
        <Link className="btn btn--primary" to={path('/request/new')}>
          New request
        </Link>
      }
    >
      {summary.isError && <Notice>Your dashboard could not be loaded. Try reloading.</Notice>}

      <div className="stats">
        <div className="stat">
          <span className="stat__label">Awaiting review</span>
          <span className="stat__value">{counts?.requests.pending ?? '—'}</span>
          <span className="stat__hint">Requests the team has not decided on yet</span>
        </div>
        <div className="stat">
          <span className="stat__label">Needs your reply</span>
          <span className="stat__value">{counts?.requests.informationRequested ?? '—'}</span>
          <span className="stat__hint">
            {counts && counts.requests.informationRequested > 0 ? (
              <Link to={path('/messages')}>Answer to get things moving</Link>
            ) : (
              'Nothing waiting on you'
            )}
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">Work in progress</span>
          <span className="stat__value">{summary.data ? inProgress + inReview : '—'}</span>
          <span className="stat__hint">
            {inReview > 0 ? `${inReview} with a supervisor` : 'Scheduled or on site'}
          </span>
        </div>
        <div className="stat">
          <span className="stat__label">Completed</span>
          <span className="stat__value">{summary.data ? completed : '—'}</span>
          <span className="stat__hint">
            {completed > 0 ? (
              <Link to={path('/reports')}>Download the reports</Link>
            ) : (
              'No reports yet'
            )}
          </span>
        </div>
      </div>

      <Card
        title="Recent requests"
        action={
          <Link className="btn btn--sm" to={path('/requests')}>
            See all
          </Link>
        }
        flush
      >
        {recent.isLoading ? (
          <Loading />
        ) : (recent.data?.items.length ?? 0) === 0 ? (
          <Empty
            title="No requests yet"
            action={
              <Link className="btn btn--primary" to={path('/request/new')}>
                Create your first request
              </Link>
            }
          >
            When you need an inspection, raise a request here and the team picks it up.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Raised</th>
                </tr>
              </thead>
              <tbody>
                {recent.data?.items.map((request) => (
                  <tr
                    key={request.id}
                    className="is-clickable"
                    onClick={() => navigate(path(`/requests/${request.id}`))}
                  >
                    <td className="table__ref">{request.number}</td>
                    <td>{request.title}</td>
                    <td>
                      <StatusBadge status={request.displayStatus} />
                    </td>
                    <td className="muted">{formatDate(request.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Shell>
  );
}
