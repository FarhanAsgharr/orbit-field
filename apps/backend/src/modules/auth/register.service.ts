/**
 * Self-service registration.
 *
 * Creates an organisation and its first administrator in one transaction. Two
 * decisions worth stating:
 *
 *  1. **The creator becomes ADMIN, not SUPER_ADMIN.** SUPER_ADMIN can act across
 *     organisations in a shared install; handing it out at signup would let
 *     anyone who registers reach every tenant.
 *  2. **A starter checklist is seeded.** Without one, a new organisation is a
 *     dead end — the inspector opens the app, taps "Start an inspection", and
 *     finds nothing to start. The template is deliberately generic and
 *     immediately editable.
 *
 * Registration is gated by `ALLOW_SELF_SERVICE_SIGNUP`. A single-customer
 * deployment normally turns it off and creates accounts by invitation.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import type { AuthSession, DeviceInfo } from '@orbit/types';
import { ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { prisma } from '../../db/prisma.js';
import { checkPasswordStrength, DEFAULT_PASSWORD_POLICY, hashPassword } from '../../lib/crypto.js';
import { sendWelcomeEmail } from '../email/email.service.js';
import type { RequestMeta } from './auth.service.js';

/**
 * URL-safe slug from an organisation name, uniquified against the database.
 *
 * The slug is user-visible in exports and future subdomain routing, so it is
 * derived from the name rather than random — but it must be unique, and two
 * companies called "Northwind" is a normal thing to happen.
 */
async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'organisation';

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await prisma.organization.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  // Fifty collisions on one name is not a real scenario; falling back to a
  // random suffix beats failing the signup.
  return `${base}-${ulid().slice(-6).toLowerCase()}`;
}

/**
 * A minimal but genuinely usable checklist.
 *
 * Exercises the pieces a new user needs to see working — a gate question that
 * reveals a follow-up, a photo field, a signature — so the product demonstrates
 * itself rather than presenting an empty builder.
 */
function starterTemplate(versionId: string): {
  definition: Prisma.InputJsonValue;
  fieldCount: number;
} {
  const sectionId = ulid();
  const gateId = ulid();
  const followUpId = ulid();
  const photoId = ulid();
  const ratingId = ulid();
  const signatureId = ulid();

  const definition = {
    sections: [
      {
        id: sectionId,
        templateVersionId: versionId,
        title: 'General inspection',
        description: 'Edit or replace this checklist to match your own procedure.',
        order: 0,
        logic: [],
        repeatable: false,
        repeatMinInstances: 1,
        repeatMaxInstances: null,
        repeatLabelTemplate: null,
        fields: [
          {
            id: gateId,
            sectionId,
            key: 'condition_satisfactory',
            label: 'Is the condition satisfactory?',
            type: 'PASS_FAIL',
            order: 0,
            weight: 2,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [
              { value: 'pass', label: 'Satisfactory', score: 1 },
              { value: 'fail', label: 'Defect found', score: 0, isFailure: true },
              { value: 'na', label: 'Not applicable', isNotApplicable: true },
            ],
            validation: { required: true },
            ui: {},
            // A failure reveals the description field rather than always showing
            // it — the pattern most inspections actually need.
            logic: [
              {
                id: ulid(),
                when: {
                  kind: 'CONDITION',
                  condition: { fieldId: gateId, operator: 'EQUALS', value: 'fail' },
                },
                effect: { type: 'REVEAL_FOLLOW_UPS' },
              },
            ],
            followUps: [
              {
                id: followUpId,
                sectionId,
                key: 'defect_description',
                label: 'Describe the defect',
                type: 'TEXT_AREA',
                order: 0,
                weight: 1,
                isCritical: false,
                defaultValue: null,
                carryForward: false,
                options: [],
                validation: { required: true, minLength: 10 },
                ui: { placeholder: 'What is wrong, and what should be done about it?' },
                logic: [],
                followUps: [],
              },
            ],
          },
          {
            id: photoId,
            sectionId,
            key: 'evidence_photo',
            label: 'Photograph of the item inspected',
            type: 'PHOTO',
            order: 1,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            validation: { minAttachments: 1, maxAttachments: 5 },
            ui: { camera: { allowGallery: true, watermark: true, annotationEnabled: true } },
            logic: [],
            followUps: [],
          },
          {
            id: ratingId,
            sectionId,
            key: 'overall_rating',
            label: 'Overall condition',
            type: 'RATING',
            order: 2,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            validation: { required: true },
            ui: { ratingMin: 1, ratingMax: 5, ratingIcon: 'STAR' },
            logic: [],
            followUps: [],
          },
          {
            id: signatureId,
            sectionId,
            key: 'inspector_signature',
            label: 'Inspector',
            type: 'SIGNATURE',
            order: 3,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            validation: { required: true, minAttachments: 1 },
            ui: {},
            logic: [],
            followUps: [],
          },
        ],
      },
    ],
  };

  return { definition: definition as unknown as Prisma.InputJsonValue, fieldCount: 5 };
}

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  organizationName: string;
  timezone?: string;
  device: DeviceInfo;
  meta: RequestMeta;
}

export interface RegisterResult {
  organizationId: string;
  userId: string;
  templateId: string;
}

/**
 * Create an organisation and its first administrator.
 *
 * Returns identifiers only. The caller signs the new user in through the normal
 * login path, so there is exactly one place that mints a session.
 */
export async function registerOrganization(input: RegisterInput): Promise<RegisterResult> {
  if (!env.ALLOW_SELF_SERVICE_SIGNUP) {
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'New accounts are created by invitation on this installation. Ask an administrator to invite you.',
    );
  }

  const email = input.email.toLowerCase().trim();
  const organizationName = input.organizationName.trim();

  // Email is unique per organisation, not globally — the same contractor may
  // legitimately hold accounts with two client organisations. But an address
  // already registered anywhere is far more likely to be someone who forgot
  // they have an account than a genuine second tenancy, so it is refused with
  // a message that points at sign-in.
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

  const strength = checkPasswordStrength(input.password, DEFAULT_PASSWORD_POLICY, {
    email,
    firstName: input.firstName,
    lastName: input.lastName,
  });
  if (!strength.valid) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, strength.errors[0]!, {
      fields: { password: strength.errors.join(' ') },
    });
  }

  const slug = await uniqueSlug(organizationName);
  const passwordHash = await hashPassword(input.password);

  const orgId = ulid();
  const userId = ulid();
  const templateId = ulid();
  const versionId = ulid();
  const { definition } = starterTemplate(versionId);

  await prisma.$transaction(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        name: organizationName,
        slug,
        timezone: input.timezone ?? 'UTC',
        settings: {
          // Sensible starting policy. Every value is editable from the console's
          // settings screen once the administrator is in.
          requireGpsOnSubmit: false,
          gpsAccuracyThresholdMeters: 50,
          rejectMockedLocations: true,
          sessionIdleTimeoutMinutes: 30,
          deviceBindingEnabled: true,
          maxDevicesPerUser: 5,
          localMediaRetentionDays: 30,
          wifiOnlyMediaSync: true,
          photoCompressionQuality: 0.72,
          photoWatermarkEnabled: true,
          passwordPolicy: DEFAULT_PASSWORD_POLICY,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await tx.user.create({
      data: {
        id: userId,
        orgId,
        email,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        passwordHash,
        passwordChangedAt: new Date(),
        // ADMIN, never SUPER_ADMIN: the latter can reach across organisations
        // in a shared install, which nobody should acquire by signing up.
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerifiedAt: null,
        timezone: input.timezone ?? null,
      },
    });

    await tx.template.create({
      data: {
        id: templateId,
        orgId,
        name: 'General inspection',
        description: 'A starter checklist. Edit it, clone it, or replace it entirely.',
        category: 'General',
        defaultPriority: 'NORMAL',
        activeVersionId: versionId,
        createdById: userId,
      },
    });

    await tx.templateVersion.create({
      data: {
        id: versionId,
        templateId,
        orgId,
        version: 1,
        definition,
        scoring: {
          enabled: true,
          passThreshold: 80,
          observationThreshold: 60,
          criticalFailureForcesFail: true,
          excludeNotApplicable: true,
        } as Prisma.InputJsonValue,
        requiredSignatures: ['INSPECTOR'],
        // Published immediately: an unpublished starter template would leave the
        // new user with the same empty-state problem it exists to solve.
        publishedAt: new Date(),
        publishedById: userId,
        changeNote: 'Starter checklist created with the organisation.',
      },
    });

    // The published template must reach devices, so it needs a change-log entry
    // and a cursor like any other replicated row.
    const cursorRows = await tx.$queryRaw<Array<{ sync_sequence: bigint }>>`
      UPDATE organizations SET "syncSequence" = "syncSequence" + 1
       WHERE id = ${orgId}
      RETURNING "syncSequence" AS sync_sequence
    `;
    const cursor = cursorRows[0]!.sync_sequence;

    await tx.changeLogEntry.create({
      data: {
        cursor,
        orgId,
        entity: 'TEMPLATE_VERSION',
        operation: 'CREATE',
        entityId: versionId,
        version: 1,
        /*
         * The whole row a device needs to render this checklist, not a pointer
         * to it. A device replays the change log and nothing else, so anything
         * omitted here it simply never has: without `definition` there is no
         * checklist to draw, and without `name` the insert fails outright on a
         * NOT NULL constraint, taking the rest of the delta with it. The
         * display fields come from the parent Template, which is not itself a
         * replicated entity — the device has no table to join against.
         */
        data: {
          id: versionId,
          templateId,
          orgId,
          version: 1,
          name: 'General inspection',
          description: 'A starter checklist. Edit it, clone it, or replace it entirely.',
          category: 'General',
          discipline: null,
          definition,
          scoring: {
            enabled: true,
            passThreshold: 80,
            observationThreshold: 60,
            criticalFailureForcesFail: true,
            excludeNotApplicable: true,
          },
          requiredSignatures: ['INSPECTOR'],
          publishedAt: new Date().toISOString(),
          syncCursor: Number(cursor),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        } as unknown as Prisma.InputJsonValue,
        actorUserId: userId,
      },
    });

    await tx.auditLog.create({
      data: {
        id: ulid(),
        orgId,
        userId,
        action: 'RECORD_CREATED',
        entity: 'Organization',
        entityId: orgId,
        metadata: { organizationName, slug, selfService: true },
        ipAddress: input.meta.ipAddress,
        userAgent: input.meta.userAgent?.slice(0, 400) ?? null,
        requestId: input.meta.requestId,
      },
    });
  });

  // Not awaited for its result beyond logging: the organisation exists either
  // way, and a mail outage must not fail a registration that already committed.
  const mail = await sendWelcomeEmail({
    to: email,
    firstName: input.firstName.trim(),
    organisationName: organizationName,
  });

  logger.info(
    { orgId, userId, slug, welcomeEmailDelivered: mail.delivered },
    'organisation registered',
  );

  return { organizationId: orgId, userId, templateId };
}

export type { AuthSession };
