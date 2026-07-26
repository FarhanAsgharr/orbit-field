import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { Empty } from './components/ui';
import { ApiRequestError } from './lib/api';
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
import { Overview } from './pages/Overview';
import { Sync } from './pages/Sync';

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

function Protected(): React.ReactElement {
  const { status } = useSession();

  if (status === 'checking') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <span className="muted small">Restoring your session…</span>
      </div>
    );
  }

  if (status === 'anonymous') return <Navigate to="/sign-in" replace />;

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
              <Route path="/inspections/:id" element={<InspectionDetail />} />
              <Route path="/sync" element={<Sync />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/clients" element={<Clients />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/sites" element={<Sites />} />
              <Route path="/assets" element={<Assets />} />
              <Route path="/users" element={<People />} />
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
