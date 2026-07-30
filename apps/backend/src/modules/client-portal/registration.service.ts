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
 * **Which organisation a customer joins — the URL says.** This has been wrong
 * twice, in opposite directions. First it guessed: the oldest organisation won,
 * which silently filed customers under a company they had never dealt with.
 * Then it asked, with a dropdown — which fixed the misfiling but published
 * every company's name to anyone who opened the portal, and still let somebody
 * pick the wrong one.
 *
 * Now the company comes from the address the customer was given:
 * `portal.example.com/acme` is Acme's portal and nothing else. There is no
 * list to leak and no question to answer wrongly. A slug that names no company
 * is a 404 — the same answer a stranger gets for a company that does exist but
 * has closed registration, so probing tells them nothing either way.
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

  /** Which company this customer is registering with. */
  organizationSlug?: string;

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
  slug: string;
  isActive: boolean;
  settings: Prisma.JsonValue;
}

const ORG_SELECT = { id: true, name: true, slug: true, isActive: true, settings: true };

/** Whether this company is currently taking client registrations. */
function accepts(org: { settings: Prisma.JsonValue }): boolean {
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  return settings.clientSelfRegistration !== false;
}

/**
 * The one company a portal address names.
 *
 * Deliberately singular. Nothing here returns "all companies" to an
 * unauthenticated caller, because a customer portal that can enumerate its
 * tenants publishes the operator's customer list — and where two competitors
 * may both be tenants, that is precisely the disclosure this design exists to
 * prevent.
 *
 * `PORTAL_ORG_SLUG` pins a deployment to one company and makes the URL segment
 * irrelevant, which is how a customer-owned deployment on its own domain runs.
 */
export async function organizationForPortal(slug: string): Promise<HostOrganization | null> {
  const wanted = env.PORTAL_ORG_SLUG ?? slug;
  if (!wanted) return null;

  const org = await prisma.organization.findUnique({
    where: { slug: wanted.toLowerCase() },
    select: ORG_SELECT,
  });

  if (!org || !org.isActive) return null;
  return org;
}

/**
 * Resolve the company a submission names, or refuse.
 *
 * Never falls back to "the only one" or "the first one". Both were real bugs:
 * the fallback filed customers under a company they had never heard of, and
 * the dropdown that replaced it let them pick a competitor's portal by mistake
 * while publishing every tenant's name.
 */
async function resolveOrganization(slug: string | undefined): Promise<HostOrganization> {
  const org = slug ? await organizationForPortal(slug) : null;

  /*
   * One message for "no such company" and for "that company is not taking
   * registrations".
   *
   * Distinguishing them would make this endpoint an oracle: a stranger could
   * walk a word list and learn exactly which companies exist here.
   */
  if (!org || !accepts(org)) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'This portal address is not valid. Ask the company you are working with for their portal link.',
    );
  }

  return org;
}

/**
 * What the portal may say about the company whose address was opened.
 *
 * Name and slug only, and only for a company that was named correctly. There
 * is no list, no search and no "did you mean" — the caller must already know
 * the address, which is exactly the property that keeps one tenant from
 * discovering another.
 */
export async function portalTenant(slug: string): Promise<{
  slug: string;
  name: string;
} | null> {
  const org = await organizationForPortal(slug);
  if (!org) return null;
  // Name and slug, and nothing else. Accounts come from invitations now, so
  // there is no registration state for a stranger to learn either.
  return { slug: org.slug, name: org.name };
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
  const org = await resolveOrganization(input.organizationSlug);
  const email = input.email.toLowerCase().trim();
  const companyName = input.companyName.trim();
  /*
   * The contact's name, split into the two columns a user row has.
   *
   * `Client.contactName` is varchar(120) and keeps whatever was typed;
   * `User.firstName` and `User.lastName` are varchar(100) each. A single
   * 120-character name therefore validated cleanly and then overflowed
   * `firstName`, which reached the browser as "an unexpected error occurred".
   *
   * Truncating the derived halves is the right trade rather than refusing the
   * name: the full value is preserved on the client record, and no real name
   * is 100 characters, so this only ever fires on input that was never a name.
   */
  const fit = (value: string): string => value.slice(0, 100);
  const [firstNameRaw, ...restOfName] = input.contactName.trim().split(/\s+/);
  const firstName = fit(firstNameRaw ?? '');
  const lastName = fit(restOfName.join(' '));

  /*
   * A removed account still holds its address.
   *
   * The unique index is `(orgId, email)` and knows nothing about `deletedAt`,
   * so filtering the probe on `deletedAt: null` let a soft-deleted row through
   * — and the insert then failed on the constraint, surfacing as a raw
   * "a record with this orgId, email already exists". That names a database
   * column at somebody trying to sign up.
   *
   * Same shape of mistake as the client code above, and worth stating twice:
   * a uniqueness probe must match the constraint it is standing in for.
   */
  const existing = await prisma.user.findFirst({
    where: { email },
    select: { id: true, deletedAt: true },
  });
  if (existing) {
    throw new AppError(
      ErrorCode.DUPLICATE_RESOURCE,
      existing.deletedAt
        ? 'That email address belonged to an account that has since been removed. Contact the company to have it set up again.'
        : 'An account already exists for that email address. Sign in instead, or use the password reset if you have forgotten it.',
      { fields: { email: 'Already registered.' } },
    );
  }

  const policy =
    ((org.settings as Record<string, unknown> | null)?.passwordPolicy as
      typeof DEFAULT_PASSWORD_POLICY | undefined) ?? DEFAULT_PASSWORD_POLICY;
  const strength = checkPasswordStrength(input.password, policy, {
    email,
    firstName,
    lastName,
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
        firstName: firstName || fit(companyName),
        lastName,
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
