/**
 * Session state.
 *
 * The critical requirement: **a cold start with no network must reach a usable
 * app.** An inspector opening the phone in a basement at 6am cannot be shown a
 * login screen because the server was unreachable. So the session is restored
 * from local storage first and only revalidated against the server
 * opportunistically, in the background, and a revalidation failure that is
 * merely a network failure never signs anyone out.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import type { AuthSession, DeviceInfo, SyncStatus } from '@orbit/types';
import { create } from 'zustand';

import { ApiClient } from '../api/client';
import { getDatabase } from '../db/database';
import { META_KEYS } from '../db/schema';
import { getNetworkState } from '../lib/network';
import { kv, secureStorage, storage } from '../lib/storage';
import { buildRuntime, resolveApiUrl, type Runtime, tokenStore } from '../runtime/runtime';

const SESSION_CACHE_KEY = 'session.cache';

/** The subset of the session worth caching locally for offline start-up. */
interface CachedSession {
  user: AuthSession['user'];
  organization: AuthSession['organization'];
  permissions: string[];
  deviceId: string;
  cachedAt: string;
}

export type SessionPhase =
  /** Deciding whether a cached session exists. Splash is showing. */
  | 'BOOTING'
  | 'AUTHENTICATED'
  | 'UNAUTHENTICATED'
  /** Signed in from cache, but the server has not confirmed it yet. */
  | 'AUTHENTICATED_UNVERIFIED';

interface SessionState {
  phase: SessionPhase;
  session: CachedSession | null;
  runtime: Runtime | null;
  syncStatus: SyncStatus | null;
  error: string | null;
  busy: boolean;

  boot: () => Promise<void>;
  login: (input: {
    email: string;
    password: string;
    device: DeviceInfo;
    rememberMe: boolean;
  }) => Promise<void>;
  logout: (options?: { keepLocalData?: boolean }) => Promise<void>;
  setSyncStatus: (status: SyncStatus) => void;
  hasPermission: (permission: string) => boolean;
}

/**
 * A client that exists before login, purely to call the auth endpoints.
 *
 * Shares `resolveApiUrl` with the signed-in runtime rather than reading the
 * config again. Two readers meant two fallbacks, and this one sat on the
 * sign-in path: a build with no URL configured would have pointed the login
 * request at localhost and failed with a network timeout, which is
 * indistinguishable from the backend being down.
 */
function anonymousClient(): ApiClient {
  return new ApiClient({
    baseUrl: resolveApiUrl(),
    tokens: tokenStore,
    onAuthFailure: () => undefined,
    isOnline: () => getNetworkState().isConnected,
  });
}

export const useSession = create<SessionState>((set, get) => ({
  phase: 'BOOTING',
  session: null,
  runtime: null,
  syncStatus: null,
  error: null,
  busy: false,

  /**
   * Restore a session on app start.
   *
   * Local-first: if we hold a refresh token and a cached profile, the user is
   * in. Server confirmation happens afterwards and only ever downgrades the
   * session on an explicit rejection, never on a timeout.
   */
  async boot(): Promise<void> {
    set({ phase: 'BOOTING', error: null });

    try {
      const db = await getDatabase();
      await tokenStore.hydrate();

      const refreshToken = tokenStore.getRefreshToken();
      const cached = kv.getJson<CachedSession | null>(SESSION_CACHE_KEY, null);
      const deviceId = db.getMeta(META_KEYS.DEVICE_ID);

      if (!refreshToken || !cached || !deviceId) {
        set({ phase: 'UNAUTHENTICATED', session: null, runtime: null });
        return;
      }

      const runtime = await buildRuntime({
        session: {
          user: cached.user,
          organization: cached.organization,
          permissions: cached.permissions,
          device: { id: deviceId },
        },
        getNetwork: getNetworkState,
        onAuthFailure: () => {
          void get().logout();
        },
        onStatusChange: (status) => set({ syncStatus: status }),
      });

      // Signed in from cache. The app is fully usable from this point, network
      // or not — every screen reads local SQLite.
      set({
        phase: 'AUTHENTICATED_UNVERIFIED',
        session: cached,
        runtime,
        error: null,
      });

      // Opportunistic confirmation. Deliberately not awaited.
      void (async () => {
        if (!getNetworkState().isConnected) return;
        try {
          await runtime.api.get('/auth/me');
          set({ phase: 'AUTHENTICATED' });
          void runtime.engine.sync('STARTUP');
        } catch (err) {
          // Only a definitive rejection signs the user out. A network failure
          // means we simply stay unverified and keep working offline.
          const isRejection =
            err instanceof AppError &&
            [
              ErrorCode.AUTH_TOKEN_REVOKED,
              ErrorCode.AUTH_TOKEN_INVALID,
              ErrorCode.ACCOUNT_DEACTIVATED,
              ErrorCode.ACCOUNT_SUSPENDED,
              ErrorCode.DEVICE_REVOKED,
            ].includes(err.code as never);

          if (isRejection) {
            await get().logout();
          }
        }
      })();
    } catch (err) {
      // A failure here is a local one — corrupt database, unreadable keychain.
      // Falling back to the login screen is the only safe recovery.
      set({
        phase: 'UNAUTHENTICATED',
        session: null,
        runtime: null,
        error: err instanceof Error ? err.message : 'Could not restore your session.',
      });
    }
  },

  async login(input): Promise<void> {
    set({ busy: true, error: null });

    try {
      const api = anonymousClient();
      const session = await api.post<AuthSession>(
        '/auth/login',
        {
          email: input.email.trim().toLowerCase(),
          password: input.password,
          device: input.device,
          rememberMe: input.rememberMe,
        },
        { anonymous: true },
      );

      tokenStore.setTokens(session.tokens);
      tokenStore.setDeviceId(session.device.id);

      const cached: CachedSession = {
        user: session.user,
        organization: session.organization,
        permissions: session.permissions,
        deviceId: String(session.device.id),
        cachedAt: new Date().toISOString(),
      };
      kv.setJson(SESSION_CACHE_KEY, cached);
      void secureStorage.set(secureStorage.keys.LAST_EMAIL, input.email.trim().toLowerCase());

      const runtime = await buildRuntime({
        session: {
          user: session.user,
          organization: session.organization,
          permissions: session.permissions,
          device: { id: String(session.device.id) },
        },
        getNetwork: getNetworkState,
        onAuthFailure: () => {
          void get().logout();
        },
        onStatusChange: (status) => set({ syncStatus: status }),
      });

      set({ phase: 'AUTHENTICATED', session: cached, runtime, busy: false, error: null });

      // First sync pulls the templates and reference data the app needs before
      // an inspection can be started at all.
      void runtime.engine.sync('STARTUP');
    } catch (err) {
      set({
        busy: false,
        error:
          err instanceof AppError
            ? err.message
            : 'Could not sign in. Check your connection and try again.',
      });
      throw err;
    }
  },

  /**
   * Sign out.
   *
   * Local inspection data is kept by default. Wiping it would destroy unsent
   * work if someone signs out to hand the device to a colleague, and the
   * database is encrypted at rest anyway.
   */
  async logout(options): Promise<void> {
    const { runtime } = get();

    // Best-effort server-side revocation; a failure must not block sign-out.
    try {
      if (runtime && getNetworkState().isConnected) {
        await runtime.api.post('/auth/logout');
      }
    } catch {
      // Ignored deliberately.
    }

    runtime?.dispose();
    tokenStore.clear();
    kv.remove(SESSION_CACHE_KEY);

    if (options?.keepLocalData === false) {
      const db = await getDatabase();
      db.resetForFullResync();
      runtime?.outbox.clear();
    }

    set({ phase: 'UNAUTHENTICATED', session: null, runtime: null, syncStatus: null });
  },

  setSyncStatus(status): void {
    set({ syncStatus: status });
  },

  hasPermission(permission): boolean {
    return get().session?.permissions.includes(permission) ?? false;
  },
}));

/** Narrow selector so screens re-render only when the runtime actually changes. */
export function useRuntime(): Runtime {
  const runtime = useSession((s) => s.runtime);
  if (!runtime) {
    throw new Error('useRuntime called outside an authenticated route');
  }
  return runtime;
}

export { storage };
