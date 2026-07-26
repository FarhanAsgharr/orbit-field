/**
 * JWT issuance and refresh-token rotation.
 *
 * The refresh flow implements rotation with reuse detection: every refresh
 * invalidates the presented token and issues a successor in the same "family".
 * If a token that has already been used is presented again, the only two
 * explanations are a stolen token or a cloned device — either way the entire
 * family is revoked immediately and the user is forced to re-authenticate.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import type { Role } from '@orbit/types';
import { ulid } from '@orbit/utils';
import jwt, { type SignOptions } from 'jsonwebtoken';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../db/prisma.js';
import { randomToken, sha256 } from './crypto.js';

export interface AccessTokenClaims {
  sub: string;
  orgId: string;
  role: Role;
  deviceId: string | null;
  /** Session/family id, so a token can be traced back to its login. */
  sid: string;
  /** Permission overrides folded into the token to avoid a per-request lookup. */
  xp?: string[];
  rp?: string[];
  type: 'access';
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  familyId: string;
}

export function signAccessToken(claims: Omit<AccessTokenClaims, 'type'>): string {
  const options: SignOptions = {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: 'HS256',
    jwtid: ulid(),
  };
  return jwt.sign({ ...claims, type: 'access' }, env.JWT_ACCESS_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'], // pinned: never let the token pick `none`
    }) as AccessTokenClaims;

    if (decoded.type !== 'access') {
      throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, 'Wrong token type.');
    }
    return decoded;
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Your session has expired.');
    }
    throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, 'Invalid authentication token.');
  }
}

/**
 * Issue a refresh token.
 *
 * The raw token is returned to the caller and never stored; only its SHA-256
 * lands in the database, so a database leak yields no usable sessions.
 */
export async function issueRefreshToken(input: {
  userId: string;
  deviceId: string | null;
  familyId?: string;
  rememberMe?: boolean;
  userAgent?: string | null;
  ipAddress?: string | null;
  replacesId?: string;
}): Promise<{ token: string; id: string; familyId: string; expiresAt: Date }> {
  const raw = randomToken(48);
  const id = ulid();
  const familyId = input.familyId ?? ulid();
  const ttlDays = input.rememberMe ? env.REMEMBER_ME_TTL_DAYS : env.REFRESH_TOKEN_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);

  await prisma.refreshToken.create({
    data: {
      id,
      userId: input.userId,
      deviceId: input.deviceId,
      tokenHash: sha256(raw),
      familyId,
      expiresAt,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    },
  });

  if (input.replacesId) {
    await prisma.refreshToken.update({
      where: { id: input.replacesId },
      data: { usedAt: new Date(), replacedById: id },
    });
  }

  return { token: raw, id, familyId, expiresAt };
}

/**
 * Rotate a refresh token.
 *
 * Throws `AUTH_TOKEN_REVOKED` on reuse after revoking the whole family — the
 * legitimate device will be forced to log in again, which is the correct
 * outcome when we cannot tell it apart from the attacker.
 */
export async function rotateRefreshToken(input: {
  presentedToken: string;
  deviceId: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}): Promise<{ token: string; userId: string; familyId: string; expiresAt: Date }> {
  const tokenHash = sha256(input.presentedToken);
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, 'Invalid refresh token.');
  }

  if (existing.revokedAt) {
    throw new AppError(ErrorCode.AUTH_TOKEN_REVOKED, 'This session has been revoked.');
  }

  if (existing.usedAt) {
    // Reuse detected. Either the token was stolen, or a device was cloned.
    // Burn the family rather than trying to guess which side is legitimate.
    await revokeTokenFamily(existing.familyId, 'refresh token reuse detected');
    logger.warn(
      { userId: existing.userId, familyId: existing.familyId, deviceId: input.deviceId },
      'refresh token reuse detected; family revoked',
    );
    throw new AppError(
      ErrorCode.AUTH_TOKEN_REVOKED,
      'This session has been revoked for security reasons.',
    );
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    throw new AppError(ErrorCode.AUTH_TOKEN_EXPIRED, 'Your session has expired.');
  }

  // A refresh token is bound to the device it was issued to. Presenting it from
  // a different installation is a strong theft signal.
  if (existing.deviceId && input.deviceId && existing.deviceId !== input.deviceId) {
    await revokeTokenFamily(existing.familyId, 'device mismatch on refresh');
    throw new AppError(
      ErrorCode.AUTH_TOKEN_REVOKED,
      'This session has been revoked for security reasons.',
    );
  }

  const issued = await issueRefreshToken({
    userId: existing.userId,
    deviceId: existing.deviceId,
    familyId: existing.familyId,
    userAgent: input.userAgent ?? null,
    ipAddress: input.ipAddress ?? null,
    replacesId: existing.id,
  });

  return {
    token: issued.token,
    userId: existing.userId,
    familyId: issued.familyId,
    expiresAt: issued.expiresAt,
  };
}

export async function revokeTokenFamily(familyId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) },
  });
}

export async function revokeUserTokens(userId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) },
  });
}

export async function revokeDeviceTokens(deviceId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { deviceId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason.slice(0, 120) },
  });
}

/** Housekeeping: drop tokens that expired long enough ago to be uninteresting. */
export async function pruneExpiredTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const { count } = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return count;
}

/** Short-lived single-use token proving an OTP was satisfied. */
export function signActionToken(payload: { sub: string; purpose: string }): string {
  return jwt.sign({ ...payload, type: 'action' }, env.JWT_ACCESS_SECRET, {
    expiresIn: 600,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    algorithm: 'HS256',
    jwtid: ulid(),
  });
}

export function verifyActionToken(token: string, expectedPurpose: string): { sub: string } {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    }) as { sub: string; purpose: string; type: string };

    if (decoded.type !== 'action' || decoded.purpose !== expectedPurpose) {
      throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, 'Invalid token.');
    }
    return { sub: decoded.sub };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(ErrorCode.AUTH_TOKEN_INVALID, 'This link is invalid or has expired.');
  }
}
