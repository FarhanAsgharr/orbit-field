/**
 * Customer self-registration, from the Client Portal only.
 *
 * This is the second and last way an account comes into existence, and it is a
 * deliberately different thing from `register.service.ts`. That one bootstraps
 * the *installation* — it creates an organisation, runs exactly once, and is
 * closed forever afterwards. This one creates a *customer of* that
 * organisation: a `Client` row holding the company's details and one `User`
 * with `Role.CLIENT` bound to it. It never creates an organisation, never
 * grants a staff role, and stays open for as long as the company wants to take
 * work from new customers.
 *
 * Two things are worth being explicit about.
 *
 * **Which organisation a customer joins.** Orbit Field is a single-company
 * install: bootstrap signup runs once, so there is normally one organisation
 * and no question to answer. A deployment that acquired a second one — a demo
 * tenant seeded alongside the real company, which is exactly the situation on
 * this production database — needs to say which is which, so
 * `PORTAL_ORG_SLUG` names it. Absent that, the earliest-created organisation
 * wins, because under bootstrap-only signup that is the one whose owner set the
 * installation up.
 *
 * **This endpoint is open by definition.** Anyone who reaches the portal URL
 * can create a client record, which is what a customer portal *is* — the
 * alternative is administrators typing in every customer by hand, which is the
 * workflow this replaces. What limits the damage is that the account it mints
 * is the weakest role in the system, sees only rows carrying its own
 * `clientId`, and reaches no admin surface at all. An organisation that would
 * rather vet customers first can set `clientSelfRegistration: false` in its
 * settings, and the endpoint refuses with a message pointing at the company.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import { Role, SyncEntity, SyncOperation } from '@orbit/types';
import { ulid } from '@orbit/utils';
import type { Prisma } from '@prisma/client';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { checkPasswordStrength, DEFAULT_PASSWORD_POLICY, hashPassword } from '../../lib/crypto.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { notifyUsers } from '../notifications/push.service.js';
import { recordChange } from '../sync/change-log.js';

export interface ClientRegistrationInput {
  /* Company */
  companyName: string;
  logoUrl?: string | null;
  industry?: string | null;
  registrationNumber?: string | null;
  taxNumber?: string | null;

  /* Contact person */
  contactName: string;
  contactDesignation?: string | null;
  email: string;
  contactPhone: string;
  whatsapp?: string | null;

  /* Address */
  country: string;
  state: string;
  city: string;
  address: string;
  postalCode?: string | null;

  /* Business */
  website?: string | null;
  notes?: string | null;

  /* Account */
  password: string;

  meta: RequestMeta;
}

export interface ClientRegistrationResult {
  clientId: string;
  userId: string;
  orgId: string;
  email: string;
}

interface HostOrganization {
  id: string;
  name: string;
  settings: Prisma.JsonValue;
}

/**
 * The organisation a self-registering customer becomes a client of.
 *
 * Returns null on an installation that has not been set up yet, which the
 * caller turns into a message telling the visitor the portal is not open rather
 * than a stack trace.
 */
async function hostOrganization(): Promise<HostOrganization | null> {
  const select = { id: true, name: true, settings: true };

  if (env.PORTAL_ORG_SLUG) {
    const named = await prisma.organization.findUnique({
      where: { slug: env.PORTAL_ORG_SLUG },
      select,
    });
    if (named) return named;
    // A slug configured but absent is a deployment mistake, not a visitor's
    // problem. Say so in the log and fall through rather than turning every
    // registration into a 500.
    logger.warn(
      { slug: env.PORTAL_ORG_SLUG },
      'PORTAL_ORG_SLUG names an organisation that does not exist; falling back to the oldest',
    );
  }

  return prisma.organization.findFirst({ orderBy: { createdAt: 'asc' }, select });
}

/** Whether the portal is currently accepting new customers, and where they go. */
export async function clientSignupAvailable(): Promise<{
  available: boolean;
  organizationName: string | null;
  reason?: string;
}> {
  const org = await hostOrganization();
  if (!org) {
    return {
      available: false,
      organizationName: null,
      reason: 'This portal is not set up yet. Please contact the company you are working with.',
    };
  }

  const settings = (org.settings ?? {}) as Record<string, unknown>;
  if (settings.clientSelfRegistration === false) {
    return {
      available: false,
      organizationName: org.name,
      reason: `${org.name} creates client accounts directly. Contact them to have yours set up.`,
    };
  }

  return { available: true, organizationName: org.name };
}

/**
 * A short, human-readable code for the client record.
 *
 * Staff refer to customers by code in exports and conversation, so it is
 * derived from the company name rather than random, and uniquified within the
 * organisation because two customers called "Northwind" is a normal thing to
 * happen.
 */
async function uniqueClientCode(orgId: string, companyName: string): Promise<string> {
  const base =
    companyName
      .toUpperCase()
      .normalize('NFKD')
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 8) || 'CLIENT';

  /*
   * Deleted clients still count.
   *
   * `@@unique([orgId, code])` is a database constraint and knows nothing about
   * `deletedAt`, so a soft-deleted client keeps its code reserved forever.
   * Probing with `deletedAt: null` therefore hands back a code that is already
   * taken, and the insert fails with a duplicate-key error naming an internal
   * column — which reaches the customer as "A record with this orgId, code
   * already exists", about a field they never saw and cannot change.
   *
   * Found by the production verification run: the second registration of a
   * company whose earlier record had been deleted was refused outright.
   */
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
    const taken = await prisma.client.findFirst({
      where: { orgId, code: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${base}${ulid().slice(-4)}`;
}

/**
 * Create a customer company and its first portal login.
 *
 * Returns identifiers only. The caller signs the new user in through the normal
 * login path so there stays exactly one place in the system that mints a
 * session.
 */
export async function registerClient(
  input: ClientRegistrationInput,
): Promise<ClientRegistrationResult> {
  const availability = await clientSignupAvailable();
  if (!availability.available) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, availability.reason!);
  }

  const org = (await hostOrganization())!;
  const email = input.email.toLowerCase().trim();
  const companyName = input.companyName.trim();
  const [firstName, ...restOfName] = input.contactName.trim().split(/\s+/);

  const existing = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      ErrorCode.DUPLICATE_RESOURCE,
      'An account already exists for that email address. Sign in instead, or use the password reset if you have forgotten it.',
      { fields: { email: 'Already registered.' } },
    );
  }

  const policy =
    ((org.settings as Record<string, unknown> | null)?.passwordPolicy as
      typeof DEFAULT_PASSWORD_POLICY | undefined) ?? DEFAULT_PASSWORD_POLICY;
  const strength = checkPasswordStrength(input.password, policy, {
    email,
    firstName: firstName ?? '',
    lastName: restOfName.join(' '),
  });
  if (!strength.valid) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
      fields: { password: strength.errors.join(' ') },
    });
  }

  const code = await uniqueClientCode(org.id, companyName);
  const passwordHash = await hashPassword(input.password);
  const clientId = ulid();
  const userId = ulid();

  const nullable = (value: string | null | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };

  await prisma.$transaction(async (tx) => {
    await tx.client.create({
      data: {
        id: clientId,
        orgId: org.id,
        name: companyName,
        code,
        contactName: input.contactName.trim(),
        contactEmail: email,
        contactPhone: input.contactPhone.trim(),
        contactDesignation: nullable(input.contactDesignation),
        whatsapp: nullable(input.whatsapp),
        industry: nullable(input.industry),
        registrationNumber: nullable(input.registrationNumber),
        taxNumber: nullable(input.taxNumber),
        website: nullable(input.website),
        country: input.country.trim(),
        state: input.state.trim(),
        city: input.city.trim(),
        address: input.address.trim(),
        postalCode: nullable(input.postalCode),
        notes: nullable(input.notes),
        logoUrl: nullable(input.logoUrl),
        isActive: true,
        lastWriterUserId: userId,
      },
    });

    await tx.user.create({
      data: {
        id: userId,
        orgId: org.id,
        clientId,
        email,
        firstName: firstName ?? companyName,
        lastName: restOfName.join(' ') || '',
        phone: input.contactPhone.trim(),
        passwordHash,
        passwordChangedAt: new Date(),
        role: Role.CLIENT,
        status: 'ACTIVE',
        jobTitle: nullable(input.contactDesignation),
        emailVerifiedAt: null,
      },
    });

    /*
     * Both rows reach the change log.
     *
     * The client is a replicated entity an inspector's phone needs in order to
     * show who a job is for. The user row matters less on a device — a customer
     * never holds one — but users replicate as a class, and an unpublished row
     * is a hole in the log that later updates to the same entity would
     * reference. Publishing on create keeps the entity's history contiguous.
     */
    const clientRow = await tx.client.findUniqueOrThrow({ where: { id: clientId } });
    await recordChange(tx, {
      orgId: org.id,
      entity: SyncEntity.CLIENT,
      operation: SyncOperation.CREATE,
      entityId: clientId,
      version: clientRow.version,
      row: clientRow,
      actorUserId: userId,
      actorDeviceId: null,
    });

    // Never the password hash: this row is replicated to every member of the
    // organisation and then sits on their phones.
    const userRow = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        orgId: true,
        clientId: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        avatarUrl: true,
        role: true,
        status: true,
        jobTitle: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
    await recordChange(tx, {
      orgId: org.id,
      entity: SyncEntity.USER,
      operation: SyncOperation.CREATE,
      entityId: userId,
      version: userRow.version,
      row: userRow,
      actorUserId: userId,
      actorDeviceId: null,
    });

    await tx.auditLog.create({
      data: {
        id: ulid(),
        orgId: org.id,
        userId,
        action: 'RECORD_CREATED',
        entity: 'Client',
        entityId: clientId,
        metadata: { companyName, code, selfRegistered: true, portal: true },
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent?.slice(0, 400) ?? null,
        requestId: input.meta.requestId,
      },
    });
  });

  /*
   * Tell the people who have to act on it.
   *
   * A customer who registers is waiting for work to start. If nobody with a
   * console notices, the portal has quietly become a form that goes nowhere —
   * so every administrator gets a notification, the same way they do for a new
   * request.
   */
  const admins = await prisma.user.findMany({
    where: {
      orgId: org.id,
      role: { in: ['SUPER_ADMIN', 'ADMIN'] },
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true },
  });
  // Not awaited: the client exists either way, and a push outage must not fail
  // a registration that already committed.
  void notifyUsers(
    org.id,
    admins.map((admin) => admin.id),
    {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'New client registered',
      body: `${companyName} created an account through the client portal.`,
      data: { clientId },
    },
  ).catch(() => undefined);

  logger.info({ orgId: org.id, clientId, userId, code }, 'client self-registered through portal');

  return { clientId, userId, orgId: org.id, email };
}
