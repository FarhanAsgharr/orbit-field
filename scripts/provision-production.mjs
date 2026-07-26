/**
 * One-time production provisioning.
 *
 * Creates the first administrator on an installation where self-service signup
 * is disabled, plus a demo organisation an inspector can actually work in.
 *
 * This is deliberately NOT `prisma/seed.ts`. That script refuses to run against
 * production, and correctly so: it creates accounts whose password is published
 * in this repository. This script takes its credentials from the environment
 * instead, so nothing it writes is guessable from the source alone.
 *
 * What it creates, in dependency order:
 *
 *   organisation → SUPER_ADMIN → INSPECTOR → client → project → membership
 *   → site → asset → template + published version → 3 assigned inspections
 *
 * Then it publishes every row to the change log. That last step is not
 * optional: devices replay the change log and nothing else, so rows written
 * without log entries produce a database that looks full in the console and
 * completely empty on every phone.
 *
 * Idempotent by email — re-running reports what already exists and changes
 * nothing, so a partial failure can be retried safely.
 *
 * Usage:
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… INSPECTOR_EMAIL=… INSPECTOR_PASSWORD=… \
 *   DATABASE_URL=… DIRECT_URL=… node scripts/provision-production.mjs
 */

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/* Matches ARGON_OPTIONS in apps/backend/src/lib/crypto.ts — OWASP's 2024
 * Argon2id baseline. argon2.verify reads parameters from the hash itself, so a
 * mismatch would still verify; keeping them equal means these hashes are
 * indistinguishable from ones the API mints on password change. */
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/* Crockford base32, 26 chars, matching packages/utils and the mobile client.
 * Ids are client-generatable by design — see the schema header. */
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let counter = 0;
function ulid() {
  const now = Date.now();
  if (now === lastTime) counter += 1;
  else {
    lastTime = now;
    counter = 0;
  }
  let time = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENC[Math.floor(Math.random() * 32)];
  return (time + rand).slice(0, 25) + ENC[counter % 32];
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * The API's own policy, reimplemented rather than imported.
 *
 * `checkPasswordStrength` lives in the backend's TypeScript source and pulls in
 * the whole env-validation chain when imported. Duplicating the rules here
 * keeps the script standalone; the point is to fail loudly now rather than let
 * an administrator discover at their first password change that their password
 * was never policy-compliant.
 */
/**
 * Passwords published in this repository.
 *
 * `prisma/seed.ts` and the e2e scripts contain a working password in plain
 * text, and this repository is readable. A production account using one of them
 * has no password at all — anybody who can read the source can sign in. It was
 * used on a live SUPER_ADMIN once; refusing it here is what stops that being a
 * decision somebody has to remember to make.
 */
const PUBLISHED_PASSWORDS = new Set(['OrbitField2026!', 'orbit_dev_password', 'password']);

function checkPassword(password, { email, firstName, lastName }) {
  const errors = [];
  if (PUBLISHED_PASSWORDS.has(password)) {
    errors.push('is published in this repository and must never be used on a real install');
  }
  if (password.length < 12) errors.push('must be at least 12 characters');
  if (!/[A-Z]/.test(password)) errors.push('must contain an uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('must contain a lowercase letter');
  if (!/\d/.test(password)) errors.push('must contain a number');
  const lower = password.toLowerCase();
  for (const [label, value] of Object.entries({ email, firstName, lastName })) {
    if (!value || value.length < 3) continue;
    if (lower.includes(value.toLowerCase().split('@')[0])) {
      errors.push(`must not contain your ${label}`);
      break;
    }
  }
  return errors;
}

/** A checklist that exercises the paths worth proving: a gate question that
 *  reveals a follow-up, a photo field, a rating, a signature. */
function templateDefinition(versionId) {
  const sectionId = ulid();
  const gateId = ulid();

  return {
    sections: [
      {
        id: sectionId,
        templateVersionId: versionId,
        title: 'General inspection',
        description: 'Demo checklist. Edit or replace it to match your own procedure.',
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
                id: ulid(),
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
            id: ulid(),
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
            id: ulid(),
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
            id: ulid(),
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
}

/** Table per entity, for stamping the allocated cursor back onto the row. */
const CURSOR_TABLES = {
  ORGANIZATION: 'organizations',
  USER: 'users',
  CLIENT: 'clients',
  PROJECT: 'projects',
  SITE: 'sites',
  ASSET: 'assets',
  TEMPLATE_VERSION: 'template_versions',
  INSPECTION: 'inspections',
};

/**
 * Publish everything to the change log in dependency order.
 *
 * Order matters: a device applying the stream sequentially must never meet an
 * inspection before the site it points at.
 */
async function publishToChangeLog(orgId) {
  const serialise = (row) =>
    JSON.parse(
      JSON.stringify(row, (_k, v) => {
        if (typeof v === 'bigint') return Number(v);
        if (v instanceof Date) return v.toISOString();
        return v;
      }),
    );

  const where = { orgId };
  const groups = [
    { entity: 'ORGANIZATION', rows: await prisma.organization.findMany({ where: { id: orgId } }) },
    { entity: 'USER', rows: await prisma.user.findMany({ where }) },
    { entity: 'CLIENT', rows: await prisma.client.findMany({ where }) },
    { entity: 'PROJECT', rows: await prisma.project.findMany({ where }) },
    { entity: 'SITE', rows: await prisma.site.findMany({ where }) },
    { entity: 'ASSET', rows: await prisma.asset.findMany({ where }) },
    // Display fields live on the parent Template, which devices do not
    // replicate. They must travel with the version: the device has no
    // `templates` table to join against, and a null `name` fails a NOT NULL
    // constraint that aborts the rest of the delta with it.
    {
      entity: 'TEMPLATE_VERSION',
      rows: (await prisma.templateVersion.findMany({ where, include: { template: true } })).map(
        ({ template, ...version }) => ({
          ...version,
          name: template.name,
          description: template.description,
          category: template.category,
          discipline: template.discipline,
        }),
      ),
    },
    { entity: 'INSPECTION', rows: await prisma.inspection.findMany({ where }) },
  ];

  await prisma.changeLogEntry.deleteMany({ where });

  let cursor = 0n;
  for (const group of groups) {
    for (const row of group.rows) {
      cursor += 1n;
      await prisma.changeLogEntry.create({
        data: {
          cursor,
          orgId,
          entity: group.entity,
          operation: 'CREATE',
          entityId: row.id,
          version: typeof row.version === 'number' ? row.version : 1,
          data: serialise(row),
          projectId: row.projectId ?? null,
          // Reference data carries a null assignee, which is what makes it
          // visible to every user; only inspections are scoped to their owner.
          assignedToId: group.entity === 'INSPECTION' ? (row.assignedToId ?? null) : null,
          actorUserId: null,
          actorDeviceId: null,
        },
      });

      // Keep the row's own cursor consistent with the entry describing it, or
      // support tooling reads the row as a device left behind.
      await prisma.$executeRawUnsafe(
        `UPDATE "${CURSOR_TABLES[group.entity]}" SET "syncCursor" = $1 WHERE id = $2`,
        cursor,
        row.id,
      );
    }
  }

  return cursor;
}

async function main() {
  const adminEmail = required('ADMIN_EMAIL').toLowerCase().trim();
  const adminPassword = required('ADMIN_PASSWORD');
  const inspectorEmail = required('INSPECTOR_EMAIL').toLowerCase().trim();
  const inspectorPassword = required('INSPECTOR_PASSWORD');

  const admin = { first: 'System', last: 'Administrator' };
  const inspector = { first: 'Demo', last: 'Inspector' };

  for (const [who, email, password, names] of [
    ['admin', adminEmail, adminPassword, admin],
    ['inspector', inspectorEmail, inspectorPassword, inspector],
  ]) {
    const errors = checkPassword(password, {
      email,
      firstName: names.first,
      lastName: names.last,
    });
    if (errors.length) {
      console.error(`${who} password rejected by policy: ${errors.join('; ')}`);
      process.exit(1);
    }
  }

  const existing = await prisma.user.findFirst({
    where: { email: { in: [adminEmail, inspectorEmail] }, deletedAt: null },
    select: { id: true, email: true, role: true, orgId: true },
  });
  if (existing) {
    console.log('Already provisioned — nothing to do.');
    console.log(`  Found ${existing.email} (${existing.role}) in org ${existing.orgId}`);
    return;
  }

  const orgId = ulid();
  const adminId = ulid();
  const inspectorId = ulid();
  const clientId = ulid();
  const projectId = ulid();
  const siteId = ulid();
  const assetId = ulid();
  const templateId = ulid();
  const versionId = ulid();
  const year = new Date().getFullYear();

  const [adminHash, inspectorHash] = await Promise.all([
    argon2.hash(adminPassword, ARGON_OPTIONS),
    argon2.hash(inspectorPassword, ARGON_OPTIONS),
  ]);

  await prisma.$transaction(
    async (tx) => {
      await tx.organization.create({
        data: {
          id: orgId,
          name: 'Orbit Field Demo',
          slug: 'orbit-field-demo',
          timezone: 'UTC',
          numberPrefix: 'INS',
          numberYear: year,
          numberSequence: 3,
          settings: {
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
            passwordPolicy: {
              minLength: 12,
              requireUppercase: true,
              requireLowercase: true,
              requireNumber: true,
              requireSymbol: false,
              historyDepth: 5,
              maxAgeDays: 0,
            },
          },
        },
      });

      await tx.user.create({
        data: {
          id: adminId,
          orgId,
          email: adminEmail,
          emailVerifiedAt: new Date(),
          firstName: admin.first,
          lastName: admin.last,
          passwordHash: adminHash,
          passwordChangedAt: new Date(),
          role: 'SUPER_ADMIN',
          status: 'ACTIVE',
          // Chosen by whoever ran this script, not by the account's owner, and
          // passed along out of band — so it is a shared credential until they
          // replace it, and every client is told to force that.
          mustChangePassword: true,
          jobTitle: 'Platform Administrator',
          timezone: 'UTC',
        },
      });

      await tx.user.create({
        data: {
          id: inspectorId,
          orgId,
          email: inspectorEmail,
          emailVerifiedAt: new Date(),
          firstName: inspector.first,
          lastName: inspector.last,
          passwordHash: inspectorHash,
          passwordChangedAt: new Date(),
          role: 'INSPECTOR',
          status: 'ACTIVE',
          mustChangePassword: true,
          jobTitle: 'Field Inspector',
          timezone: 'UTC',
        },
      });

      await tx.client.create({
        data: {
          id: clientId,
          orgId,
          name: 'Meridian Property Group',
          code: 'MPG',
          contactName: 'Helen Marsh',
          contactEmail: 'h.marsh@meridian.example',
          address: '18 Bishopsgate, London EC2N 4BQ',
        },
      });

      await tx.project.create({
        data: {
          id: projectId,
          orgId,
          clientId,
          name: 'Meridian Portfolio — Annual Compliance',
          code: 'MPG-2026',
          description: 'Demo project covering the annual inspection round.',
          startDate: new Date(),
          managerId: adminId,
          isActive: true,
        },
      });

      // Membership is what puts the project — and its inspections — in the
      // inspector's scope. Without it the assignment exists but is unreachable.
      await tx.projectMember.create({ data: { projectId, userId: inspectorId } });

      await tx.site.create({
        data: {
          id: siteId,
          orgId,
          projectId,
          clientId,
          name: 'Bishopsgate Tower',
          code: 'BGT',
          address: '18 Bishopsgate, London EC2N 4BQ',
          latitude: 51.5155,
          longitude: -0.0819,
          geofenceRadiusMeters: 200,
          timezone: 'Europe/London',
        },
      });

      await tx.asset.create({
        data: {
          id: assetId,
          orgId,
          siteId,
          name: 'Main Distribution Board',
          tag: 'BGT-MDB-01',
          category: 'Electrical',
          manufacturer: 'Schneider',
          model: 'Prisma P',
          serialNumber: 'SN-4471902',
          installedAt: new Date('2019-04-11T00:00:00Z'),
        },
      });

      await tx.template.create({
        data: {
          id: templateId,
          orgId,
          name: 'General inspection',
          description: 'Demo checklist. Edit it, clone it, or replace it entirely.',
          category: 'General',
          defaultPriority: 'NORMAL',
          activeVersionId: versionId,
          createdById: adminId,
        },
      });

      await tx.templateVersion.create({
        data: {
          id: versionId,
          templateId,
          orgId,
          version: 1,
          definition: templateDefinition(versionId),
          scoring: {
            enabled: true,
            passThreshold: 80,
            observationThreshold: 60,
            criticalFailureForcesFail: true,
            excludeNotApplicable: true,
          },
          requiredSignatures: ['INSPECTOR'],
          publishedAt: new Date(),
          publishedById: adminId,
          changeNote: 'Initial published version.',
        },
      });

      for (let i = 1; i <= 3; i++) {
        await tx.inspection.create({
          data: {
            id: ulid(),
            orgId,
            number: `INS-${year}-${String(i).padStart(6, '0')}`,
            templateId,
            templateVersionId: versionId,
            projectId,
            clientId,
            siteId,
            assetId: i === 1 ? assetId : null,
            title: `Annual compliance check — Bishopsgate Tower (${i}/3)`,
            status: i === 1 ? 'IN_PROGRESS' : 'SCHEDULED',
            priority: i === 1 ? 'HIGH' : 'NORMAL',
            assignedToId: inspectorId,
            createdById: adminId,
            scheduledFor: new Date(Date.now() + i * 86_400_000),
            dueAt: new Date(Date.now() + i * 3 * 86_400_000),
          },
        });
      }

      await tx.auditLog.create({
        data: {
          id: ulid(),
          orgId,
          userId: adminId,
          action: 'RECORD_CREATED',
          entity: 'Organization',
          entityId: orgId,
          metadata: {
            organizationName: 'Orbit Field Demo',
            provisionedBy: 'scripts/provision-production.mjs',
            selfService: false,
          },
          ipAddress: null,
          userAgent: null,
          requestId: null,
        },
      });
    },
    { timeout: 30_000 },
  );

  const cursor = await publishToChangeLog(orgId);

  // The org's sequence must sit above every cursor handed out, or the next
  // allocation collides with a row written here.
  await prisma.organization.update({
    where: { id: orgId },
    data: { syncSequence: cursor },
  });

  console.log('Provisioned.');
  console.log(`  Organisation : Orbit Field Demo (${orgId})`);
  console.log(`  SUPER_ADMIN  : ${adminEmail} (${adminId})`);
  console.log(`  INSPECTOR    : ${inspectorEmail} (${inspectorId})`);
  console.log(`  Project      : MPG-2026 (${projectId}), inspector is a member`);
  console.log(`  Site / asset : ${siteId} / ${assetId}`);
  console.log(`  Template     : ${templateId} v1 published (${versionId})`);
  console.log(`  Inspections  : 3 assigned to ${inspectorEmail}`);
  console.log(`  Change log   : ${cursor} entries published`);
}

main()
  .catch((err) => {
    console.error('Provisioning failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
