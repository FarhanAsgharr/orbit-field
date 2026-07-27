import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { Empty } from './components/ui';
import { ApiRequestError } from './lib/api';
import { PORTAL_URL } from './lib/config';
import { SessionProvider, useSession } from './lib/auth';
import { Analytics } from './pages/Analytics';
import { Audit, Settings } from './pages/AuditSettings';
import { InspectionDetail } from './pages/InspectionDetail';
import {
  Assets,
  Clients,
  Devices,
  Inspections,
  People,
  Projects,
  Sites,
  Templates,
} from './pages/Lists';
import { Login } from './pages/Login';
import { Notifications } from './pages/Notifications';
import { Overview } from './pages/Overview';
import { Profile } from './pages/Profile';
import { InspectionRequests } from './pages/RequestReview';
import { Roles } from './pages/Roles';
import { Sync } from './pages/Sync';
import { TemplateDetail } from './pages/TemplateDetail';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        // A 401 is handled by the client's refresh path and a 403 will never
        // succeed on retry; retrying either just delays the real message.
        if (error instanceof ApiRequestError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

/**
 * Where a customer is sent if they reach the console.
 *
 * The Client Portal is its own application at its own address, and a customer
 * has no business on any screen in here. Their credentials are valid, though —
 * so this is a signpost rather than an error, and it signs them out so nothing
 * is left holding a console session.
 *
 * The rail, the routes and this guard were all removed or added together on
 * purpose: hiding the navigation alone would leave every URL reachable by
 * typing it.
 */
function WrongDoor(): React.ReactElement {
  const { signOut } = useSession();

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
      <Empty
        title="This is the operations console"
        body="Your account is a client account. Requests, reports and messages live in the client portal."
        action={
          <div className="row gap-2">
            <a className="btn btn--primary" href={PORTAL_URL}>
              Go to the client portal
            </a>
            <button type="button" className="btn" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        }
      />
    </div>
  );
}

function Protected(): React.ReactElement {
  const { status, user } = useSession();

  if (status === 'checking') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <span className="muted small">Restoring your session…</span>
      </div>
    );
  }

  if (status === 'anonymous') return <Navigate to="/sign-in" replace />;
  if (user?.role === 'CLIENT') return <WrongDoor />;

  return <Shell />;
}

function NotFound(): React.ReactElement {
  return (
    <Empty
      title="Page not found"
      body="That link does not point anywhere in the console."
      action={
        <a className="btn" href="/">
          Back to overview
        </a>
      }
    />
  );
}

function SignInRoute(): React.ReactElement {
  const { status } = useSession();
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <Login />;
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <Routes>
            <Route path="/sign-in" element={<SignInRoute />} />
            <Route element={<Protected />}>
              <Route path="/" element={<Overview />} />
              <Route path="/inspections" element={<Inspections />} />
              <Route path="/requests" element={<InspectionRequests />} />
              <Route path="/inspections/:id" element={<InspectionDetail />} />
              <Route path="/sync" element={<Sync />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/templates/:id" element={<TemplateDetail />} />
              <Route path="/clients" element={<Clients />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/sites" element={<Sites />} />
              <Route path="/assets" element={<Assets />} />
              <Route path="/users" element={<People />} />
              <Route path="/roles" element={<Roles />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/devices" element={<Devices />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
