/**
 * Error reporting.
 *
 * Inert unless `SENTRY_DSN` is set. That is deliberate: this project is
 * self-hostable, and a deployment that does not want a third party receiving
 * its stack traces should get that by doing nothing, not by remembering to
 * switch something off.
 *
 * What is sent is deliberately narrow. Inspection records are compliance data
 * belonging to somebody else's business, so request bodies, headers and query
 * strings are all stripped before an event leaves the process — a stack trace
 * is useful, a stack trace with an inspector's location and a client's site
 * address in it is a data-protection incident.
 */

import * as Sentry from '@sentry/node';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

let initialised = false;

export function initSentry(): boolean {
  if (initialised) return true;
  if (!env.SENTRY_DSN) {
    logger.debug('SENTRY_DSN not set — error reporting is off');
    return false;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    // A serverless instance handles few requests, so a low sample rate reports
    // almost nothing. Errors are always captured; this governs traces only.
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,

    // Off: it attaches request bodies and headers to events by default, and a
    // sync push body contains an entire inspection.
    sendDefaultPii: false,

    beforeSend(event) {
      // Belt and braces over sendDefaultPii — the SDK's idea of PII and a
      // compliance auditor's are not the same, so the payload is removed here
      // regardless of what the SDK decided.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.query_string;
        if (event.request.headers) {
          const { authorization: _a, cookie: _c, ...safe } = event.request.headers;
          event.request.headers = safe;
        }
      }
      return event;
    },
  });

  initialised = true;
  logger.info({ environment: env.NODE_ENV }, 'sentry initialised');
  return true;
}

/**
 * Report an error that has already been handled.
 *
 * The error middleware still returns its JSON response; this only ensures the
 * event reaches the tracker. Calling it when Sentry is off is a no-op, so
 * callers never need to check.
 */
export function captureError(
  error: unknown,
  context: { requestId?: string; userId?: string; orgId?: string; route?: string } = {},
): void {
  if (!initialised) return;

  Sentry.withScope((scope) => {
    // Ids, never contents: enough to correlate with a log line, nothing that
    // identifies a person or reveals what they were inspecting.
    if (context.requestId) scope.setTag('request_id', context.requestId);
    if (context.route) scope.setTag('route', context.route);
    if (context.orgId) scope.setTag('org_id', context.orgId);
    if (context.userId) scope.setUser({ id: context.userId });
    Sentry.captureException(error);
  });
}

/** Flush pending events. A frozen serverless instance sends nothing otherwise. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialised) return;
  await Sentry.flush(timeoutMs).catch(() => undefined);
}

export function sentryEnabled(): boolean {
  return initialised;
}
