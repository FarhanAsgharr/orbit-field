/**
 * Sync monitoring and conflict resolution.
 *
 * The conflict UI mirrors the mobile app's deliberately: nothing is
 * pre-selected for genuinely clashing fields, auto-merged fields are shown
 * rather than hidden, and neither side is labelled "correct". An operator
 * resolving from a desk has less context than the inspector who was on site, so
 * the interface must not nudge them toward a default.
 */

import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FieldDiff, JsonValue } from '@orbit/types';
import { api } from '../lib/api';
import { CursorLagRail, useSyncHealth } from '../components/Shell';
import { Badge, Card, Empty, ErrorBanner, Loading, relativeTime } from '../components/ui';

interface ConflictRecord {
  id: string;
  operationId: string;
  entity: string;
  entityId: string;
  baseVersion: number | null;
  serverVersion: number;
  localRecord: Record<string, JsonValue>;
  serverRecord: Record<string, JsonValue>;
  diffs: FieldDiff[];
  detectedAt: string;
  resolvedAt: string | null;
  user: { id: string; firstName: string; lastName: string } | null;
}

interface SyncSession {
  id: string;
  trigger: string;
  pushedCount: number;
  pulledCount: number;
  conflictCount: number;
  outcome: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
  device: { id: string; name: string; platform: string; appVersion: string } | null;
  user: { firstName: string; lastName: string } | null;
}

/** Render any JSON value in a form an operator can compare at a glance. */
function display(value: JsonValue): string {
  if (value === null || value === undefined) return '— empty —';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.trim() === '') return '— empty —';
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
    }
    return value;
  }
  if (Array.isArray(value)) return value.length === 0 ? '— none —' : value.map(String).join(', ');
  return JSON.stringify(value);
}

export function Sync(): React.ReactElement {
  const { data: health, isLoading: healthLoading } = useSyncHealth();

  const { data: conflicts, isLoading: conflictsLoading } = useQuery<{ items: ConflictRecord[]; total: number }>({
    queryKey: ['conflicts', 'unresolved'],
    queryFn: () => api.get<{ items: ConflictRecord[]; total: number }>('/admin/conflicts', { resolved: false, pageSize: 50 }),
    refetchInterval: 30_000,
  });

  const { data: sessions } = useQuery<{ items: SyncSession[] }>({
    queryKey: ['sync-sessions'],
    queryFn: () => api.get<{ items: SyncSession[] }>('/admin/sync-sessions', { pageSize: 25 }),
    refetchInterval: 30_000,
  });

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Sync monitoring</h1>
          <p className="page__subtitle">
            Where every device sits relative to the server, and what is waiting on a decision.
          </p>
        </div>
      </header>

      <Card title="Fleet position" flush>
        {healthLoading ? <Loading rows={3} /> : health ? <CursorLagRail health={health} /> : (
          <Empty title="Fleet data unavailable" />
        )}
      </Card>

      <div className="mt-6">
        <Card
          title={`Conflicts awaiting a decision${conflicts?.total ? ` (${conflicts.total})` : ''}`}
          flush
        >
          {conflictsLoading ? (
            <Loading rows={3} />
          ) : !conflicts || conflicts.items.length === 0 ? (
            <Empty
              title="No conflicts"
              body="When two people change the same record while one is offline, it appears here for a decision. Nothing is ever overwritten automatically."
            />
          ) : (
            <div className="stack">
              {conflicts.items.map((conflict) => (
                <ConflictCard key={conflict.operationId} conflict={conflict} />
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card title="Recent sync activity" flush>
          {!sessions ? (
            <Loading rows={4} />
          ) : sessions.items.length === 0 ? (
            <Empty title="No sync activity yet" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Person</th>
                    <th>Trigger</th>
                    <th style={{ textAlign: 'right' }}>Sent</th>
                    <th style={{ textAlign: 'right' }}>Received</th>
                    <th style={{ textAlign: 'right' }}>Conflicts</th>
                    <th style={{ textAlign: 'right' }}>Took</th>
                    <th>Result</th>
                    <th style={{ textAlign: 'right' }}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.items.map((session) => (
                    <tr key={session.id}>
                      <td className="table__primary">{session.device?.name ?? '—'}</td>
                      <td className="table__meta">
                        {session.user ? `${session.user.firstName} ${session.user.lastName}` : '—'}
                      </td>
                      <td className="table__meta">{session.trigger.toLowerCase()}</td>
                      <td className="table__num num">{session.pushedCount}</td>
                      <td className="table__num num">{session.pulledCount}</td>
                      <td className="table__num num" style={{ color: session.conflictCount ? 'var(--danger)' : undefined }}>
                        {session.conflictCount}
                      </td>
                      <td className="table__num num table__meta">
                        {session.durationMs !== null ? `${(session.durationMs / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td>
                        <Badge
                          label={(session.outcome ?? 'running').toLowerCase()}
                          tone={
                            session.outcome === 'SUCCESS' ? 'ok'
                            : session.outcome === 'PARTIAL' ? 'warn'
                            : session.outcome === 'FAILED' ? 'danger'
                            : 'neutral'
                          }
                        />
                      </td>
                      <td className="table__num table__meta">{relativeTime(session.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function ConflictCard({ conflict }: { conflict: ConflictRecord }): React.ReactElement {
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Record<string, 'LOCAL' | 'SERVER'>>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const clashing = useMemo(() => conflict.diffs.filter((d) => d.isConflicting), [conflict.diffs]);
  const auto = useMemo(() => conflict.diffs.filter((d) => !d.isConflicting), [conflict.diffs]);
  const allDecided = clashing.every((d) => choices[d.path] !== undefined);

  const resolve = useMutation({
    mutationFn: (strategy: 'KEEP_LOCAL' | 'KEEP_SERVER' | 'MERGE') =>
      api.post('/sync/conflicts/resolve', {
        operationId: conflict.operationId,
        strategy,
        fieldChoices: strategy === 'MERGE' ? choices : undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conflicts'] });
      void queryClient.invalidateQueries({ queryKey: ['sync-health'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not apply that decision.'),
  });

  const author = conflict.user ? `${conflict.user.firstName} ${conflict.user.lastName}` : 'An inspector';

  return (
    <div style={{ borderBottom: '1px solid var(--line)', padding: 'var(--s-5)' }}>
      <div className="row gap-3 wrap">
        <Badge label={conflict.entity.toLowerCase()} tone="danger" glyph="⚠" />
        <span className="strong">
          {clashing.length > 0
            ? `${clashing.length} field${clashing.length === 1 ? '' : 's'} need a decision`
            : 'No clashing edits — safe to merge'}
        </span>
        <span className="right small muted">
          {author} · detected {relativeTime(conflict.detectedAt)}
        </span>
      </div>

      {error ? <div className="mt-4"><ErrorBanner message={error} /></div> : null}

      {clashing.length > 0 ? (
        <div className="stack gap-4 mt-4">
          {clashing.map((diff) => (
            <div key={diff.path}>
              <div className="strong small" style={{ marginBottom: 'var(--s-2)' }}>{diff.label}</div>
              <div className="grid grid--2 gap-3">
                <ChoiceOption
                  title="Field version"
                  subtitle={`Changed by ${author} on their device`}
                  value={display(diff.localValue)}
                  selected={choices[diff.path] === 'LOCAL'}
                  onSelect={() => setChoices((c) => ({ ...c, [diff.path]: 'LOCAL' }))}
                />
                <ChoiceOption
                  title="Server version"
                  subtitle="Changed here, after they went offline"
                  value={display(diff.serverValue)}
                  selected={choices[diff.path] === 'SERVER'}
                  onSelect={() => setChoices((c) => ({ ...c, [diff.path]: 'SERVER' }))}
                />
              </div>
              {diff.baseValue !== null && diff.baseValue !== undefined ? (
                <p className="small muted mt-2">
                  Before either change: {display(diff.baseValue)}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {auto.length > 0 ? (
        <div className="mt-4">
          <button className="btn btn--ghost btn--sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide' : 'Show'} {auto.length} field{auto.length === 1 ? '' : 's'} merged automatically
          </button>
          {expanded ? (
            <div className="stack gap-2 mt-2">
              {auto.map((diff) => (
                <div key={diff.path} className="row gap-3 small">
                  <span className="strong">{diff.label}</span>
                  <Badge
                    label={diff.autoResolution === 'KEEP_LOCAL' ? 'field version kept' : 'server version kept'}
                    tone={diff.autoResolution === 'KEEP_LOCAL' ? 'accent' : 'info'}
                  />
                  <span className="right muted truncate" style={{ maxWidth: 320 }}>
                    {display(diff.autoResolution === 'KEEP_LOCAL' ? diff.localValue : diff.serverValue)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="row gap-3 mt-4 wrap">
        <button
          className="btn"
          onClick={() => resolve.mutate('MERGE')}
          disabled={(clashing.length > 0 && !allDecided) || resolve.isPending}
        >
          {clashing.length > 0 ? 'Apply these choices' : 'Merge and continue'}
        </button>
        <button className="btn btn--secondary" onClick={() => resolve.mutate('KEEP_LOCAL')} disabled={resolve.isPending}>
          Keep all field versions
        </button>
        <button className="btn btn--secondary" onClick={() => resolve.mutate('KEEP_SERVER')} disabled={resolve.isPending}>
          Keep all server versions
        </button>
        {clashing.length > 0 && !allDecided ? (
          <span className="small muted">Choose a version for each field above.</span>
        ) : null}
      </div>
    </div>
  );
}

function ChoiceOption({
  title, subtitle, value, selected, onSelect,
}: {
  title: string; subtitle: string; value: string; selected: boolean; onSelect: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        textAlign: 'left',
        padding: 'var(--s-4)',
        borderRadius: 'var(--r-md)',
        border: `2px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
        background: selected ? 'var(--accent-wash)' : 'var(--surface)',
        cursor: 'pointer',
        width: '100%',
      }}
    >
      <div className="row gap-2">
        <span
          aria-hidden="true"
          style={{
            width: 14, height: 14, borderRadius: '50%',
            border: `2px solid ${selected ? 'var(--accent)' : 'var(--line-strong)'}`,
            background: selected ? 'var(--accent)' : 'transparent',
            flexShrink: 0,
          }}
        />
        <span className="strong small">{title}</span>
      </div>
      <div className="small muted mt-2">{subtitle}</div>
      <div className="mt-2">{value}</div>
    </button>
  );
}
