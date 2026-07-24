/**
 * Retry scheduling for the sync engine.
 *
 * A fleet of devices that all lost connectivity in the same tunnel will all
 * regain it in the same second. Without jitter they would hit the API as a
 * synchronised thundering herd, which is how an outage turns into a longer
 * outage. Full jitter (AWS's recommendation) spreads them out.
 */

export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Growth factor per attempt. */
  factor: number;
  /** Attempts after which an operation is moved to the dead-letter state. */
  maxAttempts: number;
  jitter: 'NONE' | 'FULL' | 'EQUAL';
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60_000,
  factor: 2,
  // 12 attempts under these settings spans roughly 40 minutes of real time,
  // long enough to ride out a deploy but short enough that a genuinely broken
  // operation surfaces to the user the same working day.
  maxAttempts: 12,
  jitter: 'FULL',
};

/** Media uploads retry longer: a 40 MB video over 2G is legitimately slow. */
export const MEDIA_BACKOFF: BackoffConfig = {
  baseDelayMs: 5_000,
  maxDelayMs: 15 * 60_000,
  factor: 2,
  maxAttempts: 25,
  jitter: 'FULL',
};

/**
 * Delay before attempt number `attempt` (1-based).
 * `random` is injected so tests are deterministic.
 */
export function backoffDelay(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const uncapped = config.baseDelayMs * Math.pow(config.factor, exponent);
  const capped = Math.min(config.maxDelayMs, uncapped);

  switch (config.jitter) {
    case 'NONE':
      return Math.round(capped);
    case 'EQUAL':
      return Math.round(capped / 2 + random() * (capped / 2));
    case 'FULL':
    default:
      return Math.round(random() * capped);
  }
}

/** HTTP status codes worth retrying. Everything else is a client-side defect. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 522, 524]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Error codes the API returns that the client should retry rather than surface. */
const RETRYABLE_CODES = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'DB_UNAVAILABLE',
  'LOCK_TIMEOUT',
  'SYNC_BATCH_ABORTED',
]);

export function isRetryableCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && RETRYABLE_CODES.has(code);
}

export function shouldRetry(
  attempt: number,
  config: BackoffConfig,
  status?: number,
  code?: string | null,
): boolean {
  if (attempt >= config.maxAttempts) return false;
  if (status !== undefined && !isRetryableStatus(status)) {
    // A 409 conflict is not retryable as-is — it needs resolution first — but it
    // is also not a dead letter. The caller handles that state separately.
    return false;
  }
  if (code !== undefined && code !== null && !isRetryableCode(code) && status === undefined) {
    return false;
  }
  return true;
}

/** Honour a server-provided `Retry-After`, in preference to local backoff. */
export function retryAfterMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Wrap a promise with a timeout that rejects rather than hanging forever. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
