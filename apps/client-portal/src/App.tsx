/**
 * Routes.
 *
 * Everything sits under `/client` even though this is the portal's own
 * deployment and the prefix is technically redundant. It is there so the paths
 * are stable if the portal is ever served from a path on a shared domain, and
 * so a link a customer pastes into an email is unambiguous about what it is.
 * `/` redirects, so nobody has to know.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { Loading } from './components/ui';
import { SessionProvider, useSession } from './lib/session';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { Messages } from './pages/Messages';
import { NewRequest } from './pages/NewRequest';
import { Profile } from './pages/Profile';
import { Register } from './pages/Register';
import { RequestDetail } from './pages/RequestDetail';
import { Requests } from './pages/Requests';
import { Reports } from './pages/Reports';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A customer's data changes when staff act on it, minutes or hours
      // apart. Refetching on every window focus would be noise.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactElement }): React.ReactElement {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'checking') return <Loading label="Loading your portal…" />;
  if (status === 'anonymous') {
    // Where they were headed, so signing in lands them there rather than on a
    // generic dashboard.
    return <Navigate to="/client/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

function AppRoutes(): React.ReactElement {
  return (
    <Routes>
      <Route path="/client/login" element={<Login />} />
      <Route path="/client/register" element={<Register />} />

      <Route
        path="/client/dashboard"
        element={
          <RequireAuth>
            <Dashboard />
          </RequireAuth>
        }
      />
      <Route
        path="/client/request/new"
        element={
          <RequireAuth>
            <NewRequest />
          </RequireAuth>
        }
      />
      <Route
        path="/client/requests"
        element={
          <RequireAuth>
            <Requests />
          </RequireAuth>
        }
      />
      <Route
        path="/client/requests/:id"
        element={
          <RequireAuth>
            <RequestDetail />
          </RequireAuth>
        }
      />
      <Route
        path="/client/messages"
        element={
          <RequireAuth>
            <Messages />
          </RequireAuth>
        }
      />
      <Route
        path="/client/reports"
        element={
          <RequireAuth>
            <Reports />
          </RequireAuth>
        }
      />
      <Route
        path="/client/profile"
        element={
          <RequireAuth>
            <Profile />
          </RequireAuth>
        }
      />

      {/* Anything else is the dashboard, or the sign-in screen on the way to it. */}
      <Route path="*" element={<Navigate to="/client/dashboard" replace />} />
    </Routes>
  );
}

export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <AppRoutes />
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
