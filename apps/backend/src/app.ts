/** Express application assembly. */

import { ErrorCode } from '@orbit/shared';
import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { corsOrigins, env } from './config/env.js';
import { databaseHealthy } from './db/prisma.js';
import { redisHealthy } from './db/redis.js';
import { requestContext } from './middleware/context.js';
import { asyncHandler, errorHandler, notFoundHandler } from './middleware/error.js';
import { observability } from './middleware/observability.js';
import { globalLimiter, syncLimiter, uploadLimiter } from './middleware/rate-limit.js';
import {
  extraSecurityHeaders,
  originGuard,
  requestSanity,
  requireJsonBody,
} from './middleware/security.js';
import { adminRouter } from './modules/admin/audit.routes.js';
import {
  assetsRouter,
  clientsRouter,
  projectsRouter,
  sitesRouter,
} from './modules/admin/reference.routes.js';
import { usersRouter } from './modules/admin/users.routes.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { portalRouter } from './modules/client-portal/portal.routes.js';
import { inspectionRequestsRouter } from './modules/client-portal/requests.routes.js';
import { devicesRouter } from './modules/devices/devices.routes.js';
import { inspectionsRouter } from './modules/inspections/inspections.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { collectMetrics } from './modules/observability/metrics.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { syncRouter } from './modules/sync/sync.routes.js';
import { templatesRouter } from './modules/templates/templates.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';

export function createApp(): Express {
  const app = express();

  // Required for correct client IPs (and therefore correct rate limiting)
  // behind a load balancer. Off by default: trusting X-Forwarded-For when you
  // are not actually behind a proxy lets any caller spoof their IP.
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /**
   * BigInt serialisation.
   *
   * Postgres `bigint` columns (sync cursors, org sequences) arrive as JS
   * BigInt, which `JSON.stringify` throws on — so without this every response
   * carrying a syncable row is a 500. Cursors are emitted as `number` because
   * that is what the sync protocol declares (`SyncCursor = Brand<number>`), and
   * they are bounded by the org's mutation count, which will not approach
   * 2^53 in any realistic deployment.
   */
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? Number(value) : value,
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Device-Id'],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit-Remaining'],
      maxAge: 86_400,
    }),
  );

  app.use(extraSecurityHeaders);
  app.use(requestSanity);
  app.use(compression());
  app.use(requestContext);
  app.use(observability);

  // A sync push carrying 500 operations with inline patches is legitimately
  // large; binary uploads never come through here, they go to the chunked
  // upload endpoint with its own ceiling.
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // Applied after body parsing so a rejection still produces a JSON error,
  // and before any router so no handler sees an unvetted cross-origin write.
  app.use(originGuard);
  app.use(requireJsonBody);

  // --- health, deliberately unauthenticated and unlimited ------------------
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'orbit-backend',
      version: process.env.npm_package_version ?? '1.0.0',
    });
  });

  /** Readiness: reports whether dependencies are actually usable. */
  // Wrapped: Express does not await a handler, so a rejection here would be an
  // unhandled promise rejection rather than a 500 — the process-level failure
  // mode this project already has `asyncHandler` to prevent.
  app.get(
    '/health/ready',
    asyncHandler(async (_req, res) => {
      const [db, cache] = await Promise.all([databaseHealthy(), redisHealthy()]);
      // Redis being down is degraded, not unready — the API still serves.
      const ready = db;
      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'unavailable',
        checks: { database: db ? 'up' : 'down', redis: cache ? 'up' : 'down' },
      });
    }),
  );

  /**
   * Prometheus scrape endpoint.
   *
   * Unauthenticated but bound to the internal network in deployment — the
   * scrape carries no inspection data, only counters, and requiring a token
   * here means every Prometheus install needs credential rotation for no gain.
   */
  app.get(
    '/metrics',
    asyncHandler(async (_req, res) => {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(await collectMetrics());
    }),
  );

  /** Liveness: is the process itself wedged? Never touches a dependency. */
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'alive', uptime: Math.floor(process.uptime()) });
  });

  // --- API -----------------------------------------------------------------
  const api = express.Router();

  api.use('/auth', authRouter);
  api.use('/sync', syncLimiter, syncRouter);
  api.use('/devices', devicesRouter);
  api.use('/inspections', inspectionsRouter);
  api.use('/uploads', uploadLimiter, uploadsRouter);
  api.use('/templates', templatesRouter);
  api.use('/users', usersRouter);
  api.use('/clients', clientsRouter);
  api.use('/projects', projectsRouter);
  api.use('/sites', sitesRouter);
  api.use('/assets', assetsRouter);
  api.use('/analytics', analyticsRouter);
  api.use('/reports', reportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/inspection-requests', inspectionRequestsRouter);
  api.use('/portal', portalRouter);
  api.use('/admin', adminRouter);

  app.use(env.API_PREFIX, globalLimiter, api);

  // Root gives a discoverable pointer rather than a bare 404.
  app.get('/', (_req, res) => {
    res.json({
      service: 'Orbit Field API',
      version: '1.0.0',
      documentation: '/docs',
      health: '/health',
      api: env.API_PREFIX,
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export { ErrorCode };
