/**
 * Routes.
 *
 * Every screen lives under a company: `/acme/login`, `/acme/dashboard`. The
 * first path segment is the tenant, and it is the only thing that decides
 * which company a visitor is dealing with — there is no picker anywhere in
 * this application, and no screen that can show one company's name to another
 * company's customer.
 *
 * `TenantGate` resolves the company before anything else renders and refuses
 * to draw a portal for a slug the server does not recognise. A wrong or
 * invented address gets the same page as a company that has closed
 * registration, so guessing at addresses reveals nothing.
 *
 * The bare root is deliberately a dead end that names no companies. Somebody
 * who arrives without a company link is told to ask for one.
 */

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';

import { Loading, Notice } from './components/ui';
import { api } from './lib/api';
import { SessionProvider, useSession } from './lib/session';
import { resolveTenant, tenantIsInHost } from './lib/tenant';
import { AcceptInvitation, RegistrationClosed } from './pages/AcceptInvitation';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Messages } from './pages/Messages';
import { NewRequest } from './pages/NewRequest';
import { Profile } from './pages/Profile';
import { RequestDetail } from './pages/RequestDetail';
import { Requests } from './pages/Requests';
import { Reports } from './pages/Reports';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export interface Tenant {
  slug: string;
  name: string;
}

const TenantContext = React.createContext<Tenant | null>(null);

/** The company this portal is for. Never null inside the gate. */
export function useTenant(): Tenant {
  const tenant = React.useContext(TenantContext);
  if (!tenant) throw new Error('useTenant must be used inside a TenantGate');
  return tenant;
}

/** Prefix a path with the company, unless the hostname already carries it. */
export function usePortalPath(): (path: string) => string {
  const tenant = React.useContext(TenantContext);
  return (path: string) => {
    const clean = path.startsWith('/') ? path : `/${path}`;
    if (!tenant || tenantIsInHost()) return clean;
    return `/${tenant.slug}${clean}`;
  };
}

/**
 * Somebody opened the portal without a company.
 *
 * No list, no search, no suggestions. The link is something their company
 * gives them, and any hint here would leak who else is on the platform.
 */
function NoTenant(): React.ReactElement {
  return (
    <div className="auth">
      <aside className="auth__aside">
        <div className="auth__mark">
          <span className="auth__glyph" aria-hidden="true" />
          Orbit Field
        </div>
        <div>
          <h2>Client portal</h2>
          <p style={{ opacity: 0.85, marginTop: 16 }}>Each company has its own portal address.</p>
        </div>
        <p style={{ opacity: 0.75, fontSize: 13 }}>Orbit Field</p>
      </aside>
      <div className="auth__panel">
        <div className="auth__form">
          <h1>You need your company&rsquo;s portal link</h1>
          <Notice kind="info">
            This address does not belong to a company. Ask the company carrying out your inspections
            for their portal link — it looks like <code>{window.location.origin}/your-company</code>
            .
          </Notice>
        </div>
      </div>
    </div>
  );
}

/**
 * Resolve the company before drawing anything.
 *
 * The server is asked whether the slug names a real company, so an invented
 * address cannot render a convincing-looking portal. It answers for one
 * company only and never lists others.
 */
function TenantGate({ children }: { children: React.ReactElement }): React.ReactElement {
  const params = useParams();
  const location = useLocation();
  const slug =
    params.company ??
    resolveTenant({ hostname: window.location.hostname, pathname: location.pathname });

  const tenant = useQuery({
    queryKey: ['tenant', slug],
    queryFn: () => api.get<Tenant>(`/portal/tenant/${slug}`),
    enabled: Boolean(slug),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!slug) return <NoTenant />;
  if (tenant.isLoading) return <Loading label="Loading…" />;
  if (tenant.isError || !tenant.data) return <NoTenant />;

  return <TenantContext.Provider value={tenant.data}>{children}</TenantContext.Provider>;
}

function RequireAuth({ children }: { children: React.ReactElement }): React.ReactElement {
  const { status } = useSession();
  const location = useLocation();
  const path = usePortalPath();

  if (status === 'checking') return <Loading label="Loading your portal…" />;
  if (status === 'anonymous') {
    return <Navigate to={path('/login')} replace state={{ from: location.pathname }} />;
  }
  return children;
}

/** The screens, once a company is known. */
function TenantRoutes(): React.ReactElement {
  const guarded = (element: React.ReactElement) => <RequireAuth>{element}</RequireAuth>;

  return (
    <Routes>
      <Route path="login" element={<Login />} />
      {/* The only way an account is created. */}
      <Route path="invite/:token" element={<AcceptInvitation />} />
      <Route path="register" element={<RegistrationClosed />} />
      <Route path="dashboard" element={guarded(<Dashboard />)} />
      <Route path="request/new" element={guarded(<NewRequest />)} />
      <Route path="requests" element={guarded(<Requests />)} />
      <Route path="requests/:id" element={guarded(<RequestDetail />)} />
      <Route path="messages" element={guarded(<Messages />)} />
      <Route path="reports" element={guarded(<Reports />)} />
      <Route path="profile" element={guarded(<Profile />)} />
      <Route index element={<Navigate to="dashboard" replace />} />
      <Route path="*" element={<Navigate to="dashboard" replace />} />
    </Routes>
  );
}

function AppRoutes(): React.ReactElement {
  /*
   * On a subdomain deployment the company is in the origin, so paths carry no
   * company segment and the tenant routes sit at the root. On this deployment
   * the company is the first segment.
   */
  if (tenantIsInHost()) {
    return (
      <TenantGate>
        <SessionProvider>
          <TenantRoutes />
        </SessionProvider>
      </TenantGate>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<NoTenant />} />
      {/*
        `/client/*` was the old shape, before portals were per company. Anyone
        holding one of those links has no company in it, so there is nothing to
        redirect them to but the page explaining that.
      */}
      <Route path="/client/*" element={<NoTenant />} />
      <Route
        path="/:company/*"
        element={
          <TenantGate>
            <SessionProvider>
              <TenantRoutes />
            </SessionProvider>
          </TenantGate>
        }
      />
      <Route path="*" element={<NoTenant />} />
    </Routes>
  );
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
