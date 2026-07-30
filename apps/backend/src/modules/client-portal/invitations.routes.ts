/**
 * Invitation endpoints.
 *
 * Two audiences on two routers. Staff create, list, revoke and resend from the
 * console, behind `client:write`. The recipient validates and accepts
 * anonymously — they have no account yet, which is the entire point — so those
 * two routes are rate-limited and answer every failure identically.
 *
 * Nothing here can show an existing token. `resend` mints a new one and
 * supersedes the old, because the stored hash is one-way and there is no
 * mechanism, anywhere, to recover what was sent.
 */

import { Permission } from '@orbit/shared';
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { schemas, validate } from '../../middleware/validate.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  acceptInvitation,
  createInvitation,
  describeInvitation,
  listInvitations,
  revokeInvitation,
} from './invitations.service.js';

function meta(req: Request): RequestMeta {
  return {
    ipAddress: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId,
  };
}

// ---------------------------------------------------------------------------
// Staff: mounted under /clients/:clientId/invitations
// ---------------------------------------------------------------------------

export const clientInvitationsRouter: Router = Router({ mergeParams: true });

/** Invitations against a customer, newest first. Never includes a token. */
clientInvitationsRouter.get(
  '/',
  requireAuth,
  requirePermission(Permission.CLIENT_READ),
  validate({ params: z.object({ clientId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { clientId } = req.validated!.params as { clientId: string };
    res.json({ data: await listInvitations(subject.orgId, clientId) });
  }),
);

/**
 * Invite somebody, or replace the invitation they already have.
 *
 * The raw token comes back exactly once, in this response. The console turns
 * it into a link for the administrator to copy; nothing stores it, and no
 * later request can retrieve it.
 */
clientInvitationsRouter.post(
  '/',
  requireAuth,
  requirePermission(Permission.CLIENT_WRITE),
  validate({
    params: z.object({ clientId: schemas.ulid }),
    body: z.object({
      email: z.string().email().max(320).trim(),
      firstName: z.string().max(100).trim().nullish(),
      lastName: z.string().max(100).trim().nullish(),
      /** One hour to ninety days. Outside that is a mistake, not a policy. */
      expiresInHours: z.coerce.number().int().min(1).max(2160).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { clientId } = req.validated!.params as { clientId: string };
    const body = req.validated!.body as {
      email: string;
      firstName?: string | null;
      lastName?: string | null;
      expiresInHours?: number;
    };

    const invitation = await createInvitation({
      orgId: subject.orgId,
      clientId,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      expiresInHours: body.expiresInHours,
      actorUserId: subject.userId,
      meta: meta(req),
    });

    res.status(201).json({
      data: {
        id: invitation.id,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
        /*
         * The path the recipient opens, not a whole URL. The API does not know
         * where the portal is deployed, and guessing would produce a link that
         * works in one environment and not another — the console owns the
         * origin and builds the address from this.
         */
        invitePath: `/invite/${invitation.token}`,
        token: invitation.token,
      },
    });
  }),
);

/** Cancel an invitation that has not been used. */
clientInvitationsRouter.delete(
  '/:invitationId',
  requireAuth,
  requirePermission(Permission.CLIENT_WRITE),
  validate({ params: z.object({ clientId: schemas.ulid, invitationId: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { clientId, invitationId } = req.validated!.params as {
      clientId: string;
      invitationId: string;
    };

    await revokeInvitation({
      orgId: subject.orgId,
      clientId,
      invitationId,
      actorUserId: subject.userId,
      meta: meta(req),
    });

    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// The recipient: mounted under /portal
// ---------------------------------------------------------------------------

export const portalInvitationsRouter: Router = Router();

/**
 * Describe an invitation without spending it.
 *
 * Draws the acceptance page. What comes back is only what the recipient
 * already knows — their own name and address, and who invited them — so even
 * a guessed token reveals nothing they did not have.
 */
portalInvitationsRouter.get(
  '/:token',
  authLimiter,
  validate({
    params: z.object({ token: z.string().min(20).max(200) }),
    query: z.object({ company: z.string().max(80).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { token } = req.validated!.params as { token: string };
    const { company } = req.validated!.query as { company?: string };
    res.json({ data: await describeInvitation(token, company) });
  }),
);

/**
 * Spend it, and create the login.
 *
 * No session is returned: the portal signs in through `/auth/login` like any
 * other client, so there stays exactly one code path that mints a token and
 * one place where device binding, lockout and audit happen.
 */
portalInvitationsRouter.post(
  '/:token/accept',
  authLimiter,
  validate({
    params: z.object({ token: z.string().min(20).max(200) }),
    body: z.object({
      password: z.string().min(1).max(200),
      firstName: z.string().max(100).trim().optional(),
      lastName: z.string().max(100).trim().optional(),
      organizationSlug: z.string().max(80).trim().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { token } = req.validated!.params as { token: string };
    const body = req.validated!.body as {
      password: string;
      firstName?: string;
      lastName?: string;
      organizationSlug?: string;
    };

    const result = await acceptInvitation({ token, ...body, meta: meta(req) });
    res.status(201).json({ data: { userId: result.userId, email: result.email } });
  }),
);
