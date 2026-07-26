/**
 * Development seed.
 *
 * Creates one organisation with a realistic electrical-inspection template, a
 * user per role, and reference data. The template deliberately exercises the
 * hard paths — conditional logic, follow-up questions, critical fields, N/A
 * options, media requirements — so that running the app against this seed
 * surfaces renderer and scoring bugs rather than hiding them behind three
 * trivial text fields.
 */

import type { SyncEntity } from '@orbit/types';
import { Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/** Deterministic ULID-shaped ids so the seed is idempotent and re-runnable. */
function seedId(prefix: string, n: number): string {
  const base = `01JSEED${prefix.toUpperCase()}`.padEnd(20, '0');
  return `${base}${String(n).padStart(6, '0')}`.slice(0, 26);
}

const ORG_ID = seedId('ORG', 1);

/**
 * Publish everything this seed created to the change log.
 *
 * Devices are not fed from the entity tables — they replay the change log and
 * nothing else. A seed that writes rows without log entries produces a database
 * that looks fully populated in the console and completely empty on every
 * phone, which is the most confusing possible starting state.
 *
 * Cursors are allocated in dependency order so a device applying the stream in
 * order never sees an inspection before the site it points at.
 *
 * Returns the last cursor used, so the caller can park the org's sequence above
 * it.
 */
async function publishSeedToChangeLog(): Promise<bigint> {
  // BigInt and Date do not survive JSON.stringify, and Prisma returns both.
  const serialise = (row: unknown): Prisma.InputJsonValue =>
    JSON.parse(
      JSON.stringify(row, (_k, v: unknown) => {
        if (typeof v === 'bigint') return Number(v);
        if (v instanceof Date) return v.toISOString();
        return v;
      }),
    ) as Prisma.InputJsonValue;

  const where = { orgId: ORG_ID } as const;

  // Reference data carries a null assignee, which is what makes it visible to
  // every user; only inspections are scoped to the person who owns them.
  const groups: Array<{ entity: SyncEntity; rows: Array<Record<string, unknown>> }> = [
    { entity: 'ORGANIZATION', rows: await prisma.organization.findMany({ where: { id: ORG_ID } }) },
    { entity: 'USER', rows: await prisma.user.findMany({ where }) },
    { entity: 'CLIENT', rows: await prisma.client.findMany({ where }) },
    { entity: 'PROJECT', rows: await prisma.project.findMany({ where }) },
    { entity: 'SITE', rows: await prisma.site.findMany({ where }) },
    { entity: 'ASSET', rows: await prisma.asset.findMany({ where }) },
    { entity: 'TEMPLATE_VERSION', rows: await prisma.templateVersion.findMany({ where }) },
    { entity: 'INSPECTION', rows: await prisma.inspection.findMany({ where }) },
  ];

  // Re-running the seed must not append a second copy of every entry.
  await prisma.changeLogEntry.deleteMany({ where });

  let cursor = 0n;

  for (const group of groups) {
    for (const row of group.rows) {
      cursor += 1n;

      await prisma.changeLogEntry.create({
        data: {
          cursor,
          orgId: ORG_ID,
          entity: group.entity,
          operation: 'CREATE',
          entityId: row.id as string,
          version: typeof row.version === 'number' ? row.version : 1,
          data: serialise(row),
          projectId: (row.projectId as string | undefined) ?? null,
          assignedToId:
            group.entity === 'INSPECTION' ? ((row.assignedToId as string | null) ?? null) : null,
          actorUserId: null,
          actorDeviceId: null,
        },
      });

      // Keep the row's own cursor consistent with the entry describing it.
      // Support tooling answers "has this device seen this row?" from the
      // entity table, and a stale value there reads as a device left behind.
      // The table name comes from the closed map below, never from input.
      await prisma.$executeRawUnsafe(
        `UPDATE "${CURSOR_TABLES[group.entity]}" SET "syncCursor" = $1 WHERE id = $2`,
        cursor,
        row.id as string,
      );
    }
  }

  console.log(`  Change log   : ${cursor} entries published`);
  return cursor;
}

/** Table per entity, for stamping the allocated cursor back onto the row. */
const CURSOR_TABLES: Record<string, string> = {
  ORGANIZATION: 'organizations',
  USER: 'users',
  CLIENT: 'clients',
  PROJECT: 'projects',
  SITE: 'sites',
  ASSET: 'assets',
  TEMPLATE_VERSION: 'template_versions',
  INSPECTION: 'inspections',
};

async function main(): Promise<void> {
  // This repository is public and the demo password below is published with it.
  // Seeding a production database would therefore create known-credential
  // administrator accounts on a live system. Refusing outright is the only safe
  // behaviour; `SEED_ALLOW_PRODUCTION=1` exists for the rare operator who has
  // genuinely edited the accounts and understands what they are doing.
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== '1') {
    console.error(
      'Refusing to seed a production database.\n' +
        'This seed creates accounts with a password published in the public repository.\n' +
        'Edit the users in seed.ts, then set SEED_ALLOW_PRODUCTION=1 if you are certain.',
    );
    process.exit(1);
  }

  console.log('Seeding Orbit Field…');

  // --- organisation ------------------------------------------------------
  const org = await prisma.organization.upsert({
    where: { id: ORG_ID },
    update: {},
    create: {
      id: ORG_ID,
      name: 'Northwind Utilities',
      slug: 'northwind-utilities',
      timezone: 'Europe/London',
      locale: 'en-GB',
      currency: 'GBP',
      numberPrefix: 'INS',
      settings: {
        requireGpsOnSubmit: true,
        gpsAccuracyThresholdMeters: 50,
        rejectMockedLocations: true,
        sessionIdleTimeoutMinutes: 30,
        deviceBindingEnabled: true,
        // Higher than a realistic production value (3): the E2E harnesses
        // enrol several simulated devices per user in a single run.
        maxDevicesPerUser: 25,
        localMediaRetentionDays: 30,
        wifiOnlyMediaSync: true,
        photoCompressionQuality: 0.72,
        photoWatermarkEnabled: true,
        brandColor: '#1B5CF0',
        reportFooterText: 'Northwind Utilities — Asset Integrity Division',
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

  // --- users -------------------------------------------------------------
  // A single shared development password. Long enough to satisfy the policy the
  // API enforces, so seeded accounts can actually log in.
  const passwordHash = await argon2.hash('OrbitField2026!', {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const people = [
    {
      n: 1,
      role: 'ADMIN' as const,
      first: 'Amara',
      last: 'Osei',
      email: 'admin@northwind.test',
      title: 'Systems Administrator',
    },
    {
      n: 2,
      role: 'MANAGER' as const,
      first: 'Ravi',
      last: 'Chandran',
      email: 'manager@northwind.test',
      title: 'Operations Manager',
    },
    {
      n: 3,
      role: 'SUPERVISOR' as const,
      first: 'Elena',
      last: 'Petrova',
      email: 'supervisor@northwind.test',
      title: 'Field Supervisor',
    },
    {
      n: 4,
      role: 'INSPECTOR' as const,
      first: 'Tom',
      last: 'Whitfield',
      email: 'inspector@northwind.test',
      title: 'Senior Inspector',
    },
    {
      n: 5,
      role: 'INSPECTOR' as const,
      first: 'Priya',
      last: 'Nair',
      email: 'inspector2@northwind.test',
      title: 'Inspector',
    },
    {
      n: 6,
      role: 'TECHNICIAN' as const,
      first: 'Jonas',
      last: 'Berg',
      email: 'technician@northwind.test',
      title: 'Technician',
    },
    {
      n: 7,
      role: 'VIEWER' as const,
      first: 'Sara',
      last: 'Lindqvist',
      email: 'viewer@northwind.test',
      title: 'Compliance Analyst',
    },
  ];

  for (const person of people) {
    await prisma.user.upsert({
      where: { id: seedId('USR', person.n) },
      update: {},
      create: {
        id: seedId('USR', person.n),
        orgId: org.id,
        email: person.email,
        emailVerifiedAt: new Date(),
        firstName: person.first,
        lastName: person.last,
        passwordHash,
        passwordChangedAt: new Date(),
        role: person.role,
        status: 'ACTIVE',
        jobTitle: person.title,
        department: 'Asset Integrity',
        timezone: 'Europe/London',
      },
    });
  }

  // --- reference data ----------------------------------------------------
  const client = await prisma.client.upsert({
    where: { id: seedId('CLI', 1) },
    update: {},
    create: {
      id: seedId('CLI', 1),
      orgId: org.id,
      name: 'Meridian Property Group',
      code: 'MPG',
      contactName: 'Helen Marsh',
      contactEmail: 'h.marsh@meridian.test',
      contactPhone: '+44 20 7946 0102',
      address: '18 Bishopsgate, London EC2N 4BQ',
    },
  });

  const project = await prisma.project.upsert({
    where: { id: seedId('PRJ', 1) },
    update: {},
    create: {
      id: seedId('PRJ', 1),
      orgId: org.id,
      clientId: client.id,
      name: 'Meridian Estate — Annual Electrical Compliance',
      code: 'MPG-2026-EC',
      description: 'Fixed-wiring inspection and testing across the Meridian portfolio.',
      managerId: seedId('USR', 2),
      startDate: new Date('2026-01-06'),
      endDate: new Date('2026-12-18'),
    },
  });

  const sites = [
    { n: 1, name: 'Bishopsgate Tower — Plant Room B2', lat: 51.5155, lon: -0.0812, radius: 120 },
    { n: 2, name: 'Croydon Distribution Centre', lat: 51.3762, lon: -0.0982, radius: 250 },
    { n: 3, name: 'Reading Substation 4', lat: 51.4543, lon: -0.9781, radius: 80 },
  ];

  for (const site of sites) {
    await prisma.site.upsert({
      where: { id: seedId('SIT', site.n) },
      update: {},
      create: {
        id: seedId('SIT', site.n),
        orgId: org.id,
        projectId: project.id,
        clientId: client.id,
        name: site.name,
        code: `SITE-${site.n}`,
        latitude: site.lat,
        longitude: site.lon,
        geofenceRadiusMeters: site.radius,
        timezone: 'Europe/London',
      },
    });
  }

  await prisma.asset.upsert({
    where: { id: seedId('AST', 1) },
    update: {},
    create: {
      id: seedId('AST', 1),
      orgId: org.id,
      siteId: seedId('SIT', 1),
      name: 'Main LV Distribution Board',
      tag: 'MPG-B2-DB01',
      category: 'Distribution Board',
      manufacturer: 'Schneider Electric',
      model: 'Prisma iPM',
      serialNumber: 'SE-2019-887431',
      installedAt: new Date('2019-04-11'),
    },
  });

  // --- template ----------------------------------------------------------
  const templateId = seedId('TPL', 1);
  const versionId = seedId('TPV', 1);

  const S1 = seedId('SEC', 1);
  const S2 = seedId('SEC', 2);
  const F = (n: number): string => seedId('FLD', n);

  const definition = {
    sections: [
      {
        id: S1,
        templateVersionId: versionId,
        title: 'Site & supply particulars',
        description: 'Record the supply characteristics before any testing begins.',
        order: 0,
        logic: [],
        repeatable: false,
        repeatMinInstances: 1,
        repeatMaxInstances: null,
        repeatLabelTemplate: null,
        fields: [
          {
            id: F(1),
            sectionId: S1,
            key: 'safe_to_proceed',
            label: 'Is it safe to proceed with the inspection?',
            type: 'YES_NO',
            order: 0,
            weight: 1,
            isCritical: true,
            defaultValue: null,
            carryForward: false,
            options: [
              { value: 'yes', label: 'Yes', score: 1 },
              { value: 'no', label: 'No — work halted', score: 0, isFailure: true },
            ],
            validation: { required: true },
            ui: { helpText: 'If conditions are unsafe, stop and record why below.' },
            // A "no" reveals the reason field and blocks submission entirely.
            logic: [
              {
                id: 'r1',
                when: {
                  kind: 'CONDITION',
                  condition: { fieldId: F(1), operator: 'EQUALS', value: 'no' },
                },
                effect: { type: 'REVEAL_FOLLOW_UPS' },
              },
            ],
            followUps: [
              {
                id: F(2),
                sectionId: S1,
                key: 'halt_reason',
                label: 'Describe the hazard that prevented work',
                type: 'TEXT_AREA',
                order: 0,
                weight: 1,
                isCritical: false,
                defaultValue: null,
                carryForward: false,
                options: [],
                ui: {},
                logic: [],
                followUps: [],
                validation: { required: true, minLength: 20 },
              },
            ],
          },
          {
            id: F(3),
            sectionId: S1,
            key: 'supply_voltage',
            label: 'Measured supply voltage (V)',
            type: 'NUMBER',
            order: 1,
            weight: 2,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            followUps: [],
            // Acceptable band per BS 7671: 230 V +10% / −6%.
            validation: { required: true, min: 216, max: 253, precision: 1 },
            ui: { helpText: 'Nominal 230 V. Acceptable range 216–253 V.' },
            logic: [
              {
                id: 'r2',
                when: {
                  kind: 'CONDITION',
                  condition: { fieldId: F(3), operator: 'GREATER_THAN', value: 253 },
                },
                effect: {
                  type: 'BLOCK_SUBMIT',
                  message:
                    'Supply voltage exceeds the statutory limit. Escalate before submitting.',
                },
              },
            ],
          },
          {
            id: F(4),
            sectionId: S1,
            key: 'earthing_system',
            label: 'Earthing arrangement',
            type: 'DROPDOWN',
            order: 2,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: true,
            followUps: [],
            logic: [],
            ui: {},
            validation: { required: true },
            options: [
              { value: 'tn-s', label: 'TN-S' },
              { value: 'tn-c-s', label: 'TN-C-S (PME)' },
              { value: 'tt', label: 'TT' },
              { value: 'it', label: 'IT' },
            ],
          },
          {
            id: F(5),
            sectionId: S1,
            key: 'site_location',
            label: 'Confirm your location on site',
            type: 'GPS',
            order: 3,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            followUps: [],
            logic: [],
            ui: {},
            validation: { required: true, requiredGpsAccuracyMeters: 50 },
          },
        ],
      },
      {
        id: S2,
        templateVersionId: versionId,
        title: 'Distribution board condition',
        description: null,
        order: 1,
        repeatable: false,
        repeatMinInstances: 1,
        repeatMaxInstances: null,
        repeatLabelTemplate: null,
        // The whole section is irrelevant if work was halted.
        logic: [
          {
            id: 'sec2-hide',
            when: {
              kind: 'CONDITION',
              condition: { fieldId: F(1), operator: 'EQUALS', value: 'no' },
            },
            effect: { type: 'HIDE' },
          },
        ],
        fields: [
          {
            id: F(6),
            sectionId: S2,
            key: 'enclosure_condition',
            label: 'Enclosure condition and IP rating intact',
            type: 'PASS_FAIL',
            order: 0,
            weight: 2,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            followUps: [
              {
                id: F(7),
                sectionId: S2,
                key: 'enclosure_defect_photo',
                label: 'Photograph the defect',
                type: 'PHOTO',
                order: 0,
                weight: 1,
                isCritical: false,
                defaultValue: null,
                carryForward: false,
                options: [],
                logic: [],
                followUps: [],
                validation: {
                  required: true,
                  minAttachments: 1,
                  maxAttachments: 5,
                  requiredGpsAccuracyMeters: 100,
                },
                ui: { camera: { allowGallery: false, watermark: true, annotationEnabled: true } },
              },
            ],
            options: [
              { value: 'pass', label: 'Satisfactory', score: 1 },
              { value: 'fail', label: 'Defect found', score: 0, isFailure: true },
              { value: 'na', label: 'Not applicable', isNotApplicable: true },
            ],
            validation: { required: true },
            ui: {},
            logic: [
              {
                id: 'r3',
                when: {
                  kind: 'CONDITION',
                  condition: { fieldId: F(6), operator: 'EQUALS', value: 'fail' },
                },
                effect: { type: 'REVEAL_FOLLOW_UPS' },
              },
            ],
          },
          {
            id: F(8),
            sectionId: S2,
            key: 'rcd_trip_time',
            label: 'RCD trip time at IΔn (ms)',
            type: 'NUMBER',
            order: 1,
            weight: 3,
            isCritical: true,
            defaultValue: null,
            carryForward: false,
            options: [],
            followUps: [],
            ui: { helpText: 'Must not exceed 300 ms for a 30 mA RCD.' },
            validation: { required: true, min: 0, max: 300, precision: 1 },
            logic: [],
          },
          {
            id: F(9),
            sectionId: S2,
            key: 'defect_categories',
            label: 'Observed defect categories',
            type: 'MULTI_SELECT',
            order: 2,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            followUps: [],
            logic: [],
            ui: {},
            validation: {},
            options: [
              { value: 'c1', label: 'C1 — Danger present', score: 0, isFailure: true },
              { value: 'c2', label: 'C2 — Potentially dangerous', score: 0, isFailure: true },
              { value: 'c3', label: 'C3 — Improvement recommended' },
              { value: 'fi', label: 'FI — Further investigation required' },
            ],
          },
          {
            id: F(10),
            sectionId: S2,
            key: 'overall_rating',
            label: 'Overall condition rating',
            type: 'RATING',
            order: 3,
            weight: 2,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            followUps: [],
            logic: [],
            validation: { required: true },
            ui: { ratingMin: 1, ratingMax: 5, ratingIcon: 'STAR' },
          },
          {
            id: F(11),
            sectionId: S2,
            key: 'inspector_signature',
            label: 'Inspector',
            type: 'SIGNATURE',
            order: 4,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [],
            followUps: [],
            logic: [],
            ui: {},
            validation: { required: true, minAttachments: 1 },
          },
        ],
      },
    ],
  };

  await prisma.template.upsert({
    where: { id: templateId },
    update: {},
    create: {
      id: templateId,
      orgId: org.id,
      name: 'Electrical Installation Condition Report (EICR)',
      description: 'Periodic inspection and testing of a fixed electrical installation to BS 7671.',
      category: 'Electrical',
      discipline: 'ELECTRICAL',
      defaultPriority: 'HIGH',
      activeVersionId: versionId,
      createdById: seedId('USR', 2),
    },
  });

  await prisma.templateVersion.upsert({
    where: { id: versionId },
    update: {},
    create: {
      id: versionId,
      templateId,
      orgId: org.id,
      version: 1,
      definition: definition as never,
      scoring: {
        enabled: true,
        passThreshold: 80,
        observationThreshold: 60,
        criticalFailureForcesFail: true,
        excludeNotApplicable: true,
      },
      requiredSignatures: ['INSPECTOR'],
      publishedAt: new Date(),
      publishedById: seedId('USR', 2),
      changeNote: 'Initial published version.',
    },
  });

  // --- a couple of assigned inspections ----------------------------------
  for (let i = 1; i <= 3; i++) {
    const cursor = BigInt(i);
    await prisma.inspection.upsert({
      where: { id: seedId('INS', i) },
      update: {},
      create: {
        id: seedId('INS', i),
        orgId: org.id,
        number: `INS-2026-${String(i).padStart(6, '0')}`,
        templateId,
        templateVersionId: versionId,
        projectId: project.id,
        clientId: client.id,
        siteId: seedId('SIT', ((i - 1) % 3) + 1),
        assetId: i === 1 ? seedId('AST', 1) : null,
        title: `EICR — ${sites[(i - 1) % 3]!.name}`,
        status: i === 1 ? 'IN_PROGRESS' : 'SCHEDULED',
        priority: i === 1 ? 'HIGH' : 'NORMAL',
        assignedToId: seedId('USR', 4),
        createdById: seedId('USR', 2),
        scheduledFor: new Date(Date.now() + i * 86_400_000),
        dueAt: new Date(Date.now() + i * 3 * 86_400_000),
        syncCursor: cursor,
      },
    });
  }

  const cursor = await publishSeedToChangeLog();

  // The org's sequence must sit above every cursor handed out, or the next
  // allocation would collide with a seeded row.
  await prisma.organization.update({
    where: { id: org.id },
    data: { syncSequence: cursor, numberSequence: 3, numberYear: new Date().getFullYear() },
  });

  console.log('Seed complete.');
  console.log('  Organisation : Northwind Utilities');
  console.log('  Users        : admin@northwind.test … inspector@northwind.test');
  console.log('  Password     : OrbitField2026!');
  console.log(`  Template     : EICR v1 (${definition.sections.length} sections)`);
  console.log('  Inspections  : 3 assigned to inspector@northwind.test');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
