/**
 * Request instrumentation.
 *
 * Records latency and outcome for every request, and emits one structured log
 * line per request with the correlation id already attached by `requestContext`.
 *
 * Health and metrics endpoints are excluded: a Kubernetes liveness probe every
 * two seconds would dominate both the log volume and the latency histogram,
 * hiding the traffic anyone actually cares about.
 */

import type { NextFunction, Request, Response } from 'express';
import { increment, observe, routeLabel } from '../modules/observability/metrics.js';

const EXCLUDED = /^\/(health|metrics)/;

export function observability(req: Request, res: Response, next: NextFunction): void {
  if (EXCLUDED.test(req.path)) return next();

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = routeLabel(req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path);
    const labels = { method: req.method, route, status: String(res.statusCode) };

    increment('orbit_http_requests_total', labels);
    observe('orbit_http_request_duration_seconds', seconds, { method: req.method, route });

    if (res.statusCode >= 400) {
      increment('orbit_http_errors_total', labels);
    }

    // One line per request. 5xx is already logged with a stack by the error
    // handler, so this stays at info and carries only the shape of the call.
    const level = res.statusCode >= 500 ? 'warn' : 'info';
    req.log[level](
      {
        method: req.method,
        path: req.path,
        route,
        status: res.statusCode,
        durationMs: Math.round(seconds * 1000),
        userId: req.auth?.userId,
        orgId: req.auth?.orgId,
      },
      'request',
    );
  });

  next();
}
