/**
 * API client for the Client Portal.
 *
 * Deliberately a separate file from the console's, not a shared package. The
 * two apps talk to the same server but are different products with different
 * sessions, and sharing the client would mean sharing the storage keys — a
 * customer and an operator using the same browser would then evict each
 * other's session on every sign-in. The keys below are namespaced `orbit.portal`
 * for exactly that reason.
 *
 * The 401-refresh discipline matches the console's, and matters for the same
 * reason: the server treats a second use of a refresh token as theft and burns
 * the whole session family, so concurrent 401s must share one rotation.
 */

import type { ApiError, AuthSession, AuthTokens } from '@orbit/types';

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api/v1';

const ACCESS_KEY = 'orbit.portal.access';
const REFRESH_KEY = 'orbit.portal.refresh';
const DEVICE_KEY = 'orbit.portal.device';

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

/*
 * localStorage, not sessionStorage.
 *
 * The console scopes its session to the tab because an operator holds org-wide
 * privileges and often works on a shared machine. A customer is the opposite
 * case: one person, their own laptop, checking on a job every few days. Making
 * them retype a password every time they open a tab is friction with no
 * security gain, because the session reaches only their own company's records.
 */
let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);
let deviceId: string | null = localStorage.getItem(DEVICE_KEY);
let refreshInFlight: Promise<void> | null = null;

const authListeners = new Set<() => void>();

export function onAuthLost(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function setTokens(tokens: AuthTokens): void {
  accessToken = tokens.accessToken;
  refreshToken = tokens.refreshToken;
  localStorage.setItem(ACCESS_KEY, tokens.accessToken);
  localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(DEVICE_KEY);
}

export function hasSession(): boolean {
  return refreshToken !== null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  anonymous?: boolean;
  signal?: AbortSignal;
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
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

/**
 * Fetch a binary body — a report PDF, an attachment.
 *
 * `request` parses JSON so it cannot be used for these, and a plain link cannot
 * either: the API is on another origin and needs a bearer token, which a
 * browser will not attach to an `<a href>`. The caller turns the blob into an
 * object URL.
 */
export async function blob(path: string): Promise<Blob> {
  let response = await rawFetch(path, { method: 'GET' });

  if (response.status === 401) {
    await refreshSession();
    response = await rawFetch(path, { method: 'GET' });
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiRequestError(
      detail?.error?.code ?? 'DOWNLOAD_FAILED',
      detail?.error?.message ?? 'That file could not be downloaded.',
      response.status,
    );
  }

  return response.blob();
}

/** Upload raw bytes to a chunked upload session. */
export async function putBytes(path: string, bytes: Blob): Promise<void> {
  const send = (): Promise<Response> =>
    fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
        'Content-Type': 'application/octet-stream',
      },
      body: bytes,
    });

  let response = await send();
  if (response.status === 401) {
    await refreshSession();
    response = await send();
  }
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiRequestError(
      detail?.error?.code ?? 'UPLOAD_FAILED',
      detail?.error?.message ?? 'The upload failed.',
      response.status,
    );
  }
}

export const api = {
  blob,
  putBytes,
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
};

function installationId(): string {
  const KEY = 'orbit.portal.installation';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `portal-${crypto.randomUUID()}`;
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
  return `${browser} — Client portal`;
}

const device = () => ({
  installationId: installationId(),
  name: browserLabel(),
  platform: 'web' as const,
  osVersion: navigator.platform || 'unknown',
  appVersion: '1.0.0',
});

/**
 * Sign in.
 *
 * A staff account signing in here is refused by the caller, not by the server:
 * the credentials are genuinely valid, they just belong on the console. The
 * session is discarded rather than kept, so a mistaken sign-in leaves nothing
 * behind.
 */
export async function login(email: string, password: string): Promise<AuthSession> {
  const session = await request<AuthSession>('/auth/login', {
    method: 'POST',
    anonymous: true,
    body: { email, password, device: device() },
  });

  setTokens(session.tokens);
  deviceId = String(session.device.id);
  localStorage.setItem(DEVICE_KEY, deviceId);
  return session;
}

export interface ClientRegistrationInput {
  /** The company being registered with. Required when the portal serves several. */
  organizationSlug?: string;
  companyName: string;
  industry?: string;
  registrationNumber?: string;
  taxNumber?: string;
  contactName: string;
  contactDesignation?: string;
  email: string;
  contactPhone: string;
  whatsapp?: string;
  country: string;
  state: string;
  city: string;
  address: string;
  postalCode?: string;
  website?: string;
  notes?: string;
  password: string;
}

export async function registerClient(input: ClientRegistrationInput): Promise<void> {
  // Empty optional fields are dropped rather than sent as "": the server
  // validates them as strings when present, and an empty website is not a
  // website.
  const body = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== '' && value !== undefined),
  );
  await request('/portal/register', { method: 'POST', anonymous: true, body });
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } catch {
    // A failed server-side revocation must not block the local sign-out.
  }
  clearTokens();
}
