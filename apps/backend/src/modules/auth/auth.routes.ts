/** Authentication routes. */

import { OtpPurpose } from '@orbit/types';
import { ulid } from '@orbit/utils';
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { revokeUserTokens } from '../../lib/tokens.js';
import { requireAuth } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { authLimiter, otpLimiter } from '../../middleware/rate-limit.js';
import { schemas, validate } from '../../middleware/validate.js';
import * as authService from './auth.service.js';
import { registerOrganization, signupAvailable } from './register.service.js';

const router: Router = Router();

const deviceSchema = z.object({
  installationId: z.string().min(8).max(128),
  name: z.string().min(1).max(120),
  platform: z.enum(['ios', 'android', 'web']),
  osVersion: z.string().max(40),
  appVersion: z.string().max(40),
  model: z.string().max(80).optional(),
});

function meta(req: Request): authService.RequestMeta {
  return {
    ipAddress: clientIp(req),
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId,
  };
}

router.post(
  '/login',
  authLimiter,
  validate({
    body: z.object({
      email: schemas.email,
      password: z.string().min(1).max(200),
      device: deviceSchema,
      rememberMe: z.boolean().optional(),
      /** Set by the Client Portal, which takes it from its own address. */
      organizationSlug: z.string().min(1).max(80).trim().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as {
      email: string;
      password: string;
      device: z.infer<typeof deviceSchema>;
      rememberMe?: boolean;
      organizationSlug?: string;
    };
    const session = await authService.login({ ...body, meta: meta(req) });
    res.json({ data: session });
  }),
);

/**
 * Whether this installation accepts self-service signup.
 *
 * Public and unauthenticated so the sign-in screen can hide the "create
 * account" tab rather than offering a button that always fails.
 */
router.get(
  '/signup-available',
  asyncHandler(async (_req, res) => {
    // Asks the same question the register endpoint will ask, rather than
    // reading a flag: the console hides its "Create account" tab on this
    // answer, and a tab that leads to a guaranteed 403 is worse than none.
    res.json({ data: { available: await signupAvailable() } });
  }),
);

/**
 * Create an organisation and its first administrator.
 *
 * Registers, then signs in through the ordinary login path so there is exactly
 * one place in the codebase that mints a session.
 */
router.post(
  '/register',
  authLimiter,
  validate({
    body: z.object({
      email: schemas.email,
      password: schemas.password,
      firstName: z.string().min(1).max(100).trim(),
      lastName: z.string().min(1).max(100).trim(),
      organizationName: z.string().min(2).max(200).trim(),
      timezone: z.string().max(64).optional(),
      device: deviceSchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      organizationName: string;
      timezone?: string;
      device: z.infer<typeof deviceSchema>;
    };

    const created = await registerOrganization({ ...body, meta: meta(req) });

    const session = await authService.login({
      email: body.email,
      password: body.password,
      device: body.device,
      rememberMe: true,
      meta: meta(req),
    });

    res.status(201).json({
      data: {
        ...session,
        // Tells the console to route the new administrator somewhere useful
        // rather than an empty dashboard.
        onboarding: { starterTemplateId: created.templateId },
      },
    });
  }),
);

router.post(
  '/refresh',
  validate({
    body: z.object({
      refreshToken: z.string().min(20).max(500),
      deviceId: schemas.ulid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as { refreshToken: string; deviceId?: string };
    const session = await authService.refresh({
      refreshToken: body.refreshToken,
      deviceId: body.deviceId ?? null,
      meta: meta(req),
    });
    res.json({ data: session });
  }),
);

router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    await authService.logout({
      userId: subject.userId,
      orgId: subject.orgId,
      sessionId: subject.sessionId,
      meta: meta(req),
    });
    res.status(204).end();
  }),
);

router.post(
  '/forgot-password',
  otpLimiter,
  validate({ body: z.object({ email: schemas.email }) }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as { email: string };
    await authService.forgotPassword({ email: body.email, meta: meta(req) });
    // Always 202, regardless of whether the account exists — see the service.
    res.status(202).json({
      data: { message: 'If an account exists for that address, a reset code has been sent.' },
    });
  }),
);

router.post(
  '/verify-otp',
  otpLimiter,
  validate({
    body: z.object({
      email: schemas.email,
      code: z.string().regex(/^\d{4,10}$/, 'Enter the numeric code from your email.'),
      purpose: z.nativeEnum(OtpPurpose),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as { email: string; code: string; purpose: OtpPurpose };
    res.json({ data: await authService.verifyOtp({ ...body, meta: meta(req) }) });
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  validate({
    body: z.object({
      actionToken: z.string().min(20),
      newPassword: schemas.password,
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as { actionToken: string; newPassword: string };
    await authService.resetPassword({ ...body, meta: meta(req) });
    res.status(204).end();
  }),
);

router.post(
  '/change-password',
  requireAuth,
  validate({
    body: z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: schemas.password,
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as { currentPassword: string; newPassword: string };
    await authService.changePassword({
      userId: subject.userId,
      orgId: subject.orgId,
      ...body,
      meta: meta(req),
    });
    res.status(204).end();
  }),
);

/** Current session — the app calls this on cold start to rehydrate. */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    res.json({
      data: {
        userId: subject.userId,
        orgId: subject.orgId,
        role: subject.role,
        deviceId: subject.deviceId,
        projectIds: subject.projectIds,
      },
    });
  }),
);

/**
 * Your own record, in full.
 *
 * `/me` is deliberately minimal — the mobile app calls it on every cold start
 * and only needs identity and scope. A person looking at their own profile
 * wants the rest, and asking them to be an administrator to see their own
 * department is absurd, so this is a separate, self-scoped endpoint rather
 * than a widening of `/me`.
 */
router.get(
  '/profile',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: subject.userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        employeeId: true,
        department: true,
        jobTitle: true,
        registrationNumber: true,
        role: true,
        status: true,
        timezone: true,
        locale: true,
        lastLoginAt: true,
        lastLoginIp: true,
        mustChangePassword: true,
        passwordChangedAt: true,
        createdAt: true,
        organization: { select: { id: true, name: true } },
        devices: {
          where: { deletedAt: null },
          orderBy: { lastSeenAt: 'desc' },
          select: {
            id: true,
            name: true,
            platform: true,
            appVersion: true,
            osVersion: true,
            lastSeenAt: true,
            lastSyncAt: true,
            revokedAt: true,
          },
        },
      },
    });

    res.json({ data: user });
  }),
);

/**
 * Edit your own details.
 *
 * Deliberately excludes role, status and email. Those decide what you may do
 * and how you sign in, and letting somebody change their own role here would
 * make every RBAC check in the system advisory. They remain an administrator's
 * to change, through `/users/:id`.
 */
router.patch(
  '/profile',
  requireAuth,
  validate({
    body: z.object({
      firstName: z.string().min(1).max(100).trim().optional(),
      lastName: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(32).nullable().optional(),
      avatarUrl: z.string().url().max(500).nullable().optional(),
      jobTitle: z.string().max(120).nullable().optional(),
      department: z.string().max(120).nullable().optional(),
      employeeId: z.string().max(60).nullable().optional(),
      timezone: z.string().max(64).nullable().optional(),
      locale: z.string().max(16).nullable().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as Record<string, unknown>;

    const updated = await prisma.user.update({
      where: { id: subject.userId },
      data: body as never,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        employeeId: true,
        department: true,
        jobTitle: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        userId: subject.userId,
        action: 'RECORD_UPDATED',
        entity: 'User',
        entityId: subject.userId,
        metadata: { self: true, fields: Object.keys(body) },
        ipAddress: clientIp(req),
        requestId: req.requestId,
      },
    });

    res.json({ data: updated });
  }),
);

/**
 * Sign out everywhere.
 *
 * What somebody reaches for when they think an account is compromised, or when
 * a phone is lost. Revokes every refresh token and every device, so the next
 * request from any of them fails — the access tokens they already hold expire
 * on their own within fifteen minutes, and `passwordChangedAt` is untouched
 * because no credential has changed.
 */
router.post(
  '/logout-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);

    const devices = await prisma.device.updateMany({
      where: { userId: subject.userId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: 'signed out of all devices by the account owner',
        pushToken: null,
      },
    });

    await revokeUserTokens(subject.userId, 'signed out of all devices');

    await prisma.auditLog.create({
      data: {
        id: ulid(),
        orgId: subject.orgId,
        userId: subject.userId,
        action: 'AUTH_LOGOUT',
        entity: 'User',
        entityId: subject.userId,
        metadata: { allDevices: true, devicesRevoked: devices.count },
        ipAddress: clientIp(req),
        requestId: req.requestId,
      },
    });

    res.json({ data: { devicesRevoked: devices.count } });
  }),
);

/**
 * Request a single-use sign-in link.
 *
 * Rate limited with the OTP limiter and answered with a fixed 202 whichever
 * way it goes: varying the response by whether the address exists would turn
 * this into an account-enumeration oracle, exactly as with password reset.
 */
router.post(
  '/magic-link',
  otpLimiter,
  validate({ body: z.object({ email: schemas.email }) }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as { email: string };
    await authService.requestMagicLink({ email: body.email, meta: meta(req) });
    res.status(202).json({
      data: { message: 'If an account exists for that address, a sign-in link has been sent.' },
    });
  }),
);

/** Exchange a magic-link token for a session. Enrols the device like login does. */
router.post(
  '/magic-link/consume',
  authLimiter,
  validate({
    body: z.object({
      token: z.string().min(20).max(200),
      device: deviceSchema,
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.validated!.body as { token: string; device: z.infer<typeof deviceSchema> };
    const session = await authService.consumeMagicLink({
      token: body.token,
      device: body.device,
      meta: meta(req),
    });
    res.json({ data: session });
  }),
);

/**
 * Resend an email-verification code.
 *
 * Deliberately requires an authenticated session rather than taking an address:
 * an unauthenticated resend endpoint is a way to have this server send mail to
 * anyone, repeatedly, on request.
 */
router.post(
  '/resend-verification',
  requireAuth,
  otpLimiter,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    await authService.resendEmailVerification({ userId: subject.userId, meta: meta(req) });
    res.status(202).json({ data: { message: 'A verification code has been sent.' } });
  }),
);

export { router as authRouter };
