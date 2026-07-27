/**
 * The inbox.
 *
 * Notifications were being written and delivered to phones, and there was no
 * way to read them on the website at all — a supervisor working from a desk
 * never saw that an inspection had been submitted for them.
 *
 * The list refreshes on an interval rather than on a socket. That is a
 * deliberate trade: this deployment runs on serverless functions with no
 * persistent connection to hold, and a 30-second poll costs one cheap query
 * while a websocket would need infrastructure that does not exist here. The
 * cost is that "real-time" means "within half a minute", which for
 * "an inspection was submitted" is the difference between nothing and nothing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Badge,
  Card,
  Empty,
  ErrorBanner,
  Loading,
  Pagination,
  relativeTime,
} from '../components/ui';
import { api } from '../lib/api';

interface Notification {
  id: string;
  topic: string;
  title: string;
  body: string;
  deepLink: string | null;
  readAt: string | null;
  createdAt: string;
  data?: Record<string, string>;
}

interface Inbox {
  items: Notification[];
  total: number;
  page: number;
  pageSize: number;
  unread: number;
}

/** Topic groups, as a person thinks of them rather than as the enum spells them. */
const GROUPS: Array<{ key: string; label: string; topics: string[] }> = [
  { key: '', label: 'Everything', topics: [] },
  { key: 'assignment', label: 'Assignments', topics: ['INSPECTION_ASSIGNED'] },
  {
    key: 'inspection',
    label: 'Inspections',
    topics: ['INSPECTION_APPROVED', 'INSPECTION_REJECTED', 'INSPECTION_DUE', 'INSPECTION_OVERDUE'],
  },
  {
    key: 'system',
    label: 'System',
    topics: ['SYNC_CONFLICT', 'SYNC_COMPLETED', 'UPLOAD_FAILED', 'REPORT_READY'],
  },
];

const topicTone = (topic: string): 'ok' | 'warn' | 'danger' | 'info' => {
  if (topic === 'INSPECTION_APPROVED') return 'ok';
  if (topic === 'INSPECTION_REJECTED' || topic === 'SYNC_CONFLICT' || topic === 'UPLOAD_FAILED')
    return 'danger';
  if (topic === 'INSPECTION_OVERDUE' || topic === 'INSPECTION_DUE') return 'warn';
  return 'info';
};

export function Notifications(): React.ReactElement {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [group, setGroup] = useState('');
  const [read, setRead] = useState<'' | 'true' | 'false'>('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Notification | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topics = GROUPS.find((g) => g.key === group)?.topics ?? [];

  const query = useQuery({
    queryKey: ['notifications', page, group, read, search],
    // Poll rather than push — see the note at the top of the file.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: () =>
      api.get<Inbox>('/notifications', {
        page,
        pageSize: 25,
        ...(read ? { read } : {}),
        ...(search ? { search } : {}),
        // The API filters one topic at a time; a group of several is narrowed
        // client-side over the page that came back.
        ...(topics.length === 1 ? { topic: topics[0] } : {}),
      }),
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    void queryClient.invalidateQueries({ queryKey: ['sync-health'] });
  };

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`, {}),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not mark it read.'),
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all', {}),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not mark them read.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/notifications/${id}`),
    onSuccess: () => {
      setOpen(null);
      refresh();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not delete it.'),
  });

  const raw = query.data?.items ?? [];
  // Client-side narrowing for the multi-topic groups the API cannot express.
  const items = topics.length > 1 ? raw.filter((n) => topics.includes(n.topic)) : raw;
  const unread = query.data?.unread ?? 0;

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">
            Notifications {unread > 0 ? <Badge label={`${unread} unread`} tone="accent" /> : null}
          </h1>
          <p className="page__subtitle">
            Assignments, review decisions and system alerts for your account.
          </p>
        </div>
        <div className="row gap-2">
          <button
            className="btn btn--ghost"
            onClick={() => markAll.mutate()}
            disabled={markAll.isPending || unread === 0}
          >
            {markAll.isPending ? 'Marking…' : 'Mark all as read'}
          </button>
        </div>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      <div className="toolbar">
        <input
          className="input toolbar__search"
          placeholder="Search notifications"
          aria-label="Search notifications"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Filter by kind"
          value={group}
          onChange={(e) => {
            setGroup(e.target.value);
            setPage(1);
          }}
        >
          {GROUPS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Filter by read state"
          value={read}
          onChange={(e) => {
            setRead(e.target.value as '' | 'true' | 'false');
            setPage(1);
          }}
        >
          <option value="">Read and unread</option>
          <option value="false">Unread only</option>
          <option value="true">Read only</option>
        </select>
        {search || group || read ? (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSearch('');
              setGroup('');
              setRead('');
              setPage(1);
            }}
          >
            Reset
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          className="modal__backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(null);
          }}
        >
          <div className="card modal" role="dialog" aria-modal="true" aria-label="Notification">
            <div className="card__head">
              <h2 className="card__title">{open.title}</h2>
              <button className="btn btn--ghost btn--sm" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
            <div className="card__body stack gap-4">
              <div className="row gap-2">
                <Badge
                  label={open.topic.replace(/_/g, ' ').toLowerCase()}
                  tone={topicTone(open.topic)}
                />
                <span className="muted small">{relativeTime(open.createdAt)}</span>
              </div>
              <p>{open.body}</p>
              {open.data?.inspectionId ? (
                <Link className="btn" to={`/inspections/${open.data.inspectionId}`}>
                  Open the inspection
                </Link>
              ) : null}
              <div className="row gap-2">
                {!open.readAt ? (
                  <button className="btn btn--ghost" onClick={() => markRead.mutate(open.id)}>
                    Mark as read
                  </button>
                ) : null}
                <button className="btn btn--ghost" onClick={() => remove.mutate(open.id)}>
                  {remove.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Card title={`Inbox (${query.data?.total ?? 0})`}>
        {query.isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            title={search || group || read ? 'Nothing matches' : 'Nothing yet'}
            body={
              search || group || read
                ? 'Try a wider filter.'
                : 'Assignments and review decisions appear here.'
            }
          />
        ) : (
          <ul className="stack gap-2">
            {items.map((n) => (
              <li
                key={n.id}
                className="row gap-3"
                style={{
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  padding: 'var(--s-3)',
                  borderLeft: n.readAt ? '2px solid transparent' : '2px solid var(--accent)',
                  background: n.readAt ? 'transparent' : 'var(--surface-2, transparent)',
                }}
              >
                <button
                  className="stack gap-1"
                  style={{
                    background: 'none',
                    border: 0,
                    textAlign: 'left',
                    cursor: 'pointer',
                    flex: 1,
                    color: 'inherit',
                  }}
                  onClick={() => {
                    setOpen(n);
                    if (!n.readAt) markRead.mutate(n.id);
                  }}
                >
                  <div className="row gap-2">
                    <strong>{n.title}</strong>
                    <Badge
                      label={n.topic.replace(/_/g, ' ').toLowerCase()}
                      tone={topicTone(n.topic)}
                    />
                    {!n.readAt ? <Badge label="unread" tone="accent" /> : null}
                  </div>
                  <span className="small muted">{n.body}</span>
                  <span className="small muted">{relativeTime(n.createdAt)}</span>
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  aria-label={`Delete ${n.title}`}
                  onClick={() => remove.mutate(n.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <Pagination
          page={query.data?.page ?? 1}
          pageSize={query.data?.pageSize ?? 25}
          total={query.data?.total ?? 0}
          onPage={setPage}
        />
      </Card>
    </>
  );
}
