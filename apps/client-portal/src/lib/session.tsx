/**
 * Portal session.
 *
 * Simpler than the console's because a customer has one role and one scope:
 * there is no permission set to compute, no organisation switching, and
 * nothing that varies between two signed-in customers except which company
 * they belong to.
 *
 * The one piece of real logic is the door policy. This portal is for
 * customers, and a staff account signing in here has valid credentials for the
 * wrong product — the session is minted by the server, then discarded and
 * replaced with a message pointing at the console. Refusing here rather than
 * server-side is deliberate: the credentials genuinely are valid, so a 403
 * would be a lie, and the same account must keep working on the console a
 * moment later.
 */

import type { AuthSession } from '@orbit/types';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import {
  api,
  clearTokens,
  hasSession,
  login as apiLogin,
  logout as apiLogout,
  onAuthLost,
} from './api';
import { resolveTenant } from './tenant';

export interface Company {
  id: string;
  name: string;
  code: string | null;
  logoUrl: string | null;
  industry: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  contactName: string | null;
  contactDesignation: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  whatsapp: string | null;
  website: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  postalCode: string | null;
  isActive: boolean;
}

export interface PortalUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  avatarUrl: string | null;
}

interface SessionState {
  status: 'checking' | 'authenticated' | 'anonymous';
  user: PortalUser | null;
  company: Company | null;
  error: string | null;
  busy: boolean;
}

interface SessionContextValue extends SessionState {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setError: (message: string | null) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const STAFF_MESSAGE =
  'That account belongs to the operations console, not the client portal. Staff sign in at the console instead.';

/** Load the signed-in customer and their company in one pass. */
async function loadIdentity(): Promise<{ user: PortalUser; company: Company }> {
  const [profile, company] = await Promise.all([
    api.get<PortalUser>('/auth/profile'),
    api.get<Company>('/portal/company'),
  ]);
  return { user: profile, company };
}

export function SessionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = useState<SessionState>({
    status: 'checking',
    user: null,
    company: null,
    error: null,
    busy: false,
  });

  /** Revalidate a stored session on load. */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!hasSession()) {
        if (!cancelled) setState((s) => ({ ...s, status: 'anonymous' }));
        return;
      }
      try {
        const identity = await loadIdentity();
        if (cancelled) return;
        setState({ status: 'authenticated', ...identity, error: null, busy: false });
      } catch {
        if (cancelled) return;
        clearTokens();
        setState((s) => ({ ...s, status: 'anonymous', user: null, company: null }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** A refresh failure anywhere in the app drops back to the sign-in screen. */
  useEffect(
    () =>
      onAuthLost(() => {
        setState({
          status: 'anonymous',
          user: null,
          company: null,
          error: 'Your session expired. Sign in again.',
          busy: false,
        });
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      // Whose portal this is, from the address. The server rejects an account
      // belonging to any other company.
      const session: AuthSession = await apiLogin(email, password, resolveTenant() ?? undefined);

      if (String(session.user.role) !== 'CLIENT') {
        // Valid credentials, wrong product. Drop the session we just minted so
        // nothing is left signed in here.
        await apiLogout();
        setState((s) => ({ ...s, busy: false, error: STAFF_MESSAGE }));
        throw new Error(STAFF_MESSAGE);
      }

      const identity = await loadIdentity();
      setState({ status: 'authenticated', ...identity, error: null, busy: false });
    } catch (err) {
      setState((s) => ({
        ...s,
        busy: false,
        error: s.error ?? (err instanceof Error ? err.message : 'Could not sign in.'),
      }));
      throw err;
    }
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setState({ status: 'anonymous', user: null, company: null, error: null, busy: false });
  }, []);

  /** Re-read the profile after an edit, so the header reflects it immediately. */
  const refresh = useCallback(async () => {
    const identity = await loadIdentity();
    setState((s) => ({ ...s, ...identity }));
  }, []);

  const setError = useCallback((message: string | null) => {
    setState((s) => ({ ...s, error: message }));
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ ...state, signIn, signOut, refresh, setError }),
    [state, signIn, signOut, refresh, setError],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}
