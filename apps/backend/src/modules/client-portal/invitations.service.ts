/**
 * Client invitations.
 *
 * The only way a customer obtains a portal login. Open registration was
 * removed because a company must decide who becomes its client — anybody
 * holding the portal address could previously create an account, which is not
 * something an enterprise customer will accept.
 *
 * Three properties carry the security of this, and each is enforced here
 * rather than by the caller:
 *
 *  1. **The token is never stored.** Only a SHA-256 of it is. A database copy —
 *     a backup, a support query, a leaked dump — cannot be turned back into
 *     working invitations. The raw token exists twice: in the response that
 *     created it, and in the link the administrator sends. There is no endpoint
 *     anywhere that can show it again, which is why "resend" issues a new one.
 *  2. **Failure is indistinguishable.** Expired, revoked, already used, and
 *     never-existed all produce the same 404 with the same wording. Anything
 *     finer is an oracle: it tells somebody holding a guessed token whether
 *     they guessed a real one, and tells an outsider whether a given customer
 *     was ever invited.
 *  3. **Single use is a database fact, not a check.** Acceptance sets
 *     `acceptedAt` inside the same transaction that creates the user, so two
 *     simultaneous redemptions cannot both succeed.
 *
 * The row outlives the token deliberately. An invitation that was used, or
 * revoked, is part of how an account came to exist, and deleting it would
 * remove the answer to "who let this person in".
 */

import { createHash, randomBytes } from 'node:crypto';

import { AppError, ErrorCode } from '@orbit/shared';
import { Role, SyncEntity, SyncOperation } from '@orbit/types';
import { ulid } from '@orbit/utils';
import type { Prisma } from '@prisma/client';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { checkPasswordStrength, DEFAULT_PASSWORD_POLICY, hashPassword } from '../../lib/crypto.js';
import type { RequestMeta } from '../auth/auth.service.js';
import { recordChange } from '../sync/change-log.js';

/**
 * 32 bytes of randomness, base64url encoded.
 *
 * 256 bits is far past guessable, and base64url survives being pasted into a
 * URL, an email and a chat message without escaping — which matters, because
 * an administrator will move this link by hand.
 */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * The one refusal this module ever gives for a token.
 *
 * Expired, revoked, spent and imaginary are the same answer. Distinguishing
 * them would let somebody probe which invitations exist or existed.
 */
function refuseToken(): never {
  throw new AppError(
    ErrorCode.NOT_FOUND,
    'This invitation link is not valid. It may have expired or already been used — ask for a new one.',
  );
}

/** How long a new invitation stays usable. */
function ttlHours(): number {
  return env.CLIENT_INVITATION_TTL_HOURS;
}

export interface CreateInvitationInput {
  orgId: string;
  clientId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Overrides the deployment default, within bounds the route enforces. */
  expiresInHours?: number;
  actorUserId: string;
  meta: RequestMeta;
}

export interface CreatedInvitation {
  id: string;
  /** The raw token. Returned once, never retrievable again. */
  token: string;
  email: string;
  expiresAt: Date;
}

/**
 * Invite somebody to create a portal login for a customer.
 *
 * Supersedes any invitation still outstanding for the same address at the same
 * customer. Two live links to one account is a loose end: revoking the one you
 * remember would leave the other working.
 */
export async function createInvitation(input: CreateInvitationInput): Promise<CreatedInvitation> {
  const email = input.email.toLowerCase().trim();

  const client = await prisma.client.findFirst({
    where: { id: input.clientId, orgId: input.orgId, deletedAt: null },
    select: { id: true, name: true, isActive: true },
  });
  if (!client) throw new AppError(ErrorCode.NOT_FOUND, 'That client was not found.');
  if (!client.isActive) {
    throw new AppError(
      ErrorCode.CONFLICT,
      'This client is deactivated. Reactivate it before inviting anybody.',
    );
  }

  /*
   * An address may hold one account across the whole installation.
   *
   * Sign-in resolves an address with "first match wins", so a second account
   * on the same address would silently strand one of the two people. Caught
   * here rather than at acceptance, so the administrator finds out while they
   * are still looking at the screen instead of the customer finding out later.
   */
  const existing = await prisma.user.findFirst({
    where: { email, deletedAt: null },
    select: { id: true, clientId: true },
  });
  if (existing) {
    throw new AppError(
      ErrorCode.DUPLICATE_RESOURCE,
      existing.clientId === input.clientId
        ? 'That person already has a portal login.'
        : 'That email address already has an account on this installation.',
      { fields: { email: 'Already registered.' } },
    );
  }

  const token = mintToken();
  const expiresAt = new Date(Date.now() + (input.expiresInHours ?? ttlHours()) * 3_600_000);
  const id = ulid();

  await prisma.$transaction(async (tx) => {
    // Supersede anything still live for this address at this customer.
    await tx.clientInvitation.updateMany({
      where: {
        orgId: input.orgId,
        clientId: input.clientId,
        email,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revokedById: input.actorUserId },
    });

    await tx.clientInvitation.create({
      data: {
        id,
        orgId: input.orgId,
        clientId: input.clientId,
        tokenHash: hashToken(token),
        email,
        firstName: input.firstName?.trim() || null,
        lastName: input.lastName?.trim() || null,
        expiresAt,
        createdById: input.actorUserId,
      },
    });

    await tx.auditLog.create({
      data: {
        id: ulid(),
        orgId: input.orgId,
        userId: input.actorUserId,
        action: 'RECORD_CREATED',
        entity: 'ClientInvitation',
        entityId: id,
        // Never the token, and never its hash: an audit log is read by more
        // people than the table it describes.
        metadata: { clientId: input.clientId, email, expiresAt: expiresAt.toISOString() },
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent?.slice(0, 400) ?? null,
        requestId: input.meta.requestId,
      },
    });
  });

  logger.info({ orgId: input.orgId, clientId: input.clientId, invitationId: id }, 'client invited');
  return { id, token, email, expiresAt };
}

export interface InvitationDetails {
  organizationName: string;
  organizationSlug: string;
  clientName: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  expiresAt: Date;
}

/**
 * Look a token up and describe who it is for, without spending it.
 *
 * The portal calls this to draw the acceptance page. What comes back is only
 * what the recipient already knows — their own name, their own address, the
 * company that invited them — so a guessed token reveals nothing new even in
 * the impossible case that one is guessed.
 */
export async function describeInvitation(
  token: string,
  organizationSlug?: string,
): Promise<InvitationDetails> {
  const invitation = await prisma.clientInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      client: { select: { name: true, isActive: true, deletedAt: true } },
      organization: { select: { name: true, slug: true, isActive: true } },
    },
  });

  if (!invitation) refuseToken();
  if (invitation.acceptedAt || invitation.revokedAt) refuseToken();
  if (invitation.expiresAt.getTime() <= Date.now()) refuseToken();
  if (!invitation.client || invitation.client.deletedAt || !invitation.client.isActive) refuseToken();
  if (!invitation.organization.isActive) refuseToken();

  /*
   * The link carries the company, and the token belongs to one. A token opened
   * at another company's portal is refused — otherwise the per-company portal
   * is decoration, and an invitation from one firm would admit somebody
   * through another's front door.
   */
  if (organizationSlug && invitation.organization.slug !== organizationSlug.toLowerCase()) {
    refuseToken();
  }

  return {
    organizationName: invitation.organization.name,
    organizationSlug: invitation.organization.slug,
    clientName: invitation.client.name,
    email: invitation.email,
    firstName: invitation.firstName,
    lastName: invitation.lastName,
    expiresAt: invitation.expiresAt,
  };
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  organizationSlug?: string;
  firstName?: string;
  lastName?: string;
  meta: RequestMeta;
}

/**
 * Spend an invitation and create the login it promised.
 *
 * Everything happens in one transaction, including marking it spent. Two
 * browsers redeeming the same link at the same moment cannot both produce an
 * account: the second finds `acceptedAt` already set and is refused with the
 * same message as an imaginary token.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<{ userId: string; email: string; orgId: string }> {
  const tokenHash = hashToken(input.token);

  const invitation = await prisma.clientInvitation.findUnique({
    where: { tokenHash },
    include: {
      client: { select: { id: true, name: true, isActive: true, deletedAt: true } },
      organization: { select: { id: true, name: true, slug: true, isActive: true, settings: true } },
    },
  });

  if (!invitation) refuseToken();
  if (invitation.acceptedAt || invitation.revokedAt) refuseToken();
  if (invitation.expiresAt.getTime() <= Date.now()) refuseToken();
  if (!invitation.client || invitation.client.deletedAt || !invitation.client.isActive) refuseToken();
  if (!invitation.organization.isActive) refuseToken();
  if (
    input.organizationSlug &&
    invitation.organization.slug !== input.organizationSlug.toLowerCase()
  ) {
    refuseToken();
  }

  const firstName = (input.firstName ?? invitation.firstName ?? '').trim() || invitation.email.split('@')[0]!;
  const lastName = (input.lastName ?? invitation.lastName ?? '').trim();

  const policy =
    ((invitation.organization.settings as Record<string, unknown> | null)?.passwordPolicy as
      | typeof DEFAULT_PASSWORD_POLICY
      | undefined) ?? DEFAULT_PASSWORD_POLICY;
  const strength = checkPasswordStrength(input.password, policy, {
    email: invitation.email,
    firstName,
    lastName,
  });
  if (!strength.valid) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
      fields: { password: strength.errors.join(' ') },
    });
  }

  // Checked again here, because the address may have been claimed between the
  // invitation being sent and it being opened.
  const taken = await prisma.user.findFirst({
    where: { email: invitation.email, deletedAt: null },
    select: { id: true },
  });
  if (taken) {
    throw new AppError(
      ErrorCode.DUPLICATE_RESOURCE,
      'An account already exists for that email address. Sign in instead, or use the password reset.',
    );
  }

  const passwordHash = await hashPassword(input.password);
  const userId = ulid();
  const orgId = invitation.organization.id;

  await prisma.$transaction(async (tx) => {
    /*
     * Spend it first, conditionally.
     *
     * `updateMany` with the unspent condition in the `where` means the write
     * either matches one row or none, and none means somebody else got there
     * during this transaction. Checking and then writing would leave a window
     * where both callers passed the check.
     */
    const spent = await tx.clientInvitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedUserId: userId },
    });
    if (spent.count !== 1) refuseToken();

    await tx.user.create({
      data: {
        id: userId,
        orgId,
        clientId: invitation.client.id,
        email: invitation.email,
        firstName,
        lastName,
        passwordHash,
        passwordChangedAt: new Date(),
        role: Role.CLIENT,
        status: 'ACTIVE',
        // They chose it themselves, so there is nothing to force a change of.
        mustChangePassword: false,
        emailVerifiedAt: new Date(),
      },
    });

    const row = await tx.user.findUniqueOrThrow({
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
        version: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });
    await recordChange(tx, {
      orgId,
      entity: SyncEntity.USER,
      operation: SyncOperation.CREATE,
      entityId: userId,
      version: row.version,
      row,
      actorUserId: userId,
      actorDeviceId: null,
    });

    await tx.auditLog.create({
      data: {
        id: ulid(),
        orgId,
        userId,
        action: 'RECORD_UPDATED',
        entity: 'ClientInvitation',
        entityId: invitation.id,
        metadata: { accepted: true, clientId: invitation.client.id, email: invitation.email },
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent?.slice(0, 400) ?? null,
        requestId: input.meta.requestId,
      },
    });
  });

  logger.info({ orgId, invitationId: invitation.id, userId }, 'client invitation accepted');
  return { userId, email: invitation.email, orgId };
}

/** Cancel an invitation that has not been used. */
export async function revokeInvitation(input: {
  orgId: string;
  clientId: string;
  invitationId: string;
  actorUserId: string;
  meta: RequestMeta;
}): Promise<void> {
  const revoked = await prisma.clientInvitation.updateMany({
    where: {
      id: input.invitationId,
      orgId: input.orgId,
      clientId: input.clientId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date(), revokedById: input.actorUserId },
  });

  if (revoked.count !== 1) {
    throw new AppError(
      ErrorCode.NOT_FOUND,
      'That invitation was not found, or has already been used or cancelled.',
    );
  }

  await prisma.auditLog.create({
    data: {
      id: ulid(),
      orgId: input.orgId,
      userId: input.actorUserId,
      action: 'RECORD_DELETED',
      entity: 'ClientInvitation',
      entityId: input.invitationId,
      metadata: { revoked: true, clientId: input.clientId },
      ipAddress: input.meta.ipAddress,
      requestId: input.meta.requestId,
    },
  });
}

/** What the console shows against a customer. Never includes a token. */
export async function listInvitations(orgId: string, clientId: string) {
  const rows = await prisma.clientInvitation.findMany({
    where: { orgId, clientId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      createdAt: true,
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });

  const now = Date.now();
  return rows.map((row) => ({
    ...row,
    /*
     * One word for the console to render. Order matters: an invitation that
     * was accepted and has since passed its expiry is still "accepted", not
     * "expired".
     */
    status: row.acceptedAt
      ? 'ACCEPTED'
      : row.revokedAt
        ? 'REVOKED'
        : row.expiresAt.getTime() <= now
          ? 'EXPIRED'
          : 'PENDING',
  }));
}
