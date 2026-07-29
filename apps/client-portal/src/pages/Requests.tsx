/**
 * Every request this company has raised.
 *
 * The list is deliberately flat — no grouping, no saved views. A customer has
 * tens of requests, not thousands, and a filter row plus a search box covers
 * everything they would otherwise need a view for.
 */

import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { usePortalPath } from '../App';
import { Shell } from '../components/Shell';
import {
  Card,
  Empty,
  formatDate,
  Loading,
  Notice,
  PriorityBadge,
  StatusBadge,
} from '../components/ui';
import { api } from '../lib/api';

export interface RequestSummary {
  id: string;
  number: string;
  title: string;
  status: string;
  displayStatus: string;
  priority: string;
  projectName: string | null;
  siteName: string | null;
  preferredDate: string | null;
  createdAt: string;
  site: { id: string; name: string } | null;
  inspection: { id: string; number: string; status: string } | null;
  _count: { attachments: number; comments: number };
}

const FILTERS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'PENDING_APPROVAL', label: 'Awaiting review' },
  { value: 'INFORMATION_REQUESTED', label: 'Needs your reply' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Declined' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function Requests(): React.ReactElement {
  const path = usePortalPath();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const requests = useQuery({
    queryKey: ['requests', status, search, page],
    queryFn: () =>
      api.get<{ items: RequestSummary[]; total: number; page: number; pageSize: number }>(
        '/inspection-requests',
        { page, pageSize: 20, status: status || undefined, search: search || undefined },
      ),
  });

  const total = requests.data?.total ?? 0;
  const pageSize = requests.data?.pageSize ?? 20;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Shell
      title="My requests"
      subtitle="Everything you have asked for, and where it has got to."
      actions={
        <Link className="btn btn--primary" to={path('/request/new')}>
          New request
        </Link>
      }
    >
      <div className="row row--between">
        <div className="row">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={
                status === filter.value ? 'btn btn--sm btn--primary' : 'btn btn--sm btn--ghost'
              }
              onClick={() => {
                setStatus(filter.value);
                setPage(1);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          type="search"
          placeholder="Search by title or reference"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {requests.isError && <Notice>Your requests could not be loaded. Try reloading.</Notice>}

      <Card flush>
        {requests.isLoading ? (
          <Loading />
        ) : (requests.data?.items.length ?? 0) === 0 ? (
          <Empty
            title={search || status ? 'Nothing matches that' : 'No requests yet'}
            action={
              search || status ? undefined : (
                <Link className="btn btn--primary" to={path('/request/new')}>
                  Create a request
                </Link>
              )
            }
          >
            {search || status
              ? 'Try a different filter or search term.'
              : 'When you need an inspection, raise a request and the team picks it up.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Title</th>
                  <th>Location</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Raised</th>
                  <th>Files</th>
                </tr>
              </thead>
              <tbody>
                {requests.data?.items.map((request) => (
                  <tr
                    key={request.id}
                    className="is-clickable"
                    onClick={() => navigate(path(`/requests/${request.id}`))}
                  >
                    <td className="table__ref">{request.number}</td>
                    <td>
                      {request.title}
                      {request.inspection && (
                        <div className="faint">Inspection {request.inspection.number}</div>
                      )}
                    </td>
                    <td className="muted">
                      {request.site?.name ?? request.siteName ?? request.projectName ?? '—'}
                    </td>
                    <td>
                      <PriorityBadge priority={request.priority} />
                    </td>
                    <td>
                      <StatusBadge status={request.displayStatus} />
                    </td>
                    <td className="muted">{formatDate(request.createdAt)}</td>
                    <td className="muted">{request._count.attachments || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pages > 1 && (
        <div className="row row--between">
          <span className="faint">
            Page {page} of {pages} · {total} requests
          </span>
          <div className="row">
            <button
              type="button"
              className="btn btn--sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn btn--sm"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </Shell>
  );
}
