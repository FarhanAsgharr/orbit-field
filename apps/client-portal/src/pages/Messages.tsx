/**
 * Every conversation, in one place.
 *
 * Messages in Orbit Field are always *about* something — there is no direct
 * messaging between a customer and the company, because a message with no
 * request attached is a message nobody knows who should answer. So this is an
 * inbox of request threads rather than a chat client, and opening one takes
 * you to the request where the reply box lives next to the context.
 */

import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Shell } from '../components/Shell';
import {
  Card,
  Empty,
  initials,
  Loading,
  Notice,
  relativeTime,
  StatusBadge,
} from '../components/ui';
import { api } from '../lib/api';

interface Thread {
  id: string;
  number: string;
  title: string;
  status: string;
  displayStatus: string;
  messageCount: number;
  lastMessage: {
    id: string;
    body: string;
    createdAt: string;
    author: { id: string; firstName: string; lastName: string } | null;
  };
}

export function Messages(): React.ReactElement {
  const navigate = useNavigate();

  const threads = useQuery({
    queryKey: ['messages'],
    queryFn: () => api.get<Thread[]>('/inspection-requests/meta/conversations'),
  });

  return (
    <Shell title="Messages" subtitle="Conversations with the team, grouped by request.">
      {threads.isError && <Notice>Your messages could not be loaded. Try reloading.</Notice>}

      <Card flush>
        {threads.isLoading ? (
          <Loading />
        ) : (threads.data?.length ?? 0) === 0 ? (
          <Empty
            title="No messages yet"
            action={
              <Link className="btn btn--primary" to="/client/requests">
                Go to my requests
              </Link>
            }
          >
            Open any request and write a message — it goes straight to the team handling it.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Latest message</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {threads.data?.map((thread) => (
                  <tr
                    key={thread.id}
                    className="is-clickable"
                    onClick={() => navigate(`/client/requests/${thread.id}`)}
                  >
                    <td>
                      <div style={{ fontWeight: 550 }}>{thread.title}</div>
                      <div className="table__ref">{thread.number}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
                        <span className="message__avatar" aria-hidden="true">
                          {initials(
                            thread.lastMessage.author?.firstName,
                            thread.lastMessage.author?.lastName,
                          )}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="faint">
                            {thread.lastMessage.author
                              ? `${thread.lastMessage.author.firstName} ${thread.lastMessage.author.lastName}`.trim()
                              : 'Removed user'}
                            {thread.messageCount > 1 && ` · ${thread.messageCount} messages`}
                          </div>
                          <div
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: 380,
                            }}
                          >
                            {thread.lastMessage.body}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={thread.displayStatus} />
                    </td>
                    <td className="muted">{relativeTime(thread.lastMessage.createdAt)}</td>
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
