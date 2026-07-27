/**
 * What each role can actually do.
 *
 * `/users/meta/roles` has always returned the full matrix — every role, its
 * rank, its permissions, and whether the person looking may grant it — and
 * nothing rendered it. The rules were only discoverable by being refused.
 *
 * Read-only, deliberately. These are system roles: the permission sets are
 * compiled into the shared RBAC module and enforced on every request, so a
 * screen that let somebody edit them would either be lying or would be a way
 * to grant yourself anything. Per-user exceptions already exist through
 * `extraPermissions` / `revokedPermissions` on the People page, which is the
 * right place for them because they are auditable against one person.
 */

import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';

import { Badge, Card, Empty, Loading, roleBadge } from '../components/ui';
import { api } from '../lib/api';

interface RoleRow {
  role: string;
  rank: number;
  permissions: string[];
  assignable: boolean;
}

interface RoleMatrix {
  roles: RoleRow[];
  permissions: string[];
}

/** What each role is for, in the words somebody hiring for it would use. */
const DESCRIPTIONS: Record<string, string> = {
  SUPER_ADMIN:
    'The organisation owner. Everything, including organisation settings and permanent deletion.',
  ADMIN:
    'Runs the operation day to day: people, projects, sites, assets, checklists and scheduling.',
  MANAGER: 'Manages the work and the reference data behind it, but not accounts or org settings.',
  SUPERVISOR:
    'Reviews submitted inspections and monitors their teams. Website only — cannot manage accounts.',
  INSPECTOR: 'Carries out inspections in the field app. Sees only the work assigned to them.',
  TECHNICIAN: 'Field access for a narrower set of work than an inspector.',
  VIEWER: 'Read-only. Can see records and export what they can see, and change nothing.',
};

/** Group permissions by the resource they act on, which is how people look for them. */
const groupOf = (permission: string): string => {
  const [resource] = permission.split(':');
  return (resource ?? 'other').replace(/_/g, ' ');
};

export function Roles(): React.ReactElement {
  const [search, setSearch] = useState('');
  const [focus, setFocus] = useState('');

  const query = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleMatrix>('/users/meta/roles'),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) {
    return <Empty title="Could not load roles" body="You may not have permission to see this." />;
  }

  const { roles, permissions } = query.data;
  const ordered = [...roles].sort((a, b) => b.rank - a.rank);
  const shown = focus ? ordered.filter((r) => r.role === focus) : ordered;

  const groups = new Map<string, string[]>();
  for (const p of permissions) {
    const term = search.trim().toLowerCase();
    if (term && !p.toLowerCase().includes(term)) continue;
    const g = groupOf(p);
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }

  return (
    <>
      <header className="page__head">
        <div>
          <h1 className="page__title">Roles and permissions</h1>
          <p className="page__subtitle">
            What each role can do. These are system roles and cannot be edited — per-person
            exceptions live on the People page.
          </p>
        </div>
      </header>

      <div className="grid grid--2 gap-4">
        {ordered.map((r) => {
          const badge = roleBadge(r.role);
          return (
            <Card key={r.role} title={badge.label}>
              <div className="stack gap-3">
                <div className="row gap-2">
                  <Badge label={badge.label} tone={badge.tone} />
                  <span className="muted small">rank {r.rank}</span>
                  <Badge
                    label={r.assignable ? 'you can grant this' : 'you cannot grant this'}
                    tone={r.assignable ? 'ok' : 'neutral'}
                  />
                </div>
                <p className="small">{DESCRIPTIONS[r.role] ?? 'No description.'}</p>
                <span className="muted small">
                  {r.permissions.length} of {permissions.length} permissions
                </span>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="toolbar">
        <input
          className="input toolbar__search"
          placeholder="Search permissions, e.g. inspection or delete"
          aria-label="Search permissions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Show one role"
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
        >
          <option value="">Every role</option>
          {ordered.map((r) => (
            <option key={r.role} value={r.role}>
              {roleBadge(r.role).label}
            </option>
          ))}
        </select>
        {search || focus ? (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setSearch('');
              setFocus('');
            }}
          >
            Reset
          </button>
        ) : null}
      </div>

      {groups.size === 0 ? (
        <Empty title="No permission matches that" body="Try a shorter term." />
      ) : (
        [...groups.entries()].map(([group, perms]) => (
          <Card key={group} title={group.charAt(0).toUpperCase() + group.slice(1)}>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Permission</th>
                    {shown.map((r) => (
                      <th key={r.role} style={{ textAlign: 'center' }}>
                        {roleBadge(r.role).label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {perms.map((p) => (
                    <tr key={p}>
                      <td className="num">{p}</td>
                      {shown.map((r) => (
                        <td key={r.role} style={{ textAlign: 'center' }}>
                          {r.permissions.includes(p) ? (
                            <span aria-label={`${roleBadge(r.role).label} has ${p}`}>✓</span>
                          ) : (
                            <span
                              className="muted"
                              aria-label={`${roleBadge(r.role).label} does not have ${p}`}
                            >
                              —
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </>
  );
}
