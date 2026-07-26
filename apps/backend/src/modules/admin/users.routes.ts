/**
 * User administration.
 *
 * Privilege escalation is the risk this file guards against. Two rules, both
 * enforced by `canManageUser` / `canAssignRole` in the shared RBAC module rather
 * than reimplemented here:
 *
 *   - you may only act on users strictly below your own rank, so two admins
 *     cannot lock each other out and nobody but a SUPER_ADMIN touches one;
 *   - you may only grant a role strictly below your own, so a MANAGER cannot
 *     promote themselves by way of promoting a colleague.
 */

import {
  ALL_PERMISSIONS,
  AppError,
  canAssignRole,
  canManageUser,
  effectivePermissions,
  ErrorCode,
  Permission,
  ROLE_PERMISSIONS,
} from '@orbit/shared';
import { type Role, ROLE_RANK, SyncEntity, SyncOperation } from '@orbit/types';
import { toDisplayString, ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma.js';
import { checkPasswordStrength, DEFAULT_PASSWORD_POLICY, hashPassword } from '../../lib/crypto.js';
import {
  paginate,
  paginationArgs,
  paginationSchema,
  searchFilter,
  sortArgs,
} from '../../lib/pagination.js';
import { revokeUserTokens, signActionToken } from '../../lib/tokens.js';
import { requireAuth, requirePermission } from '../../middleware/auth.js';
import { auth, clientIp } from '../../middleware/context.js';
import { asyncHandler } from '../../middleware/error.js';
import { schemas, validate } from '../../middleware/validate.js';
import { sendInvitationEmail } from '../email/email.service.js';
import { recordChange } from '../sync/change-log.js';

const router: Router = Router();

/** Never select the password hash or its history. */
/**
 * Publish a user to the change log.
 *
 * Devices replay the change log and nothing else, so a user created or changed
 * only in the database is invisible to every phone in the organisation. That is
 * not cosmetic: an inspector's device needs the user rows to show who assigned
 * a job and who reviewed it, and a newly added inspector never appears at all.
 *
 * The row is filtered, not passed through. `passwordHash` and
 * `passwordHistory` must never leave the server — this row is replicated to
 * every member of the organisation and then sits on their phones.
 */
async function publishUser(
  tx: Prisma.TransactionClient,
  orgId: string,
  userId: string,
  operation: 'CREATE' | 'UPDATE',
  actor: { userId: string; deviceId: string | null },
): Promise<void> {
  const row = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      orgId: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      avatarUrl: true,
      role: true,
      status: true,
      department: true,
      jobTitle: true,
      registrationNumber: true,
      timezone: true,
      locale: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
    },
  });
  if (!row) return;

  await recordChange(tx, {
    orgId,
    entity: SyncEntity.USER,
    operation: operation === 'CREATE' ? SyncOperation.CREATE : SyncOperation.UPDATE,
    entityId: userId,
    version: row.version,
    row,
    actorUserId: actor.userId,
    actorDeviceId: actor.deviceId,
  });
}

const userSelect = {
  id: true,
  email: true,
  emailVerifiedAt: true,
  phone: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  role: true,
  status: true,
  department: true,
  jobTitle: true,
  registrationNumber: true,
  employeeId: true,
  extraPermissions: true,
  revokedPermissions: true,
  timezone: true,
  locale: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { devices: true, assignedInspections: true } },
} satisfies Prisma.UserSelect;

const SORTABLE = ['createdAt', 'lastLoginAt', 'firstName', 'lastName', 'email', 'role'] as const;

router.get(
  '/',
  requireAuth,
  requirePermission(Permission.USER_READ),
  validate({
    query: paginationSchema.extend({
      search: z.string().max(200).optional(),
      role: z.string().max(40).optional(),
      status: z.string().max(40).optional(),
      sortBy: z.string().optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const q = req.validated!.query as {
      page: number;
      pageSize: number;
      search?: string;
      role?: string;
      status?: string;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    };

    const where: Prisma.UserWhereInput = {
      orgId: subject.orgId,
      deletedAt: null,
      ...(q.role ? { role: q.role as Role } : {}),
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.search
        ? {
            OR: [
              { firstName: searchFilter(q.search) },
              { lastName: searchFilter(q.search) },
              { email: searchFilter(q.search) },
              { department: searchFilter(q.search) },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: sortArgs(q.sortBy, q.sortDir, SORTABLE, 'createdAt'),
        ...paginationArgs(q),
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ data: paginate(items, total, q) });
  }),
);

router.get(
  '/:id',
  requireAuth,
  requirePermission(Permission.USER_READ),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const user = await prisma.user.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: {
        ...userSelect,
        projectMemberships: {
          select: { project: { select: { id: true, name: true, code: true } } },
        },
        devices: {
          where: { deletedAt: null },
          select: { id: true, name: true, platform: true, lastSeenAt: true, revokedAt: true },
        },
      },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND, 'That user was not found.');

    // The effective set is what the API will actually enforce, so it is what an
    // administrator needs to see — not just the role's baseline.
    const permissions = Array.from(
      effectivePermissions({
        userId: user.id,
        orgId: subject.orgId,
        role: user.role as Role,
        extraPermissions: user.extraPermissions,
        revokedPermissions: user.revokedPermissions,
      }),
    );

    /*
     * Whether this person can be permanently deleted, and why not if they
     * cannot. The console needs it to choose between offering "delete" and
     * offering "deactivate" — asking, being refused, and reading the reason is
     * a worse way to find out.
     */
    const usage = await usageOf(user.id);

    res.json({
      data: {
        ...user,
        effectivePermissions: permissions,
        deletable: Object.keys(usage).length === 0,
        usage,
      },
    });
  }),
);

/**
 * Invite a user, or create one outright.
 *
 * Two modes, and which one you get depends on whether `password` is supplied:
 *
 *   - **Omitted** — the user is created INVITED with no password and sets one
 *     through the standard reset flow, so a password never travels through an
 *     invite email. This is the better mode and requires working outbound mail.
 *
 *   - **Supplied** — the user is created ACTIVE with that password already set.
 *     This exists because an installation with no `SMTP_URL` cannot deliver the
 *     reset OTP, which would leave every invited account permanently unable to
 *     sign in. The administrator hands the password over out of band and the
 *     recipient changes it. The password is validated against the same policy
 *     as any other, and never appears in the response or the audit metadata.
 */
router.post(
  '/',
  requireAuth,
  requirePermission(Permission.USER_INVITE),
  validate({
    body: z.object({
      email: schemas.email,
      firstName: z.string().min(1).max(100).trim(),
      lastName: z.string().min(1).max(100).trim(),
      role: z.enum([
        'SUPER_ADMIN',
        'ADMIN',
        'MANAGER',
        'SUPERVISOR',
        'INSPECTOR',
        'TECHNICIAN',
        'VIEWER',
      ]),
      department: z.string().max(120).nullable().optional(),
      jobTitle: z.string().max(120).nullable().optional(),
      registrationNumber: z.string().max(80).nullable().optional(),
      employeeId: z.string().max(60).nullable().optional(),
      projectIds: z.array(schemas.ulid).max(100).optional(),
      password: z.string().min(1).max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const body = req.validated!.body as {
      email: string;
      firstName: string;
      lastName: string;
      role: Role;
      department?: string | null;
      jobTitle?: string | null;
      registrationNumber?: string | null;
      employeeId?: string | null;
      projectIds?: string[];
      password?: string;
    };

    if (!canAssignRole(subject, body.role)) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        `You cannot grant the ${body.role} role — it is at or above your own level.`,
      );
    }

    const existing = await prisma.user.findFirst({
      where: { orgId: subject.orgId, email: body.email },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      throw new AppError(
        ErrorCode.DUPLICATE_RESOURCE,
        'A user with that email already exists in this organisation.',
      );
    }

    // Same policy the user would face changing it themselves — an account
    // created by an administrator must not be the one weak password in the org.
    let passwordHash: string | null = null;
    if (body.password !== undefined) {
      const strength = checkPasswordStrength(body.password, DEFAULT_PASSWORD_POLICY, {
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
      });
      if (!strength.valid) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
          fields: { password: strength.errors.join(' ') },
        });
      }
      passwordHash = await hashPassword(body.password);
    }

    const userId = ulid();

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id: userId,
          orgId: subject.orgId,
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          role: body.role,
          // A user who already has a password has nothing to accept, so leaving
          // them INVITED would be a status that never resolves.
          status: passwordHash ? 'ACTIVE' : 'INVITED',
          passwordHash,
          passwordChangedAt: passwordHash ? new Date() : null,
          // The owner did not choose this password and it travelled out of
          // band, so it is known to at least two people until they replace it.
          mustChangePassword: Boolean(passwordHash),
          department: body.department ?? null,
          jobTitle: body.jobTitle ?? null,
          registrationNumber: body.registrationNumber ?? null,
          employeeId: body.employeeId ?? null,
        },
        select: userSelect,
      });

      if (body.projectIds?.length) {
        await tx.projectMember.createMany({
          data: body.projectIds.map((projectId) => ({ projectId, userId })),
          skipDuplicates: true,
        });
      }

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_CREATED',
          entity: 'User',
          entityId: userId,
          // Records that a password was set, never what it was.
          metadata: {
            email: body.email,
            role: body.role,
            passwordSetByAdmin: Boolean(passwordHash),
          },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      // Devices replay the change log and nothing else, so a colleague added
      // here is invisible to every phone until this runs.
      await publishUser(tx, subject.orgId, userId, 'CREATE', subject);

      return user;
    });

    /*
     * The invitation only goes out when there is no password.
     *
     * With one supplied the administrator is handing the credential over
     * themselves, and a "set your password" email would be a second, confusing
     * route in. Without one, this email is the recipient's *only* way to reach
     * the account, so whether it was delivered is reported back rather than
     * swallowed — an administrator who sees `emailDelivered: false` knows to
     * pass the details on some other way instead of waiting.
     */
    let emailDelivered: boolean | null = null;
    if (!passwordHash) {
      const [org, invitedBy] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: subject.orgId },
          select: { name: true },
        }),
        prisma.user.findUnique({
          where: { id: subject.userId },
          select: { firstName: true, lastName: true },
        }),
      ]);

      const result = await sendInvitationEmail({
        to: body.email,
        firstName: body.firstName,
        organisationName: org?.name ?? 'your organisation',
        invitedByName: invitedBy
          ? `${invitedBy.firstName} ${invitedBy.lastName}`
          : 'An administrator',
        token: signActionToken({ sub: userId, purpose: 'INVITE_ACCEPT' }),
      });
      emailDelivered = result.delivered;
    }

    res.status(201).json({ data: { ...created, emailDelivered } });
  }),
);

/** Update a user. Role changes and status changes are separately gated. */
router.patch(
  '/:id',
  requireAuth,
  requirePermission(Permission.USER_UPDATE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({
      email: schemas.email.optional(),
      firstName: z.string().min(1).max(100).trim().optional(),
      lastName: z.string().min(1).max(100).trim().optional(),
      phone: z.string().max(32).nullable().optional(),
      role: z
        .enum([
          'SUPER_ADMIN',
          'ADMIN',
          'MANAGER',
          'SUPERVISOR',
          'INSPECTOR',
          'TECHNICIAN',
          'VIEWER',
        ])
        .optional(),
      department: z.string().max(120).nullable().optional(),
      jobTitle: z.string().max(120).nullable().optional(),
      registrationNumber: z.string().max(80).nullable().optional(),
      employeeId: z.string().max(60).nullable().optional(),
      status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
      extraPermissions: z.array(z.string().max(60)).max(80).optional(),
      revokedPermissions: z.array(z.string().max(60)).max(80).optional(),
      projectIds: z.array(schemas.ulid).max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const body = req.validated!.body as Record<string, unknown>;

    const target = await prisma.user.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true, role: true, orgId: true, status: true, email: true },
    });
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, 'That user was not found.');

    if (
      !canManageUser(subject, { role: target.role as Role, orgId: target.orgId, userId: target.id })
    ) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        target.id === subject.userId
          ? 'You cannot change your own role or status here.'
          : 'You cannot manage a user at or above your own level.',
      );
    }

    /*
     * Email is the credential half of a login, so a change here is a change to
     * how this person signs in. Uniqueness is per organisation, and letting a
     * collision reach the database would surface as an opaque 500 rather than
     * a field error the administrator can act on.
     */
    if (typeof body.email === 'string' && body.email !== target.email) {
      const taken = await prisma.user.findFirst({
        where: { orgId: subject.orgId, email: body.email, deletedAt: null, id: { not: id } },
        select: { id: true },
      });
      if (taken) {
        throw new AppError(ErrorCode.DUPLICATE_RESOURCE, 'Another user already has that email.', {
          fields: { email: 'Already in use in this organisation.' },
        });
      }
    }

    if (body.role !== undefined) {
      if (!canAssignRole(subject, body.role as Role)) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          `You cannot grant the ${toDisplayString(body.role)} role.`,
        );
      }
      // Changing a role changes what their existing access tokens assert, so
      // the change must invalidate them.
      if (body.role !== target.role) {
        await revokeUserTokens(target.id, 'role changed');
      }
    }

    if (body.status !== undefined && body.status !== target.status) {
      if (
        !canManageUser(subject, {
          role: target.role as Role,
          orgId: target.orgId,
          userId: target.id,
        })
      ) {
        throw new AppError(ErrorCode.PERMISSION_DENIED, "You cannot change this user's status.");
      }
      if (body.status !== 'ACTIVE') {
        await revokeUserTokens(target.id, `status changed to ${toDisplayString(body.status)}`);
      }
    }

    // Permission overrides must name real permissions, or an operator will
    // believe they granted something they did not.
    for (const key of ['extraPermissions', 'revokedPermissions'] as const) {
      const list = body[key] as string[] | undefined;
      if (!list) continue;
      const unknown = list.filter((p) => !ALL_PERMISSIONS.includes(p as never));
      if (unknown.length > 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown permission(s) supplied.', {
          fields: { [key]: `Not recognised: ${unknown.slice(0, 5).join(', ')}` },
        });
      }
    }

    const projectIds = body.projectIds as string[] | undefined;
    delete body.projectIds;

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id },
        data: body as Prisma.UserUncheckedUpdateInput,
        select: userSelect,
      });

      if (projectIds) {
        await tx.projectMember.deleteMany({ where: { userId: id } });
        if (projectIds.length > 0) {
          await tx.projectMember.createMany({
            data: projectIds.map((projectId) => ({ projectId, userId: id })),
            skipDuplicates: true,
          });
        }
      }

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_UPDATED',
          entity: 'User',
          entityId: id,
          changes: { before: { role: target.role, status: target.status }, after: body } as never,
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      // A renamed or re-roled colleague must reach devices too, or a phone
      // keeps showing the old name against every job they touched.
      await publishUser(tx, subject.orgId, id, 'UPDATE', subject);

      return user;
    });

    res.json({ data: updated });
  }),
);

/**
 * Everything that constitutes "this person has used the system".
 *
 * The deciding question for a permanent delete. Each of these is either
 * evidence somebody relies on later or a row whose foreign key would be
 * silently nulled: an inspection's `assignedTo` and `reviewedBy` are
 * `SetNull`, so deleting the user would leave a completed inspection with
 * nobody's name on it — the record would still exist and quietly stop saying
 * who did the work. `createdBy` is `Restrict` and would fail outright.
 */
async function usageOf(userId: string): Promise<Record<string, number>> {
  const [assigned, authored, reviewed, audits, templates, sessions, conflicts] = await Promise.all([
    prisma.inspection.count({ where: { assignedToId: userId } }),
    prisma.inspection.count({ where: { createdById: userId } }),
    prisma.inspection.count({ where: { reviewedById: userId } }),
    prisma.auditLog.count({ where: { userId } }),
    prisma.template.count({ where: { createdById: userId } }),
    prisma.syncSession.count({ where: { userId } }),
    prisma.syncConflictRecord.count({ where: { userId } }),
  ]);

  const counts = {
    assignedInspections: assigned,
    createdInspections: authored,
    reviewedInspections: reviewed,
    auditEntries: audits,
    createdTemplates: templates,
    syncSessions: sessions,
    conflicts,
  };
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/**
 * Set a colleague's password on their behalf.
 *
 * Separate from `PATCH` deliberately: it is the one field whose change must
 * end every session the account has open, and it earns its own audit action so
 * "who reset whose password, and when" is answerable without reading a diff.
 *
 * Exists because this installation has no mail provider. The reset-by-email
 * flow cannot deliver a code, so without this an administrator whose inspector
 * has forgotten their password has no way to help them at all.
 */
router.post(
  '/:id/reset-password',
  requireAuth,
  requirePermission(Permission.USER_UPDATE),
  validate({
    params: z.object({ id: schemas.ulid }),
    body: z.object({ password: z.string().min(1).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };
    const { password } = req.validated!.body as { password: string };

    const target = await prisma.user.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true, role: true, orgId: true, email: true, firstName: true, lastName: true },
    });
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, 'That user was not found.');

    if (
      !canManageUser(subject, { role: target.role as Role, orgId: target.orgId, userId: target.id })
    ) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        target.id === subject.userId
          ? 'Change your own password from your account settings.'
          : 'You cannot reset the password for a user at or above your own level.',
      );
    }

    // The same policy the owner would face changing it themselves — an
    // administrator-set password must not be the one weak password in the org.
    const strength = checkPasswordStrength(password, DEFAULT_PASSWORD_POLICY, {
      email: target.email,
      firstName: target.firstName,
      lastName: target.lastName,
    });
    if (!strength.valid) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
        fields: { password: strength.errors.join(' ') },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          passwordHash: await hashPassword(password),
          // Read by the auth middleware to reject access tokens minted before
          // this moment; without it the old session survives its full lifetime.
          passwordChangedAt: new Date(),
          // Somebody else chose it, and it travelled out of band.
          mustChangePassword: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'AUTH_PASSWORD_RESET',
          entity: 'User',
          entityId: id,
          // Records that it happened and to whom, never the value.
          metadata: { email: target.email, resetBy: subject.userId },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });
    });

    // Outside the transaction: the old credential must stop working even if
    // token revocation is slow, and it must not be able to roll the reset back.
    await revokeUserTokens(id, 'password reset by an administrator');

    res.json({ data: { reset: true, email: target.email } });
  }),
);

/**
 * Permanently delete a colleague who never used the system.
 *
 * Refused the moment there is anything to preserve. A compliance record whose
 * inspector row has been deleted still exists, but it no longer says who
 * carried out the inspection — that is not a tidier database, it is a broken
 * audit trail. `usageOf` decides, and its reasons are returned so the refusal
 * is actionable rather than a flat no.
 *
 * The legitimate case this serves is narrow and real: an account created with
 * a typo in the email, five minutes ago, that nobody has touched.
 */
router.delete(
  '/:id/permanent',
  requireAuth,
  requirePermission(Permission.USER_DEACTIVATE),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const target = await prisma.user.findFirst({
      where: { id, orgId: subject.orgId },
      select: { id: true, role: true, orgId: true, email: true },
    });
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, 'That user was not found.');

    if (
      !canManageUser(subject, { role: target.role as Role, orgId: target.orgId, userId: target.id })
    ) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You cannot delete this user.');
    }

    const usage = await usageOf(id);
    if (Object.keys(usage).length > 0) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'This person has a history in the system and cannot be permanently deleted. Deactivate them instead — their record stays on the work they did.',
        { fields: Object.fromEntries(Object.entries(usage).map(([k, n]) => [k, String(n)])) },
      );
    }

    await prisma.$transaction(async (tx) => {
      /*
       * The audit entry is written before the row goes, and deliberately
       * carries the email rather than only the id: once the user is gone the
       * id resolves to nothing, and "who was deleted" is the single thing
       * anyone will want to know afterwards.
       */
      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_DELETED',
          entity: 'User',
          entityId: id,
          metadata: { email: target.email, permanent: true, hadHistory: false },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      // Devices, tokens, memberships and notifications all cascade.
      await tx.user.delete({ where: { id } });
    });

    // Devices replay the change log; without this the person stays on every
    // phone in the organisation forever.
    await recordChange(prisma, {
      orgId: subject.orgId,
      entity: SyncEntity.USER,
      operation: SyncOperation.DELETE,
      entityId: id,
      version: 0,
      row: null,
      actorUserId: subject.userId,
      actorDeviceId: subject.deviceId,
    });

    res.status(204).end();
  }),
);

/** Deactivate. Never a hard delete — audit trails reference the user id. */
router.delete(
  '/:id',
  requireAuth,
  requirePermission(Permission.USER_DEACTIVATE),
  validate({ params: z.object({ id: schemas.ulid }) }),
  asyncHandler(async (req, res) => {
    const subject = auth(req);
    const { id } = req.validated!.params as { id: string };

    const target = await prisma.user.findFirst({
      where: { id, orgId: subject.orgId, deletedAt: null },
      select: { id: true, role: true, orgId: true, email: true },
    });
    if (!target) throw new AppError(ErrorCode.NOT_FOUND, 'That user was not found.');

    if (
      !canManageUser(subject, { role: target.role as Role, orgId: target.orgId, userId: target.id })
    ) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'You cannot deactivate this user.');
    }

    // Work assigned to a departing user must be reassigned, not orphaned.
    const openWork = await prisma.inspection.count({
      where: {
        assignedToId: id,
        deletedAt: null,
        status: { in: ['DRAFT', 'SCHEDULED', 'IN_PROGRESS', 'REJECTED'] },
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { status: 'DEACTIVATED' } });
      await tx.device.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'user deactivated', pushToken: null },
      });
      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId: subject.orgId,
          userId: subject.userId,
          action: 'RECORD_DELETED',
          entity: 'User',
          entityId: id,
          metadata: { email: target.email, openWorkReassignmentRequired: openWork },
          ipAddress: clientIp(req),
          requestId: req.requestId,
        },
      });

      // A DEACTIVATED status replicated as an UPDATE, not a DELETE: the row
      // has to stay on the device so historical work still shows who did it.
      await publishUser(tx, subject.orgId, id, 'UPDATE', subject);
    });

    await revokeUserTokens(id, 'user deactivated');

    res.json({
      data: {
        deactivated: true,
        openInspections: openWork,
        warning:
          openWork > 0
            ? `${openWork} open inspection(s) are still assigned to this user and should be reassigned.`
            : null,
      },
    });
  }),
);

/** The permission catalogue and role matrix, for the admin UI's role editor. */
router.get(
  '/meta/roles',
  requireAuth,
  requirePermission(Permission.USER_READ),
  asyncHandler(async (req, res) => {
    const subject = auth(req);

    res.json({
      data: {
        roles: (Object.keys(ROLE_PERMISSIONS) as Role[]).map((role) => ({
          role,
          rank: ROLE_RANK[role],
          permissions: ROLE_PERMISSIONS[role],
          // Tells the UI which roles to grey out rather than letting the user
          // discover the restriction by getting a 403.
          assignable: canAssignRole(subject, role),
        })),
        permissions: ALL_PERMISSIONS,
      },
    });
  }),
);

export { router as usersRouter };
