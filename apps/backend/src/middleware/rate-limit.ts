/**
 * Rate limiting.
 *
 * Redis-backed so limits hold across every API replica; falls back to
 * per-process memory when Redis is unavailable, because a degraded limiter is
 * better than a hard failure that stops field devices syncing entirely.
 */

import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { Request } from 'express';
import { ErrorCode } from '@orbit/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { redis } from '../db/redis.js';

function store(prefix: string): Options['store'] | undefined {
  try {
    return new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
    });
  } catch (err) {
    logger.warn({ err }, 'redis rate-limit store unavailable; using in-memory limiter');
    return undefined;
  }
}

/** Key by authenticated user when known, else by IP. */
function keyFor(req: Request): string {
  return req.auth?.userId ?? req.ip ?? 'unknown';
}

function build(name: string, windowSeconds: number, max: number, byUser = true) {
  return rateLimit({
    windowMs: windowSeconds * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: store(name),
    keyGenerator: byUser ? keyFor : (req) => req.ip ?? 'unknown',
    handler: (req, res) => {
      const retryAfter = Math.ceil(windowSeconds);
      res.setHeader('Retry-After', String(retryAfter));
      req.log?.warn({ limiter: name, key: keyFor(req) }, 'rate limit exceeded');
      res.status(429).json({
        error: {
          code: ErrorCode.RATE_LIMITED,
          message: 'Too many requests. Please slow down and try again shortly.',
          requestId: req.requestId,
          retryAfter,
        },
      });
    },
  });
}

/** Broad limiter applied to the whole API. */
export const globalLimiter = build('global', env.RATE_LIMIT_WINDOW_SECONDS, env.RATE_LIMIT_MAX_REQUESTS);

/**
 * Login and reset endpoints, keyed by IP.
 * Deliberately tight: this is the credential-stuffing surface.
 */
export const authLimiter = build('auth', 300, env.AUTH_RATE_LIMIT_MAX, false);

/** OTP issuance — the expensive, abusable path (email/SMS cost). */
export const otpLimiter = build('otp', 900, 5, false);

/**
 * Sync is generous by design. A device returning from a week offline
 * legitimately makes many rapid calls to drain its queue, and throttling that
 * would be indistinguishable from the outage it is recovering from.
 */
export const syncLimiter = build('sync', 60, 120);

/** Uploads: chunked, so a single large file is many requests. */
export const uploadLimiter = build('upload', 60, 300);
