/**
 * Request context: correlation id and the authenticated subject.
 *
 * Typed as a module augmentation rather than casts at every call site, so
 * `req.auth` is either present and fully typed, or a compile error.
 */

import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@orbit/types';
import type { AccessSubject } from '@orbit/shared';
import { ulid } from '@orbit/utils';
import { requestLogger, type Logger } from '../config/logger.js';

export interface AuthContext extends AccessSubject {
  userId: string;
  orgId: string;
  role: Role;
  deviceId: string | null;
  sessionId: string;
  extraPermissions: string[];
  revokedPermissions: string[];
  projectIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
      auth?: AuthContext;
      /** Populated by the validation middleware. */
      validated?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

/** Assign or propagate a correlation id and attach a bound logger. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  // Trusting a client-supplied id wholesale lets a caller poison log queries,
  // so accept it only when it looks like an id we would have generated.
  req.requestId = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : ulid();
  req.log = requestLogger(req.requestId);
  res.setHeader('x-request-id', req.requestId);
  next();
}

/** Narrowing helper for handlers that run behind `requireAuth`. */
export function auth(req: Request): AuthContext {
  if (!req.auth) {
    // Unreachable when routes are wired correctly; throwing beats a silent
    // undefined that would turn into a cross-tenant data leak.
    throw new Error('auth() called on an unauthenticated request');
  }
  return req.auth;
}

/** Client IP, honouring the proxy chain only when the app is told to trust it. */
export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  return ip ? ip.replace(/^::ffff:/, '') : null;
}
