/**
 * The Client Portal's own endpoints.
 *
 * Everything a customer does that is not a request lives here: registering,
 * finding out whether registration is open, and maintaining their company's
 * details. Requests, comments and attachments are in `requests.routes.ts`;
 * reports and inspections are read through the existing routers, which already
 * narrow by `subject.clientId`.
 *
 * Two of these three routes are unauthenticated, which is unusual enough in
 * this codebase to say why: a customer who has not registered has no token to
 * present, so the portal's front door cannot require one. They are rate-limited
 * with the same limiter as login, write nothing a caller controls the shape of,
 * and cannot name an organisation — the server decides which one a registration
 * belongs to.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { requireAuth } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { validate } from '../../middleware/validate.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { recordChange } from '../sync/change-log.js';
import { SyncEntity, SyncOperation } from '@orbit/types';
import { clientSignupAvailable, registerClient } from './registration.service.js';

const router: Router = Router();

function meta(req: Request): RequestMeta {
  return {
    ipAddress: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
    requestId: req.requestId,
  };
}

/**
 * A phone number, loosely.
 *
 * Deliberately permissive: customers are international, and a validator strict
 * enough to be meaningful rejects legitimate numbers from countries nobody
 * tested against. Length and character class is as far as this can usefully go.
 */
const phone = z
  .string()
  .min(5)
  .max(32)
  .regex(/^[+()\-.\s\d]+$/, 'Enter a valid phone number.')
  .trim();

/**
 * A website, forgivingly.
 *
 * People type "acme.com". Requiring a scheme means a correct answer is refused
 * for a reason that reads as pedantry, so one is added when it is missing.
 */
const website = z
  .string()
  .max(300)
  .trim()
  .transform((value) => (value && !/^https?:\/\//i.test(value) ? `https://${value}` : value))
  .refine((value) => !value || z.string().url().safeParse(value).success, 'Enter a valid website.');

const registrationSchema = z.object({
  companyName: z.string().min(2).max(200).trim(),
  logoUrl: z.string().url().max(500).nullish(),
  industry: z.string().max(120).trim().nullish(),
  registrationNumber: z.string().max(80).trim().nullish(),
  taxNumber: z.string().max(80).trim().nullish(),

  contactName: z.string().min(2).max(120).trim(),
  contactDesignation: z.string().max(120).trim().nullish(),
  email: z.string().email().max(320).trim(),
  contactPhone: phone,
  whatsapp: phone.nullish(),

  country: z.string().min(2).max(120).trim(),
  state: z.string().min(1).max(120).trim(),
  city: z.string().min(1).max(120).trim(),
  address: z.string().min(5).max(2000).trim(),
  postalCode: z.string().max(20).trim().nullish(),

  website: website.nullish(),
  notes: z.string().max(2000).trim().nullish(),

  password: z.string().min(1).max(200),
});

/**
 * Is the portal accepting registrations, and who is behind it?
 *
 * The portal asks before drawing the form. Offering a signup an installation
 * will refuse sends people to a page that cannot work; hiding one that would
 * have succeeded loses a customer. The organisation's name comes back so the
 * portal can say whose portal this is rather than showing unbranded chrome.
 */
router.get(
  '/registration',
  authLimiter,
  asyncHandler(async (_req, res) => {
    res.json({ data: await clientSignupAvailable() });
  }),
);

/** Create a client company and its first login. */
router.post(
  '/register',
  authLimiter,
  validate({ body: registrationSchema }),
  asyncHandler(async (req, res) => {
    /*
     * The *validated* body, never `req.body`.
     *
     * `validate` parses into `req.validated` and leaves the raw body alone, so
     * reading `req.body` here would take the caller's object verbatim: zod's
     * stripping of unknown keys would not have happened, and neither would the
     * transforms — a website typed as "acme.com" would be stored without a
     * scheme, and any extra key the caller invented would be passed straight
     * to Prisma.
     */
    const body = req.validated!.body as z.infer<typeof registrationSchema>;
    const result = await registerClient({ ...body, meta: meta(req) });
    /*
     * Identifiers only, and no session.
     *
     * The portal signs the new account in through `/auth/login` like any other
     * account, so there stays exactly one code path that mints a token and one
     * place where device binding, lockout and audit happen.
     */
    res.status(201).json({
      data: { clientId: result.clientId, userId: result.userId, email: result.email },
    });
  }),
);

// ---------------------------------------------------------------------------
// The customer's own company record
// ---------------------------------------------------------------------------

const companySelect = {
  id: true,
  name: true,
  code: true,
  logoUrl: true,
  industry: true,
  registrationNumber: true,
  taxNumber: true,
  contactName: true,
  contactDesignation: true,
  contactEmail: true,
  contactPhone: true,
  whatsapp: true,
  website: true,
  country: true,
  state: true,
  city: true,
  address: true,
  postalCode: true,
  notes: true,
  isActive: true,
  createdAt: true,
  version: true,
} satisfies Prisma.ClientSelect;

/** Only a customer has a company to read. */
function requireClientId(subject: ReturnType<typeof auth>): string {
  if (!subject.clientId) {
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'This is a client portal endpoint. Staff accounts manage clients from the console.',
    );
  }
  return subject.clientId;
}

router.get(
  '/company',
  requireAuth,
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const company = await prisma.client.findFirst({
      where: { id: requireClientId(subject), orgId: subject.orgId, deletedAt: null },
      select: companySelect,
    });
    if (!company) throw new AppError(ErrorCode.NOT_FOUND, 'Company record not found.');
    res.json({ data: company });
  }),
);

/**
 * What a customer may change about their own company.
 *
 * Not the name, and not the contact email. The name is how staff refer to the
 * account in conversation and in exports, and the email is the login identity —
 * letting either be edited from the portal turns a support call into "which
 * company is this?". Both are changed by an administrator, which is also the
 * point at which somebody notices.
 */
const companyUpdateSchema = z.object({
  logoUrl: z.string().url().max(500).nullish(),
  industry: z.string().max(120).trim().nullish(),
  registrationNumber: z.string().max(80).trim().nullish(),
  taxNumber: z.string().max(80).trim().nullish(),
  contactName: z.string().min(2).max(120).trim().optional(),
  contactDesignation: z.string().max(120).trim().nullish(),
  contactPhone: phone.optional(),
  whatsapp: phone.nullish(),
  website: website.nullish(),
  country: z.string().min(2).max(120).trim().optional(),
  state: z.string().min(1).max(120).trim().optional(),
  city: z.string().min(1).max(120).trim().optional(),
  address: z.string().min(5).max(2000).trim().optional(),
  postalCode: z.string().max(20).trim().nullish(),
});

router.patch(
  '/company',
  requireAuth,
  validate({ body: companyUpdateSchema }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const clientId = requireClientId(subject);
    // Validated, not raw — see the note on the register handler. This one
    // matters more: the raw body reaches `client.update` as a spread, so an
    // unstripped `name`, `orgId` or `isActive` would be written by a customer.
    const body = req.validated!.body as z.infer<typeof companyUpdateSchema>;

    const existing = await prisma.client.findFirst({
      where: { id: clientId, orgId: subject.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new AppError(ErrorCode.NOT_FOUND, 'Company record not found.');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.client.update({
        where: { id: clientId },
        data: {
          ...body,
          version: { increment: 1 },
          lastWriterUserId: subject.userId,
          lastWriterDeviceId: subject.deviceId,
        },
      });

      // A client is a replicated entity: an inspector's phone shows the
      // customer's name and contact details against the job, so an edit that
      // never reaches the change log leaves stale details in the field.
      await recordChange(tx, {
        orgId: subject.orgId,
        entity: SyncEntity.CLIENT,
        operation: SyncOperation.UPDATE,
        entityId: clientId,
        version: row.version,
        row,
        actorUserId: subject.userId,
        actorDeviceId: subject.deviceId,
      });

      return row;
    });

    res.json({
      data: Object.fromEntries(
        Object.entries(updated).filter(([key]) => key in companySelect),
      ) as Record<string, unknown>,
    });
  }),
);

export { router as portalRouter };
