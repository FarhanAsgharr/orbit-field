/**
 * API client.
 *
 * Same 401-refresh discipline as the mobile client: concurrent 401s share one
 * refresh promise, because the server treats a second use of a refresh token as
 * theft and burns the whole session family. Ten parallel table queries hitting
 * an expired token must produce exactly one rotation.
 *
 * Tokens live in memory plus sessionStorage rather than localStorage. An admin
 * console holds org-wide privileges; scoping the session to the tab means a
 * shared workstation does not leave a live session behind after the operator
 * closes it.
 */

import type { ApiError, AuthSession, AuthTokens, Paginated } from '@orbit/types';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

const ACCESS_KEY = 'orbit.admin.access';
const REFRESH_KEY = 'orbit.admin.refresh';
const DEVICE_KEY = 'orbit.admin.device';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: Record<string, string>;

  constructor(code: string, message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

let accessToken: string | null = sessionStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = sessionStorage.getItem(REFRESH_KEY);
let deviceId: string | null = sessionStorage.getItem(DEVICE_KEY);
let refreshInFlight: Promise<void> | null = null;

const authListeners = new Set<() => void>();

export function onAuthLost(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function setTokens(tokens: AuthTokens): void {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  sessionStorage.setItem(ACCESS_KEY, tokens.accessToken);
  sessionStorage.setItem(REFRESH_KEY, tokens.refreshToken);
}

export function setDeviceId(id: string): void {
  deviceId = id;
  sessionStorage.setItem(DEVICE_KEY, id);
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(DEVICE_KEY);
}

export function hasSession(): boolean {
  return refreshToken !== null;
}

export function currentDeviceId(): string | null {
  return deviceId;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    // Array filters go over the wire comma-separated, matching what the API's
    // `csvArray` schema parses.
    params.append(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

async function rawFetch(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!options.anonymous && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (!options.anonymous && deviceId) headers['X-Device-Id'] = deviceId;

  return fetch(`${BASE}${path}${buildQuery(options.query)}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
}

async function refreshSession(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;

  if (!refreshToken) {
    clearTokens();
    for (const listener of authListeners) listener();
    throw new ApiRequestError('AUTH_REQUIRED', 'Sign in to continue.', 401);
  }

  refreshInFlight = (async () => {
    try {
      const response = await rawFetch('/auth/refresh', {
        method: 'POST',
        anonymous: true,
        body: { refreshToken, deviceId: deviceId ?? undefined },
      });

      if (!response.ok) {
        clearTokens();
        for (const listener of authListeners) listener();
        throw new ApiRequestError(
          'AUTH_TOKEN_REVOKED',
          'Your session expired. Sign in again.',
          401,
        );
      }

      const body = (await response.json()) as { data: { tokens: AuthTokens } };
      setTokens(body.data.tokens);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await rawFetch(path, options);

  if (response.status === 401 && !options.anonymous) {
    await refreshSession();
    response = await rawFetch(path, options);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new ApiRequestError(
          'INTERNAL_ERROR',
          'The server returned an unexpected response.',
          response.status,
        );
      }
    }
  }

  if (response.ok) {
    const wrapped = payload as { data?: T } | null;
    return (
      wrapped && typeof wrapped === 'object' && 'data' in wrapped ? wrapped.data : payload
    ) as T;
  }

  const apiError = payload as ApiError | null;
  throw new ApiRequestError(
    apiError?.error?.code ?? 'INTERNAL_ERROR',
    apiError?.error?.message ?? 'The request failed.',
    response.status,
    apiError?.error?.fields,
  );
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
};

/**
 * Sign in.
 *
 * The console enrols as a device like any other client, so it appears in the
 * device list and can be revoked from there — an admin session on a shared
 * workstation is exactly the thing you want to be able to kill remotely.
 */
export async function login(email: string, password: string): Promise<AuthSession> {
  const session = await request<AuthSession>('/auth/login', {
    method: 'POST',
    anonymous: true,
    body: {
      email,
      password,
      device: {
        installationId: installationId(),
        name: browserLabel(),
        platform: 'web',
        osVersion: navigator.platform || 'unknown',
        appVersion: '1.0.0',
      },
    },
  });

  setTokens(session.tokens);
  setDeviceId(String(session.device.id));
  return session;
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationName: string;
}

/**
 * Create an organisation and its first administrator.
 *
 * The server registers and signs in atomically, returning a full session, so
 * the console never has to make a second call that could fail and leave the
 * user with an account they cannot reach.
 */
export async function register(input: RegisterInput): Promise<AuthSession> {
  const session = await request<AuthSession>('/auth/register', {
    method: 'POST',
    anonymous: true,
    body: {
      ...input,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      device: {
        installationId: installationId(),
        name: browserLabel(),
        platform: 'web',
        osVersion: navigator.platform || 'unknown',
        appVersion: '1.0.0',
      },
    },
  });

  setTokens(session.tokens);
  setDeviceId(String(session.device.id));
  return session;
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } catch {
    // A failed server-side revocation must not block the local sign-out.
  }
  clearTokens();
}

/** Stable per-browser id so repeated sign-ins reuse one device record. */
function installationId(): string {
  const KEY = 'orbit.admin.installation';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${browser} — Operations console`;
}

export type { Paginated };
