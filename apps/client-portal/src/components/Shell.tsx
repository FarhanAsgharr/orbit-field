/**
 * The signed-in frame.
 *
 * Six destinations and nothing else. There is no permission check deciding
 * what appears here because there is nothing to decide: every customer sees
 * the same six links, and the pages behind them are narrowed server-side to
 * the caller's own company. A navigation item that some customers could not
 * use would mean the portal had grown a role system, which is the thing this
 * separation exists to avoid.
 */

import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { usePortalPath, useTenant } from '../App';
import { useSession } from '../lib/session';
import { initials } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  end?: boolean;
}

const icon = (path: React.ReactNode): React.ReactElement => (
  <svg className="nav__icon" viewBox="0 0 24 24" aria-hidden="true">
    {path}
  </svg>
);

const ITEMS: NavItem[] = [
  {
    to: '/dashboard',
    label: 'Dashboard',
    icon: icon(
      <>
        <rect x="3" y="3" width="7" height="8" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="11" width="7" height="10" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </>,
    ),
  },
  {
    to: '/request/new',
    label: 'Create request',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </>,
    ),
  },
  {
    to: '/requests',
    label: 'My requests',
    icon: icon(
      <>
        <path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v5h5M9 13h6M9 17h4" />
      </>,
    ),
  },
  {
    to: '/messages',
    label: 'Messages',
    icon: icon(<path d="M21 12a8 8 0 0 1-8 8H4l2.2-2.7A8 8 0 1 1 21 12Z" />),
  },
  {
    to: '/reports',
    label: 'Reports',
    icon: icon(
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </>,
    ),
  },
  {
    to: '/profile',
    label: 'Profile',
    icon: icon(
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M5 21a7 7 0 0 1 14 0" />
      </>,
    ),
  },
];

export function Shell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const { user, company, signOut } = useSession();
  const path = usePortalPath();
  const tenant = useTenant();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Navigating on a phone should close the drawer, or the destination is
  // hidden behind the menu that took you there.
  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    document.title = `${title} — ${tenant.name}`;
  }, [title, tenant.name]);

  return (
    <div className="portal">
      {navOpen && (
        <button
          type="button"
          className="nav__scrim"
          aria-label="Close the menu"
          onClick={() => setNavOpen(false)}
        />
      )}

      <nav className={navOpen ? 'nav nav--open' : 'nav'} aria-label="Portal">
        <div className="nav__brand">
          {company?.logoUrl ? (
            <img className="nav__logo" src={company.logoUrl} alt="" />
          ) : (
            <span className="nav__initials" aria-hidden="true">
              {initials(company?.name)}
            </span>
          )}
          <div className="nav__company">
            <div className="nav__company-label">{tenant.name}</div>
            <div className="nav__company-name" title={company?.name ?? ''}>
              {company?.name ?? '—'}
            </div>
          </div>
        </div>

        <div className="nav__links">
          {ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={path(item.to)}
              end={item.end}
              className={({ isActive }) => (isActive ? 'nav__link nav__link--active' : 'nav__link')}
            >
              {item.icon}
              {item.label}
            </NavLink>
          ))}
        </div>

        <div className="nav__footer">
          <div className="nav__user">
            {user?.avatarUrl ? (
              <img className="nav__avatar" src={user.avatarUrl} alt="" />
            ) : (
              <span className="nav__avatar" aria-hidden="true">
                {initials(user?.firstName, user?.lastName)}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="nav__user-name">
                {user ? `${user.firstName} ${user.lastName}`.trim() : ''}
              </div>
              <div className="nav__user-mail" title={user?.email ?? ''}>
                {user?.email}
              </div>
            </div>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </nav>

      <main className="main">
        <header className="main__header">
          <div className="row">
            <button
              type="button"
              className="nav__toggle"
              aria-label="Open the menu"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M4 6h16M4 12h16M4 18h16"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
            <div className="main__title-block">
              <h1>{title}</h1>
              {subtitle && <p className="main__subtitle">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
        <div className="main__body">{children}</div>
      </main>
    </div>
  );
}
