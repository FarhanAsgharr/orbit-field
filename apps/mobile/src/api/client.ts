/**
 * HTTP client.
 *
 * Three behaviours the rest of the app depends on:
 *
 *  1. **A 401 refreshes once, transparently.** Concurrent 401s share a single
 *     refresh promise — otherwise ten queued requests each rotate the refresh
 *     token, and rotation-with-reuse-detection revokes the whole family and
 *     logs the inspector out mid-inspection.
 *  2. **Offline is a typed error, not an exception to guess at.** Callers
 *     branch on `ErrorCode.OFFLINE`, and the sync engine treats it as retryable
 *     rather than as a rejection.
 *  3. **Nothing here retries automatically.** Retry policy belongs to the sync
 *     engine, which owns the backoff state and the durable queue. A client-level
 *     retry would double up with it.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import { retryAfterMs, withTimeout } from '@orbit/utils';
import type { ApiError, AuthTokens } from '@orbit/types';

export interface TokenStore {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  getDeviceId(): string | null;
  setTokens(tokens: AuthTokens): void;
  clear(): void;
}

export interface ClientOptions {
  baseUrl: string;
  tokens: TokenStore;
  /** Called when refresh fails terminally — the app must return to login. */
  onAuthFailure: () => void;
  /** Injected so tests need no network and the engine can share connectivity. */
  isOnline: () => boolean;
  defaultTimeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Skip the Authorization header — used by login and refresh themselves. */
  anonymous?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Large sync payloads need longer than an interactive request. */
  idempotencyKey?: string;
}

function buildQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

export class ApiClient {
  private refreshPromise: Promise<void> | null = null;

  constructor(private readonly options: ClientOptions) {}

  private get timeout(): number {
    return this.options.defaultTimeoutMs ?? 30_000;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!this.options.isOnline()) {
      throw new AppError(ErrorCode.OFFLINE, 'No network connection.', { status: 0 });
    }

    const response = await this.send(path, options);

    // A 401 on an anonymous request is a genuine credential failure, not an
    // expired token — refreshing would be nonsense.
    if (response.status === 401 && !options.anonymous) {
      await this.refreshTokens();
      const retried = await this.send(path, options);
      return this.parse<T>(retried);
    }

    return this.parse<T>(response);
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const url = `${this.options.baseUrl}${path}${buildQuery(options.query)}`;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    if (!options.anonymous) {
      const token = this.options.tokens.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
      const deviceId = this.options.tokens.getDeviceId();
      if (deviceId) headers['X-Device-Id'] = deviceId;
    }

    try {
      return await withTimeout(
        fetch(url, {
          method: options.method ?? 'GET',
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: options.signal,
        }),
        options.timeoutMs ?? this.timeout,
        'The request timed out.',
      );
    } catch (err) {
      if (options.signal?.aborted) {
        throw new AppError(ErrorCode.TIMEOUT, 'The request was cancelled.', { status: 0 });
      }
      // fetch rejects for DNS failure, connection refused, and TLS problems —
      // all indistinguishable from "offline" to a field device, and all
      // retryable.
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(
        message.includes('timed out') ? ErrorCode.TIMEOUT : ErrorCode.NETWORK_ERROR,
        message.includes('timed out') ? 'The request timed out.' : 'Could not reach the server.',
        { status: 0, cause: err },
      );
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        // A non-JSON body from a 5xx is usually a proxy error page. Surfacing
        // the raw HTML to the user is worse than a generic message.
        if (!response.ok) {
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            'The server returned an unexpected response.',
            { status: response.status },
          );
        }
      }
    }

    if (response.ok) {
      // The API wraps successful payloads in `{ data }`, except for sync
      // endpoints which return their envelope directly.
      const wrapped = payload as { data?: T } | null;
      return (wrapped && typeof wrapped === 'object' && 'data' in wrapped
        ? wrapped.data
        : payload) as T;
    }

    const apiError = payload as ApiError | null;
    const code = apiError?.error?.code ?? ErrorCode.INTERNAL_ERROR;
    const message = apiError?.error?.message ?? 'The request failed.';

    throw new AppError(code, message, {
      status: response.status,
      fields: apiError?.error?.fields,
      retryAfter:
        apiError?.error?.retryAfter ??
        (retryAfterMs(response.headers.get('retry-after')) ?? undefined) !== undefined
          ? Math.ceil((retryAfterMs(response.headers.get('retry-after')) ?? 0) / 1000)
          : undefined,
    });
  }

  /**
   * Rotate the refresh token.
   *
   * Deduplicated: every concurrent caller awaits the same promise. Ten parallel
   * requests hitting 401 must produce exactly one rotation, because the server
   * treats a second use of the same refresh token as theft and revokes the
   * session family.
   */
  private async refreshTokens(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    const refreshToken = this.options.tokens.getRefreshToken();
    if (!refreshToken) {
      this.options.tokens.clear();
      this.options.onAuthFailure();
      throw new AppError(ErrorCode.AUTH_REQUIRED, 'Please sign in again.');
    }

    this.refreshPromise = (async () => {
      try {
        const response = await this.send('/auth/refresh', {
          method: 'POST',
          anonymous: true,
          body: { refreshToken, deviceId: this.options.tokens.getDeviceId() ?? undefined },
        });

        if (!response.ok) {
          this.options.tokens.clear();
          this.options.onAuthFailure();
          throw new AppError(ErrorCode.AUTH_TOKEN_REVOKED, 'Your session has expired. Please sign in again.');
        }

        const body = (await response.json()) as { data: { tokens: AuthTokens } };
        this.options.tokens.setTokens(body.data.tokens);
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Raw binary PUT for chunked uploads.
   *
   * Bypasses the JSON envelope: chunks are octet-streams, and buffering them
   * through `JSON.stringify` would triple peak memory on a 40 MB video.
   */
  async putBinary(
    url: string,
    body: Blob | ArrayBuffer | Uint8Array,
    options: { contentType?: string; signal?: AbortSignal; absolute?: boolean; timeoutMs?: number } = {},
  ): Promise<Response> {
    const target = options.absolute ? url : `${this.options.baseUrl}${url}`;
    const headers: Record<string, string> = {
      'Content-Type': options.contentType ?? 'application/octet-stream',
    };
    if (!options.absolute) {
      const token = this.options.tokens.getAccessToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    return withTimeout(
      fetch(target, { method: 'PUT', headers, body: body as BodyInit, signal: options.signal }),
      // Chunk uploads over a poor link legitimately take minutes.
      options.timeoutMs ?? 120_000,
      'The upload timed out.',
    );
  }
}
