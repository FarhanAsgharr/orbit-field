/**
 * Test fixtures.
 *
 * Every fixture is scoped to a freshly created organisation. That is what lets
 * suites run in any order and lets a failing test leave nothing behind that
 * breaks the next one — the alternative, a shared seed, means test A's mutation
 * silently changes test B's result and the failure appears somewhere unrelated.
 *
 * Data is created through Prisma rather than through the API, because a fixture
 * that depends on the endpoints under test cannot fail independently of them.
 */

import type { Role } from '@orbit/types';
import { ulid } from '@orbit/utils';

import { prisma } from '../db/prisma.js';
import { hashPassword } from '../lib/crypto.js';
import { strongPassword, unique } from './harness.js';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

export interface TestOrg {
  orgId: string;
  clientId: string;
  projectId: string;
  siteId: string;
  assetId: string;
  templateId: string;
  templateVersionId: string;
  users: Record<string, TestUser>;
  /** Removes the organisation and everything that cascades from it. */
  cleanup: () => Promise<void>;
}

const SECTION_ID = '01TESTSECTION0000000000001';
const FIELD_ID = '01TESTFIELD000000000000001';

/** A minimal but valid published checklist: one required pass/fail field. */
function definition(versionId: string) {
  return {
    sections: [
      {
        id: SECTION_ID,
        templateVersionId: versionId,
        title: 'Test section',
        description: null,
        order: 0,
        logic: [],
        repeatable: false,
        repeatMinInstances: 1,
        repeatMaxInstances: null,
        repeatLabelTemplate: null,
        fields: [
          {
            id: FIELD_ID,
            sectionId: SECTION_ID,
            key: 'condition_ok',
            label: 'Is the condition acceptable?',
            type: 'PASS_FAIL',
            order: 0,
            weight: 1,
            isCritical: false,
            defaultValue: null,
            carryForward: false,
            options: [
              { value: 'pass', label: 'Yes', score: 1 },
              { value: 'fail', label: 'No', score: 0, isFailure: true },
            ],
            validation: { required: true },
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
const CURSOR_TABLES: Record<string, string> = {
  ORGANIZATION: 'organizations',
  USER: 'users',
  CLIENT: 'clients',
  PROJECT: 'projects',
  SITE: 'sites',
  ASSET: 'assets',
  TEMPLATE_VERSION: 'template_versions',
};

/**
 * Publish the fixture to the change log, in dependency order.
 *
 * Not decoration. A device replays the change log and nothing else, so rows
 * written straight through Prisma are invisible to `/sync/pull` — a fixture
 * without this produces a database that looks fully populated to the console
 * and completely empty to every phone, which is exactly the bug this project
 * shipped once already.
 *
 * The template's display fields are merged onto its version for the same reason
 * they are in production: devices hold `template_versions` and no `templates`
 * table, so a bare version row leaves `name` null and the device rejects the
 * whole delta.
 */
async function publishToChangeLog(orgId: string, templateId: string): Promise<void> {
  const serialise = (row: unknown) =>
    JSON.parse(
      JSON.stringify(row, (_k, v: unknown) => {
        if (typeof v === 'bigint') return Number(v);
        if (v instanceof Date) return v.toISOString();
        return v;
      }),
    ) as Record<string, unknown>;

  const template = await prisma.template.findUniqueOrThrow({ where: { id: templateId } });
  const where = { orgId } as const;

  const groups: Array<[string, Array<Record<string, unknown>>]> = [
    ['ORGANIZATION', await prisma.organization.findMany({ where: { id: orgId } })],
    ['USER', await prisma.user.findMany({ where })],
    ['CLIENT', await prisma.client.findMany({ where })],
    ['PROJECT', await prisma.project.findMany({ where })],
    ['SITE', await prisma.site.findMany({ where })],
    ['ASSET', await prisma.asset.findMany({ where })],
    [
      'TEMPLATE_VERSION',
      (await prisma.templateVersion.findMany({ where })).map((version) => ({
        ...version,
        name: template.name,
        description: template.description,
        category: template.category,
        discipline: template.discipline,
      })),
    ],
  ];

  let cursor = 0n;
  for (const [entity, rows] of groups) {
    for (const row of rows) {
      cursor += 1n;
      await prisma.changeLogEntry.create({
        data: {
          cursor,
          orgId,
          entity: entity as never,
          operation: 'CREATE',
          entityId: row.id as string,
          version: typeof row.version === 'number' ? row.version : 1,
          data: serialise(row) as never,
          projectId: (row.projectId as string | undefined) ?? null,
          assignedToId: null,
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "${CURSOR_TABLES[entity]}" SET "syncCursor" = $1 WHERE id = $2`,
        cursor,
        row.id as string,
      );
    }
  }

  // The org sequence must sit above every cursor handed out, or the next
  // allocation collides with a fixture row.
  await prisma.organization.update({ where: { id: orgId }, data: { syncSequence: cursor } });
}

/**
 * Create an organisation with one user per role and usable reference data.
 *
 * Roles are all created up front because most of what is worth testing here is
 * a permission boundary, and asserting that an INSPECTOR is refused is only
 * meaningful next to an ADMIN who is allowed.
 */
export async function createTestOrg(): Promise<TestOrg> {
  const orgId = ulid();
  const slug = unique('test-org');

  await prisma.organization.create({
    data: { id: orgId, name: `Test ${slug}`, slug, timezone: 'UTC', numberPrefix: 'TST' },
  });

  // SUPERVISOR is the role that reviews submitted work, so a fixture without
  // one cannot exercise the half of the workflow that decides whether an
  // inspection is accepted.
  const roles: Role[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SUPERVISOR', 'INSPECTOR', 'VIEWER'];
  const users: Record<string, TestUser> = {};

  for (const role of roles) {
    const password = strongPassword();
    const email = `${unique(role.toLowerCase())}@test.invalid`;
    const id = ulid();
    await prisma.user.create({
      data: {
        id,
        orgId,
        email,
        emailVerifiedAt: new Date(),
        firstName: 'Test',
        lastName: role,
        passwordHash: await hashPassword(password),
        passwordChangedAt: new Date(),
        role,
        status: 'ACTIVE',
      },
    });
    users[role] = { id, email, password, role };
  }

  const adminId = users.ADMIN!.id;
  const clientId = ulid();
  const projectId = ulid();
  const siteId = ulid();
  const assetId = ulid();
  const templateId = ulid();
  const templateVersionId = ulid();

  await prisma.client.create({
    data: { id: clientId, orgId, name: 'Test Client', code: unique('C').slice(0, 20) },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      orgId,
      clientId,
      name: 'Test Project',
      code: unique('P').slice(0, 20),
      managerId: adminId,
    },
  });
  // The inspector must be a project member or `canAccessProject` refuses every
  // record in it — a scoped user with no membership sees nothing.
  await prisma.projectMember.create({ data: { projectId, userId: users.INSPECTOR!.id } });
  await prisma.site.create({
    data: { id: siteId, orgId, projectId, clientId, name: 'Test Site' },
  });
  await prisma.asset.create({
    data: { id: assetId, orgId, siteId, name: 'Test Asset', tag: unique('A').slice(0, 30) },
  });
  await prisma.template.create({
    data: {
      id: templateId,
      orgId,
      name: 'Test Template',
      category: 'Test',
      activeVersionId: templateVersionId,
      createdById: adminId,
    },
  });
  await prisma.templateVersion.create({
    data: {
      id: templateVersionId,
      templateId,
      orgId,
      version: 1,
      definition: definition(templateVersionId),
      scoring: { enabled: true, passThreshold: 80 },
      requiredSignatures: [],
      publishedAt: new Date(),
      publishedById: adminId,
    },
  });

  await publishToChangeLog(orgId, templateId);

  return {
    orgId,
    clientId,
    projectId,
    siteId,
    assetId,
    templateId,
    templateVersionId,
    users,
    cleanup: async () => {
      // One delete: every table that matters carries `onDelete: Cascade` from
      // the organisation, so this cannot leave orphans behind.
      await prisma.organization.deleteMany({ where: { id: orgId } });
    },
  };
}

/** Create an inspection assigned to the given user, inside the fixture project. */
export async function createInspection(
  org: TestOrg,
  assignedToId: string,
  overrides: Partial<{ status: string; number: string }> = {},
): Promise<string> {
  const id = ulid();
  await prisma.inspection.create({
    data: {
      id,
      orgId: org.orgId,
      number: overrides.number ?? unique('TST').toUpperCase().slice(0, 30),
      templateId: org.templateId,
      templateVersionId: org.templateVersionId,
      projectId: org.projectId,
      clientId: org.clientId,
      siteId: org.siteId,
      title: 'Test inspection',
      status: (overrides.status ?? 'SCHEDULED') as never,
      assignedToId,
      createdById: org.users.ADMIN!.id,
    },
  });
  return id;
}

export const TEST_FIELD_ID = FIELD_ID;
export const TEST_SECTION_ID = SECTION_ID;
