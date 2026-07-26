/**
 * Application shell: nav rail + persistent fleet status bar.
 *
 * The status bar is not decoration. This console exists to answer one question —
 * "is field data reaching us right now" — and that answer stays on screen
 * whatever page the operator is reading. It is the reason someone opens the tool
 * at 7am, and burying it inside a dashboard route would mean they have to go
 * looking for it.
 */

import { Permission } from '@orbit/shared';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { initials, relativeTime } from './ui';

export interface SyncHealth {
  serverCursor: number;
  unresolvedConflicts: number;
  pendingUploads: number;
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    appVersion: string;
    userName: string;
    lastSyncAt: string | null;
    lastSeenAt: string | null;
    cursor: number;
    behind: number;
    stale: boolean;
  }>;
}

/** Fleet health, polled. The one query the whole console shares. */
export function useSyncHealth(): ReturnType<typeof useQuery<SyncHealth>> {
  const { can } = useSession();
  return useQuery<SyncHealth>({
    queryKey: ['sync-health'],
    queryFn: () => api.get<SyncHealth>('/admin/sync-health'),
    enabled: can(Permission.AUDIT_READ),
    // Slow enough not to hammer the API from a wall display left open all day,
    // fast enough that an operator watching a backlog drain sees it move.
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

interface NavItem {
  to: string;
  label: string;
  permission?: Permission;
  badge?: number;
}

function NavGroup({
  label,
  items,
}: {
  label: string;
  items: NavItem[];
}): React.ReactElement | null {
  const { can } = useSession();
  const visible = items.filter((item) => !item.permission || can(item.permission));
  if (visible.length === 0) return null;

  return (
    <div className="rail__group">
      <p className="rail__group-label">{label}</p>
      {visible.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) => `rail__link${isActive ? ' rail__link--active' : ''}`}
        >
          <span>{item.label}</span>
          {item.badge !== undefined && item.badge > 0 ? (
            <span className="rail__link-count">{item.badge > 99 ? '99+' : item.badge}</span>
          ) : null}
        </NavLink>
      ))}
    </div>
  );
}

function StatusBar({ health }: { health: SyncHealth | undefined }): React.ReactElement {
  const behind = health?.devices.filter((d) => d.behind > 0).length ?? 0;
  const stale = health?.devices.filter((d) => d.stale).length ?? 0;
  const conflicts = health?.unresolvedConflicts ?? 0;
  const uploads = health?.pendingUploads ?? 0;

  return (
    <div className="statusbar" role="status" aria-label="Fleet status">
      <div className="statusbar__item">
        <span className="statusbar__label">Server cursor</span>
        <span className="statusbar__value num">
          {health ? health.serverCursor.toLocaleString() : '—'}
        </span>
      </div>

      <div className="statusbar__divider" />

      <div className="statusbar__item">
        <span className="statusbar__label">Devices</span>
        <span className="statusbar__value num">{health?.devices.length ?? '—'}</span>
      </div>

      <div className="statusbar__item">
        <span className="statusbar__label">Behind</span>
        <span
          className={`statusbar__value num${behind > 0 ? ' statusbar__value--warn' : ' statusbar__value--ok'}`}
        >
          {health ? behind : '—'}
        </span>
      </div>

      <div className="statusbar__item">
        <span className="statusbar__label">Silent 24h+</span>
        <span
          className={`statusbar__value num${stale > 0 ? ' statusbar__value--warn' : ' statusbar__value--ok'}`}
        >
          {health ? stale : '—'}
        </span>
      </div>

      <div className="statusbar__divider" />

      <div className="statusbar__item">
        <span className="statusbar__label">Conflicts</span>
        <span
          className={`statusbar__value num${conflicts > 0 ? ' statusbar__value--danger' : ' statusbar__value--ok'}`}
        >
          {health ? conflicts : '—'}
        </span>
      </div>

      <div className="statusbar__item">
        <span className="statusbar__label">Media queued</span>
        <span
          className={`statusbar__value num${uploads > 0 ? ' statusbar__value--warn' : ' statusbar__value--ok'}`}
        >
          {health ? uploads : '—'}
        </span>
      </div>
    </div>
  );
}

export function Shell(): React.ReactElement {
  const { user, organization, signOut, can } = useSession();
  const { data: health } = useSyncHealth();

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <nav className="rail" aria-label="Sections">
        <div className="rail__brand">
          <div className="rail__mark">
            <span className="rail__glyph" aria-hidden="true" />
            Orbit Field
          </div>
          <p className="rail__org">{organization?.name ?? 'Operations'}</p>
        </div>

        <div className="rail__nav">
          <NavGroup
            label="Operations"
            items={[
              { to: '/', label: 'Overview' },
              { to: '/inspections', label: 'Inspections', permission: Permission.INSPECTION_READ },
              {
                to: '/sync',
                label: 'Sync monitoring',
                permission: Permission.AUDIT_READ,
                badge: health?.unresolvedConflicts ?? 0,
              },
              { to: '/analytics', label: 'Analytics', permission: Permission.ANALYTICS_READ },
            ]}
          />

          <NavGroup
            label="Configure"
            items={[
              { to: '/templates', label: 'Checklists', permission: Permission.TEMPLATE_READ },
              { to: '/clients', label: 'Clients', permission: Permission.CLIENT_READ },
              { to: '/projects', label: 'Projects', permission: Permission.PROJECT_READ },
              { to: '/sites', label: 'Sites', permission: Permission.SITE_READ },
            ]}
          />

          <NavGroup
            label="Administer"
            items={[
              { to: '/users', label: 'People', permission: Permission.USER_READ },
              { to: '/devices', label: 'Devices', permission: Permission.DEVICE_READ },
              { to: '/audit', label: 'Audit log', permission: Permission.AUDIT_READ },
              { to: '/settings', label: 'Settings', permission: Permission.ORG_READ },
            ]}
          />
        </div>

        <div className="rail__footer">
          <div className="rail__user">
            <span className="avatar" aria-hidden="true">
              {initials(user?.firstName, user?.lastName)}
            </span>
            <div className="grow truncate">
              <div className="small strong truncate">
                {user?.firstName} {user?.lastName}
              </div>
              <div className="small muted truncate">
                {user?.role.replace(/_/g, ' ').toLowerCase()}
              </div>
            </div>
          </div>
          <button
            className="btn btn--secondary btn--sm mt-4"
            style={{ width: '100%' }}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </nav>

      <div className="main">
        {can(Permission.AUDIT_READ) ? <StatusBar health={health} /> : null}
        <main id="main" className="page">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Cursor lag rail — the console's signature view.
 *
 * Every device sits somewhere on the organisation's monotonic change sequence.
 * "How far behind head is each device" is a position on a line, so it is drawn
 * as one: devices at head cluster hard right, stragglers trail left, and the eye
 * finds the outliers without reading a number. A table of the same data makes
 * the operator compare 40 integers by hand.
 */
export function CursorLagRail({ health }: { health: SyncHealth }): React.ReactElement {
  const devices = health.devices;

  if (devices.length === 0) {
    return <p className="muted small">No enrolled devices yet.</p>;
  }

  const maxBehind = Math.max(1, ...devices.map((d) => d.behind));

  // Square-root scale: most devices are at or near head, and a linear axis would
  // pile them into an unreadable clump against the right edge while one
  // week-old tablet stretches the rest into nothing.
  const position = (behind: number): number => 100 - Math.sqrt(behind / maxBehind) * 100;

  const bucket = (device: SyncHealth['devices'][number]): string => {
    if (device.stale) return 'stale';
    if (device.behind === 0) return 'current';
    if (device.behind <= maxBehind * 0.1) return 'near';
    return 'behind';
  };

  const counts = {
    current: devices.filter((d) => bucket(d) === 'current').length,
    near: devices.filter((d) => bucket(d) === 'near').length,
    behind: devices.filter((d) => bucket(d) === 'behind').length,
    stale: devices.filter((d) => bucket(d) === 'stale').length,
  };

  return (
    <div className="lagrail">
      <div className="row gap-4 wrap">
        <div>
          <div className="metric__value num">{counts.current}</div>
          <div className="metric__label">Up to date</div>
        </div>
        <div>
          <div
            className="metric__value num"
            style={{ color: counts.behind ? 'var(--warn)' : undefined }}
          >
            {counts.near + counts.behind}
          </div>
          <div className="metric__label">Behind head</div>
        </div>
        <div>
          <div
            className="metric__value num"
            style={{ color: counts.stale ? 'var(--danger)' : undefined }}
          >
            {counts.stale}
          </div>
          <div className="metric__label">Silent 24h+</div>
        </div>
      </div>

      <div className="lagrail__scale">
        <div className="lagrail__head" aria-hidden="true">
          <span className="lagrail__head-label">Head · {health.serverCursor.toLocaleString()}</span>
        </div>

        {devices.map((device, index) => (
          <span
            key={device.id}
            className={`lagrail__tick lagrail__tick--${bucket(device)}`}
            style={{
              left: `${position(device.behind)}%`,
              // Vertical jitter so devices at identical cursors do not stack
              // into a single invisible dot.
              bottom: `${-1 + (index % 5) * 13}px`,
            }}
            tabIndex={0}
            role="img"
            aria-label={`${device.name}, ${device.userName}, ${device.behind} changes behind, last synced ${relativeTime(device.lastSyncAt)}`}
            title={`${device.name} — ${device.userName}\n${device.behind.toLocaleString()} changes behind\nLast sync ${relativeTime(device.lastSyncAt)}`}
          />
        ))}
      </div>

      <div className="lagrail__axis">
        <span className="num">{maxBehind.toLocaleString()} behind</span>
        <span>up to date →</span>
      </div>

      <div className="lagrail__legend">
        <span className="lagrail__legend-item">
          <span className="lagrail__swatch" style={{ background: 'var(--ok)' }} /> At head
        </span>
        <span className="lagrail__legend-item">
          <span className="lagrail__swatch" style={{ background: 'var(--accent)' }} /> Nearly
          current
        </span>
        <span className="lagrail__legend-item">
          <span className="lagrail__swatch" style={{ background: 'var(--warn)' }} /> Behind
        </span>
        <span className="lagrail__legend-item">
          <span className="lagrail__swatch" style={{ background: 'var(--danger)' }} /> No contact
        </span>
      </div>
    </div>
  );
}
