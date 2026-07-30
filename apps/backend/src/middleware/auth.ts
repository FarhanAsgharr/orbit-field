/**
 * Authentication and authorisation middleware.
 *
 * `requireAuth` establishes *who* is calling; `requirePermission` decides *what*
 * they may do. Both are deliberately separate so a route can never accidentally
 * be authenticated-but-unauthorised by omission — the permission is named
 * explicitly at every route definition.
 */

import { AppError, can, canAny, ErrorCode, type Permission } from '@orbit/shared';
import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../db/prisma.js';
import { verifyAccessToken } from '../lib/tokens.js';
import { auth as getAuth, clientIp } from './context.js';
import { asyncHandler } from './error.js';

function extractBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/**
 * Verify the access token and load the live account state.
 *
 * The token carries the role, but account status and device revocation are
 * checked against the database on every request. A 15-minute access token must
 * not keep a suspended user or a revoked (stolen) device working for the rest
 * of its lifetime.
 */
/**
 * Markers the OpenAPI generator reads.
 *
 * `requireAuth` is wrapped by `asyncHandler`, so it reaches Express as an
 * anonymous function and its name says nothing. Rather than have the generator
 * guess from paths — which would quietly go wrong the first time a route moved
 * — the middleware says what it is. Symbols, because this is metadata for one
 * reader; nothing branches on it at runtime and request handling is unchanged.
 */
export const AUTH_MARKER = Symbol.for('orbit.requiresAuth');
export const PERMISSION_MARKER = Symbol.for('orbit.requiresPermission');

export const requireAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearer(req);
    if (!token) {
      throw new AppError(ErrorCode.AUTH_REQUIRED, 'Authentication is required.');
    }

    const claims = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        orgId: true,
        role: true,
        status: true,
        deletedAt: true,
        extraPermissions: true,
        revokedPermissions: true,
        passwordChangedAt: true,
        // Carried on every request: it is the axis a client portal user is
        // scoped by, and a query that forgot to load it would silently widen
        // to the whole organisation.
        clientId: true,
        projectMemberships: { select: { projectId: true } },
        organization: { select: { isActive: true, deletedAt: true } },
      },
    });

    if (!user || user.deletedAt) {
      throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, 'This account no longer exists.');
    }
    if (!user.organization.isActive || user.organization.deletedAt) {
      throw new AppError(ErrorCode.ORG_MISMATCH, 'This organisation is no longer active.');
    }
    if (user.status === 'SUSPENDED') {
      throw new AppError(ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended.');
    }
    if (user.status === 'DEACTIVATED' || user.status === 'INVITED') {
      throw new AppError(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is not active.');
    }
    // The token asserts an org; the database is the authority. A mismatch means a
    // forged or stale token and must never be allowed to read another tenant.
    if (user.orgId !== claims.orgId) {
      throw new AppError(ErrorCode.ORG_MISMATCH, 'Token does not match this account.');
    }

    /*
     * A password change ends every session that predates it.
     *
     * Refresh tokens are revoked when the password changes, but an access token
     * is self-contained and stays valid for its full lifetime — so without this
     * check somebody who changes their password because they believe it is
     * compromised leaves the attacker holding a working token for up to another
     * fifteen minutes. Ending the attacker's session is the entire reason they
     * acted.
     *
     * `iat` has one-second resolution and is rounded down, so a token minted in
     * the same second as the change could compare equal; the strict comparison
     * keeps that token valid rather than rejecting a session the user has only
     * just legitimately established.
     */
    if (claims.iat !== undefined && user.passwordChangedAt) {
      const changedAt = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (claims.iat < changedAt) {
        throw new AppError(
          ErrorCode.AUTH_TOKEN_INVALID,
          'This session ended when the password was changed. Sign in again.',
        );
      }
    }

    if (claims.deviceId) {
      const device = await prisma.device.findUnique({
        where: { id: claims.deviceId },
        select: { id: true, userId: true, revokedAt: true, deletedAt: true },
      });
      if (!device || device.deletedAt || device.userId !== user.id) {
        throw new AppError(ErrorCode.DEVICE_NOT_ENROLLED, 'This device is not enrolled.');
      }
      if (device.revokedAt) {
        throw new AppError(ErrorCode.DEVICE_REVOKED, 'This device has been revoked.');
      }
      // Cheap liveness signal for the admin device list. Fire-and-forget: an
      // update failure must not fail the request.
      void prisma.device
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }

    req.auth = {
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      deviceId: claims.deviceId,
      sessionId: claims.sid,
      extraPermissions: user.extraPermissions,
      revokedPermissions: user.revokedPermissions,
      projectIds: user.projectMemberships.map((m) => m.projectId),
      clientId: user.clientId,
    };

    req.log = req.log.child({ userId: user.id, orgId: user.orgId });
    next();
  },
);

/** Attach auth when a token is present, but do not demand one. */
export const optionalAuth = asyncHandler(
  async (req: Request, res: Response, next: NextFunction) => {
    if (!extractBearer(req)) return next();
    return requireAuth(req, res, next);
  },
);

/** Gate a route on a single permission. */
Object.defineProperty(requireAuth, AUTH_MARKER, { value: true, enumerable: false });

export function requirePermission(permission: Permission) {
  const middleware = (req: Request, _res: Response, next: NextFunction): void => {
    const subject = getAuth(req);
    if (!can(subject, permission)) {
      req.log.warn({ permission, role: subject.role }, 'permission denied');
      // Recorded because a run of these is a meaningful security signal.
      void prisma.auditLog
        .create({
          data: {
            id: req.requestId,
            orgId: subject.orgId,
            userId: subject.userId,
            deviceId: subject.deviceId,
            action: 'PERMISSION_DENIED',
            metadata: { permission, path: req.path, method: req.method },
            ipAddress: clientIp(req),
            requestId: req.requestId,
          },
        })
        .catch(() => undefined);

      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to perform this action.',
      );
    }
    next();
  };

  // Which permission this route wants, so the API reference can say so rather
  // than leaving a reader to discover it by being refused.
  Object.defineProperty(middleware, PERMISSION_MARKER, {
    value: permission,
    enumerable: false,
  });
  return middleware;
}

/** Gate a route on holding at least one of several permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!canAny(getAuth(req), permissions)) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'You do not have permission to perform this action.',
      );
    }
    next();
  };
}

/**
 * Require the caller to be on an enrolled device.
 * Applied to sync and upload routes: those write field data, and org policy may
 * demand that only known hardware can do so.
 */
export const requireDevice = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const subject = getAuth(req);
    if (!subject.deviceId) {
      throw new AppError(ErrorCode.DEVICE_NOT_ENROLLED, 'This action requires an enrolled device.');
    }
    next();
  },
);
