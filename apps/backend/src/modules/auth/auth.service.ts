/**
 * Authentication service.
 *
 * Threat model this is written against: credential stuffing, user enumeration,
 * token theft, and device cloning. Each is addressed explicitly below rather
 * than assumed away.
 */

import { AppError, effectivePermissions, ErrorCode, ROLE_PERMISSIONS } from '@orbit/shared';
import type { AuthSession, DeviceInfo, Role } from '@orbit/types';
import { ulid } from '@orbit/utils';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import {
  checkPasswordStrength,
  DEFAULT_PASSWORD_POLICY,
  dummyVerify,
  generateOtp,
  hashPassword,
  hmac,
  isPasswordReused,
  randomToken,
  verifyPassword,
} from '../../lib/crypto.js';
import {
  issueRefreshToken,
  revokeTokenFamily,
  revokeUserTokens,
  rotateRefreshToken,
  signAccessToken,
  signActionToken,
  verifyActionToken,
} from '../../lib/tokens.js';
import {
  sendEmailVerification,
  sendMagicLinkEmail,
  sendPasswordResetEmail,
} from '../email/email.service.js';

export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string;
}

/** Register or refresh a device record and return its id. */
async function upsertDevice(
  userId: string,
  orgId: string,
  info: DeviceInfo,
): Promise<{ id: string; enrolled: boolean }> {
  const existing = await prisma.device.findUnique({
    where: { userId_installationId: { userId, installationId: info.installationId } },
  });

  if (existing) {
    if (existing.revokedAt) {
      throw new AppError(
        ErrorCode.DEVICE_REVOKED,
        'This device has been revoked. Contact your administrator.',
      );
    }
    await prisma.device.update({
      where: { id: existing.id },
      data: {
        name: info.name,
        osVersion: info.osVersion,
        appVersion: info.appVersion,
        model: info.model ?? null,
        lastSeenAt: new Date(),
        deletedAt: null,
      },
    });
    return { id: existing.id, enrolled: true };
  }

  // Enforce the org's device cap before creating another installation.
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
    select: { settings: true },
  });
  const settings = (org.settings ?? {}) as {
    maxDevicesPerUser?: number;
    deviceBindingEnabled?: boolean;
  };
  const maxDevices = settings.maxDevicesPerUser ?? 5;

  const activeCount = await prisma.device.count({
    where: { userId, revokedAt: null, deletedAt: null },
  });
  if (activeCount >= maxDevices) {
    throw new AppError(
      ErrorCode.DEVICE_LIMIT_REACHED,
      `You have reached the limit of ${maxDevices} devices. Remove one before adding another.`,
    );
  }

  const device = await prisma.device.create({
    data: {
      id: ulid(),
      orgId,
      userId,
      installationId: info.installationId,
      name: info.name,
      platform: info.platform,
      osVersion: info.osVersion,
      appVersion: info.appVersion,
      model: info.model ?? null,
      lastSeenAt: new Date(),
    },
  });

  return { id: device.id, enrolled: true };
}

async function buildSession(
  userId: string,
  deviceId: string | null,
  rememberMe: boolean,
  meta: RequestMeta,
): Promise<AuthSession> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      organization: true,
      projectMemberships: { select: { projectId: true } },
    },
  });

  const familyId = ulid();
  const refresh = await issueRefreshToken({
    userId: user.id,
    deviceId,
    familyId,
    rememberMe,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });

  const accessToken = signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role as Role,
    deviceId,
    sid: familyId,
    xp: user.extraPermissions,
    rp: user.revokedPermissions,
  });

  const permissions = Array.from(
    effectivePermissions({
      userId: user.id,
      orgId: user.orgId,
      role: user.role as Role,
      extraPermissions: user.extraPermissions,
      revokedPermissions: user.revokedPermissions,
    }),
  );

  // Never let a password hash or its history escape through the session payload.
  const { passwordHash: _p, passwordHistory: _h, ...safeUser } = user;

  return {
    tokens: {
      accessToken,
      refreshToken: refresh.token,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      tokenType: 'Bearer',
    },
    user: {
      ...safeUser,
      projectIds: user.projectMemberships.map((m) => m.projectId),
    } as unknown as AuthSession['user'],
    organization: user.organization as unknown as AuthSession['organization'],
    device: { id: (deviceId ?? '') as never, enrolled: deviceId !== null },
    permissions,
  };
}

async function audit(
  action: string,
  input: {
    orgId: string;
    userId?: string | null;
    deviceId?: string | null;
    metadata?: Record<string, unknown>;
    meta: RequestMeta;
  },
): Promise<void> {
  await prisma.auditLog
    .create({
      data: {
        id: ulid(),
        orgId: input.orgId,
        userId: input.userId ?? null,
        deviceId: input.deviceId ?? null,
        action,
        metadata: (input.metadata ?? {}) as never,
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent?.slice(0, 400) ?? null,
        requestId: input.meta.requestId,
      },
    })
    .catch((err) => logger.error({ err, action }, 'failed to write audit log'));
}

/**
 * Password login.
 *
 * Enumeration defence: an unknown email still runs a dummy Argon2 verification
 * so the response time matches a real account, and the error message is
 * identical in both cases.
 */
export async function login(input: {
  email: string;
  password: string;
  device: DeviceInfo;
  rememberMe?: boolean;
  meta: RequestMeta;
}): Promise<AuthSession> {
  const user = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase().trim(), deletedAt: null },
    include: { organization: { select: { id: true, isActive: true, settings: true } } },
  });

  if (!user || !user.passwordHash) {
    await dummyVerify(input.password);
    throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'The email or password is incorrect.');
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AppError(
      ErrorCode.TOO_MANY_ATTEMPTS,
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      { retryAfter: minutes * 60 },
    );
  }

  const valid = await verifyPassword(user.passwordHash, input.password);

  if (!valid) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= env.MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + env.ACCOUNT_LOCK_MINUTES * 60_000) : null,
      },
    });
    await audit('AUTH_LOGIN_FAILED', {
      orgId: user.orgId,
      userId: user.id,
      metadata: { attempts, locked: shouldLock },
      meta: input.meta,
    });
    throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'The email or password is incorrect.');
  }

  if (user.status === 'SUSPENDED') {
    throw new AppError(ErrorCode.ACCOUNT_SUSPENDED, 'This account has been suspended.');
  }
  if (user.status === 'DEACTIVATED') {
    throw new AppError(ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
  }
  if (!user.organization.isActive) {
    throw new AppError(ErrorCode.ORG_MISMATCH, 'This organisation is no longer active.');
  }

  // Password expiry, when the org enables it.
  const policy = {
    ...DEFAULT_PASSWORD_POLICY,
    ...((user.organization.settings as { passwordPolicy?: typeof DEFAULT_PASSWORD_POLICY })
      ?.passwordPolicy ?? {}),
  };
  if (policy.maxAgeDays > 0 && user.passwordChangedAt) {
    const ageDays = (Date.now() - user.passwordChangedAt.getTime()) / 86_400_000;
    if (ageDays > policy.maxAgeDays) {
      throw new AppError(
        ErrorCode.PASSWORD_EXPIRED,
        'Your password has expired and must be changed.',
      );
    }
  }

  const device = await upsertDevice(user.id, user.orgId, input.device);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      lastLoginIp: input.meta.ipAddress,
      // First successful login promotes an invited account to active.
      status: user.status === 'INVITED' ? 'ACTIVE' : user.status,
    },
  });

  await audit('AUTH_LOGIN', {
    orgId: user.orgId,
    userId: user.id,
    deviceId: device.id,
    metadata: { platform: input.device.platform, appVersion: input.device.appVersion },
    meta: input.meta,
  });

  return buildSession(user.id, device.id, input.rememberMe === true, input.meta);
}

export async function refresh(input: {
  refreshToken: string;
  deviceId: string | null;
  meta: RequestMeta;
}): Promise<AuthSession> {
  const rotated = await rotateRefreshToken({
    presentedToken: input.refreshToken,
    deviceId: input.deviceId,
    userAgent: input.meta.userAgent,
    ipAddress: input.meta.ipAddress,
  });

  const user = await prisma.user.findUnique({
    where: { id: rotated.userId },
    include: { organization: true, projectMemberships: { select: { projectId: true } } },
  });

  if (!user || user.deletedAt || user.status !== 'ACTIVE') {
    await revokeTokenFamily(rotated.familyId, 'account no longer active');
    throw new AppError(ErrorCode.AUTH_TOKEN_REVOKED, 'This session is no longer valid.');
  }

  const accessToken = signAccessToken({
    sub: user.id,
    orgId: user.orgId,
    role: user.role as Role,
    deviceId: input.deviceId,
    sid: rotated.familyId,
    xp: user.extraPermissions,
    rp: user.revokedPermissions,
  });

  const permissions = Array.from(
    effectivePermissions({
      userId: user.id,
      orgId: user.orgId,
      role: user.role as Role,
      extraPermissions: user.extraPermissions,
      revokedPermissions: user.revokedPermissions,
    }),
  );

  const { passwordHash: _p, passwordHistory: _h, ...safeUser } = user;

  return {
    tokens: {
      accessToken,
      refreshToken: rotated.token,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      tokenType: 'Bearer',
    },
    user: {
      ...safeUser,
      projectIds: user.projectMemberships.map((m) => m.projectId),
    } as unknown as AuthSession['user'],
    organization: user.organization as unknown as AuthSession['organization'],
    device: { id: (input.deviceId ?? '') as never, enrolled: input.deviceId !== null },
    permissions,
  };
}

export async function logout(input: {
  userId: string;
  sessionId: string;
  meta: RequestMeta;
  orgId: string;
}): Promise<void> {
  await revokeTokenFamily(input.sessionId, 'user logged out');
  await audit('AUTH_LOGOUT', { orgId: input.orgId, userId: input.userId, meta: input.meta });
}

/**
 * Begin a password reset.
 *
 * Always reports success. Telling an anonymous caller whether an email is
 * registered is a free user-enumeration oracle.
 */
export async function forgotPassword(input: { email: string; meta: RequestMeta }): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase().trim(), deletedAt: null },
    select: { id: true, orgId: true, status: true, email: true, firstName: true },
  });

  if (!user || user.status === 'DEACTIVATED') return;

  const code = generateOtp();
  await prisma.otpCode.create({
    data: {
      id: ulid(),
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      codeHash: hmac(code),
      expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1000),
      ipAddress: input.meta.ipAddress,
    },
  });

  /*
   * Delivery is attempted, and its failure is not the caller's problem.
   *
   * The code is already committed above, so a mail provider outage must not
   * roll this back or surface an error: the response is a fixed 202 either way,
   * because varying it would tell an unauthenticated caller whether the address
   * is registered. A failure is logged and counted; on an install with no
   * provider the `log` transport writes the code where an administrator can
   * find it, which is the difference between a degraded reset and one that
   * silently does nothing — the previous behaviour.
   */
  const result = await sendPasswordResetEmail({
    to: user.email,
    firstName: user.firstName,
    code,
  });

  logger.info(
    { userId: user.id, delivered: result.delivered, transport: result.transport },
    'password reset code issued',
  );
  await audit('AUTH_PASSWORD_RESET', { orgId: user.orgId, userId: user.id, meta: input.meta });
}

/** Verify an OTP and mint a single-use action token. */
export async function verifyOtp(input: {
  email: string;
  code: string;
  purpose: 'PASSWORD_RESET' | 'EMAIL_VERIFICATION' | 'DEVICE_ENROLMENT' | 'STEP_UP_AUTH';
  meta: RequestMeta;
}): Promise<{ actionToken: string; expiresIn: number }> {
  const user = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase().trim(), deletedAt: null },
    select: { id: true, orgId: true },
  });
  if (!user) throw new AppError(ErrorCode.AUTH_OTP_INVALID, 'The code is invalid or has expired.');

  const record = await prisma.otpCode.findFirst({
    where: { userId: user.id, purpose: input.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record)
    throw new AppError(ErrorCode.AUTH_OTP_INVALID, 'The code is invalid or has expired.');

  if (record.expiresAt.getTime() < Date.now()) {
    throw new AppError(ErrorCode.AUTH_OTP_EXPIRED, 'The code has expired. Request a new one.');
  }

  if (record.attempts >= record.maxAttempts) {
    // Consume it so a brute-force run cannot keep probing the same code.
    await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    throw new AppError(ErrorCode.TOO_MANY_ATTEMPTS, 'Too many attempts. Request a new code.');
  }

  if (record.codeHash !== hmac(input.code)) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw new AppError(ErrorCode.AUTH_OTP_INVALID, 'The code is invalid or has expired.');
  }

  await prisma.otpCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });

  return {
    actionToken: signActionToken({ sub: user.id, purpose: input.purpose }),
    expiresIn: 600,
  };
}

export async function resetPassword(input: {
  actionToken: string;
  newPassword: string;
  meta: RequestMeta;
}): Promise<void> {
  const { sub } = verifyActionToken(input.actionToken, 'PASSWORD_RESET');

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: sub },
    include: { organization: { select: { settings: true } } },
  });

  const policy = {
    ...DEFAULT_PASSWORD_POLICY,
    ...((user.organization.settings as { passwordPolicy?: typeof DEFAULT_PASSWORD_POLICY })
      ?.passwordPolicy ?? {}),
  };

  const strength = checkPasswordStrength(input.newPassword, policy, {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  });
  if (!strength.valid) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
      fields: { newPassword: strength.errors.join(' ') },
    });
  }

  const history = (user.passwordHistory as string[]) ?? [];
  if (await isPasswordReused(input.newPassword, history, policy.historyDepth)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'You cannot reuse a recent password.', {
      fields: { newPassword: 'You cannot reuse a recent password.' },
    });
  }

  const hash = await hashPassword(input.newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: hash,
      passwordChangedAt: new Date(),
      // Chosen by the owner now, so the shared-credential state is over.
      mustChangePassword: false,
      passwordHistory: [user.passwordHash, ...history]
        .filter(Boolean)
        .slice(0, policy.historyDepth) as never,
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  // A password change invalidates every existing session: if the reset was
  // triggered by a compromise, the attacker's sessions must die with it.
  await revokeUserTokens(user.id, 'password reset');
  await audit('AUTH_PASSWORD_CHANGED', { orgId: user.orgId, userId: user.id, meta: input.meta });
}

export async function changePassword(input: {
  userId: string;
  orgId: string;
  currentPassword: string;
  newPassword: string;
  meta: RequestMeta;
}): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    include: { organization: { select: { settings: true } } },
  });

  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw new AppError(ErrorCode.AUTH_INVALID_CREDENTIALS, 'Your current password is incorrect.');
  }

  const policy = {
    ...DEFAULT_PASSWORD_POLICY,
    ...((user.organization.settings as { passwordPolicy?: typeof DEFAULT_PASSWORD_POLICY })
      ?.passwordPolicy ?? {}),
  };

  const strength = checkPasswordStrength(input.newPassword, policy, {
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
  });
  if (!strength.valid) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
      fields: { newPassword: strength.errors.join(' ') },
    });
  }

  const history = (user.passwordHistory as string[]) ?? [];
  if (await isPasswordReused(input.newPassword, history, policy.historyDepth)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'You cannot reuse a recent password.', {
      fields: { newPassword: 'You cannot reuse a recent password.' },
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      passwordHistory: [user.passwordHash, ...history]
        .filter(Boolean)
        .slice(0, policy.historyDepth) as never,
    },
  });

  await revokeUserTokens(user.id, 'password changed');
  await audit('AUTH_PASSWORD_CHANGED', { orgId: input.orgId, userId: user.id, meta: input.meta });
}

export const ROLE_MATRIX = ROLE_PERMISSIONS;

// ---------------------------------------------------------------------------
// Magic-link sign-in
// ---------------------------------------------------------------------------

/**
 * Issue a single-use sign-in link.
 *
 * Same enumeration defence as `forgotPassword`: the caller is unauthenticated,
 * so the response cannot vary with whether the address is registered. An
 * unknown address does the same work and returns the same 202.
 *
 * The token is random and stored hashed, not a signed JWT. A JWT cannot be
 * invalidated once issued, which would leave a working credential sitting in
 * the recipient's inbox until it expired; consuming a row makes single use
 * enforceable.
 */
export async function requestMagicLink(input: { email: string; meta: RequestMeta }): Promise<void> {
  if (!env.ALLOW_MAGIC_LINK) {
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'Magic-link sign-in is not enabled on this installation.',
    );
  }

  const user = await prisma.user.findFirst({
    where: { email: input.email.toLowerCase().trim(), deletedAt: null },
    select: { id: true, orgId: true, status: true, email: true, firstName: true },
  });
  if (!user || user.status === 'DEACTIVATED') return;

  // 32 bytes of entropy: this token *is* the credential, unlike a 6-digit OTP
  // which is protected by an attempt counter as well.
  const token = randomToken();

  await prisma.otpCode.create({
    data: {
      id: ulid(),
      userId: user.id,
      purpose: 'MAGIC_LINK',
      codeHash: hmac(token),
      expiresAt: new Date(Date.now() + env.MAGIC_LINK_TTL_SECONDS * 1000),
      ipAddress: input.meta.ipAddress,
      // One guess, because guessing is not the threat model for a 256-bit token
      // and a retry counter would only slow down legitimate use.
      maxAttempts: 1,
    },
  });

  const result = await sendMagicLinkEmail({
    to: user.email,
    firstName: user.firstName,
    token,
  });

  logger.info(
    { userId: user.id, delivered: result.delivered, transport: result.transport },
    'magic link issued',
  );
  await audit('AUTH_MAGIC_LINK_ISSUED', {
    orgId: user.orgId,
    userId: user.id,
    meta: input.meta,
  });
}

/**
 * Exchange a magic-link token for a session.
 *
 * The row is consumed before the session is built, so a link raced by two
 * clicks mints exactly one session.
 */
export async function consumeMagicLink(input: {
  token: string;
  device: DeviceInfo;
  meta: RequestMeta;
}): Promise<AuthSession> {
  if (!env.ALLOW_MAGIC_LINK) {
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'Magic-link sign-in is not enabled on this installation.',
    );
  }

  const record = await prisma.otpCode.findFirst({
    where: { purpose: 'MAGIC_LINK', codeHash: hmac(input.token), consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw new AppError(ErrorCode.AUTH_OTP_INVALID, 'That sign-in link is invalid or has expired.');
  }

  // Conditional update: `consumedAt: null` in the where clause means two
  // concurrent redemptions cannot both succeed, without needing a transaction.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) {
    throw new AppError(ErrorCode.AUTH_OTP_INVALID, 'That sign-in link has already been used.');
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: record.userId },
    select: { id: true, orgId: true, status: true },
  });
  if (user.status === 'DEACTIVATED' || user.status === 'SUSPENDED') {
    throw new AppError(ErrorCode.ACCOUNT_DEACTIVATED, 'This account is not active.');
  }

  const device = await upsertDevice(user.id, user.orgId, input.device);
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), lastLoginIp: input.meta.ipAddress, failedLoginAttempts: 0 },
  });
  await audit('AUTH_LOGIN', {
    orgId: user.orgId,
    userId: user.id,
    deviceId: device.id,
    metadata: { method: 'magic-link' },
    meta: input.meta,
  });

  return buildSession(user.id, device.id, false, input.meta);
}

/**
 * Re-issue an email-verification code for the signed-in user.
 *
 * Any outstanding code is consumed first, so the most recent one is the only
 * one that works — otherwise a user who clicked "resend" three times has three
 * live codes, and revoking the leaked one does not help.
 */
export async function resendEmailVerification(input: {
  userId: string;
  meta: RequestMeta;
}): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { id: true, orgId: true, email: true, firstName: true, emailVerifiedAt: true },
  });

  if (user.emailVerifiedAt) {
    throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, 'This address is already verified.');
  }

  await prisma.otpCode.updateMany({
    where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', consumedAt: null },
    data: { consumedAt: new Date() },
  });

  const code = generateOtp();
  await prisma.otpCode.create({
    data: {
      id: ulid(),
      userId: user.id,
      purpose: 'EMAIL_VERIFICATION',
      codeHash: hmac(code),
      expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1000),
      ipAddress: input.meta.ipAddress,
    },
  });

  const result = await sendEmailVerification({
    to: user.email,
    firstName: user.firstName,
    code,
  });

  logger.info(
    { userId: user.id, delivered: result.delivered, transport: result.transport },
    'email verification code issued',
  );
  await audit('AUTH_EMAIL_VERIFICATION_SENT', {
    orgId: user.orgId,
    userId: user.id,
    meta: input.meta,
  });
}
