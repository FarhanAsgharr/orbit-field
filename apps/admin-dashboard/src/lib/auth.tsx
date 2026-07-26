/**
 * Session context.
 *
 * Unlike the mobile app, this console is online-only by nature — it reads
 * server-side aggregates that have no local mirror. So there is no offline
 * restore path: if the session cannot be revalidated, the operator signs in
 * again. That is the correct trade for a privileged desk tool.
 */

import { effectivePermissions, type Permission } from '@orbit/shared';
import type { AuthSession } from '@orbit/types';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  api,
  clearTokens,
  hasSession,
  login as apiLogin,
  logout as apiLogout,
  onAuthLost,
  register as apiRegister,
  type RegisterInput,
} from './api';

interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
}

interface SessionState {
  status: 'checking' | 'authenticated' | 'anonymous';
  user: SessionUser | null;
  organization: { id: string; name: string } | null;
  permissions: Set<string>;
  error: string | null;
  busy: boolean;
}

interface SessionContextValue extends SessionState {
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: RegisterInput) => Promise<void>;
  signOut: () => Promise<void>;
  can: (permission: Permission | string) => boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = useState<SessionState>({
    status: 'checking',
    user: null,
    organization: null,
    permissions: new Set(),
    error: null,
    busy: false,
  });

  const applySession = useCallback((session: AuthSession) => {
    const permissions = new Set(
      session.permissions.length > 0
        ? session.permissions
        : Array.from(
            effectivePermissions({
              userId: String(session.user.id),
              orgId: String(session.organization.id),
              role: session.user.role,
              extraPermissions: session.user.extraPermissions,
              revokedPermissions: session.user.revokedPermissions,
            }),
          ),
    );

    setState({
      status: 'authenticated',
      user: {
        id: String(session.user.id),
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        role: String(session.user.role),
      },
      organization: { id: String(session.organization.id), name: session.organization.name },
      permissions,
      error: null,
      busy: false,
    });
  }, []);

  /** Revalidate a stored session on load. */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!hasSession()) {
        if (!cancelled) setState((s) => ({ ...s, status: 'anonymous' }));
        return;
      }

      try {
        // `/auth/me` is cheap and exercises the refresh path, so an expired
        // access token is renewed transparently before the first page query.
        const me = await api.get<{
          userId: string;
          orgId: string;
          role: string;
          projectIds: string[];
        }>('/auth/me');

        const [users, org] = await Promise.all([
          api
            .get<{
              items: Array<
                SessionUser & { extraPermissions: string[]; revokedPermissions: string[] }
              >;
            }>('/users', { pageSize: 1, search: '' })
            .catch(() => null),
          api.get<{ id: string; name: string }>('/admin/organization').catch(() => null),
        ]);

        if (cancelled) return;

        // The identity endpoint is deliberately minimal, so the display name is
        // filled in from the user record when the operator can read it, and
        // falls back to the email otherwise.
        const self = users?.items?.find((u) => u.id === me.userId) ?? null;

        setState({
          status: 'authenticated',
          user: {
            id: me.userId,
            email: self?.email ?? '',
            firstName: self?.firstName ?? 'Operator',
            lastName: self?.lastName ?? '',
            role: me.role,
          },
          organization: org
            ? { id: org.id, name: org.name }
            : { id: me.orgId, name: 'Organisation' },
          permissions: new Set(
            Array.from(
              effectivePermissions({
                userId: me.userId,
                orgId: me.orgId,
                role: me.role as never,
                extraPermissions: self?.extraPermissions ?? [],
                revokedPermissions: self?.revokedPermissions ?? [],
              }),
            ),
          ),
          error: null,
          busy: false,
        });
      } catch {
        if (cancelled) return;
        clearTokens();
        setState((s) => ({ ...s, status: 'anonymous', user: null, organization: null }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** A refresh failure anywhere in the app drops us back to the sign-in screen. */
  useEffect(
    () =>
      onAuthLost(() => {
        setState({
          status: 'anonymous',
          user: null,
          organization: null,
          permissions: new Set(),
          error: 'Your session expired. Sign in again.',
          busy: false,
        });
      }),
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        applySession(await apiLogin(email, password));
      } catch (err) {
        setState((s) => ({
          ...s,
          busy: false,
          error: err instanceof Error ? err.message : 'Could not sign in.',
        }));
        throw err;
      }
    },
    [applySession],
  );

  const signUp = useCallback(
    async (input: RegisterInput) => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        applySession(await apiRegister(input));
      } catch (err) {
        setState((s) => ({
          ...s,
          busy: false,
          error: err instanceof Error ? err.message : 'Could not create the account.',
        }));
        throw err;
      }
    },
    [applySession],
  );

  const signOut = useCallback(async () => {
    await apiLogout();
    setState({
      status: 'anonymous',
      user: null,
      organization: null,
      permissions: new Set(),
      error: null,
      busy: false,
    });
  }, []);

  const can = useCallback(
    (permission: Permission | string) => state.permissions.has(permission),
    [state.permissions],
  );

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, signIn, signUp, signOut, can }),
    [state, signIn, signUp, signOut, can],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}
