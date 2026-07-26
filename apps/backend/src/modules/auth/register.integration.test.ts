/**
 * Self-service registration, judged by what a device receives.
 *
 * A new organisation looks complete in the console the moment it is created —
 * the org exists, the administrator exists, the starter checklist is published.
 * None of that is what a phone sees. A device replays the change log and
 * nothing else, so anything created without an entry is invisible to every
 * device, forever, with no error anywhere.
 *
 * That is exactly what happened here: registration wrote only the
 * TEMPLATE_VERSION entry. An inspector added to a self-registered organisation
 * signed in successfully — the API returned a token — and then had no
 * organisation and no users to build local state from. From the field it looked
 * like the app could not log in, and from the console everything looked fine.
 *
 * So this suite asserts the delta a device actually pulls, not the rows in the
 * database. Those are different questions, and only one of them decides whether
 * an inspector can work.
 */

import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { strongPassword, unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('reg'),
  name: 'Registration Device',
  platform: 'android' as const,
  osVersion: '14',
  appVersion: '1.0.0',
});

/** Organisations created here, removed at the end. */
const created: string[] = [];

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

/** Register a fresh organisation and return the owner's session. */
async function register() {
  const email = `${unique('owner')}@test.invalid`;
  const password = strongPassword();

  const res = await request(server)
    .post(`${api}/auth/register`)
    .send({
      email,
      password,
      firstName: 'New',
      lastName: 'Owner',
      organizationName: unique('Registered Org'),
      device: device(),
    });

  expect(res.status).toBe(201);
  const orgId = res.body.data.organization.id as string;
  created.push(orgId);

  return {
    orgId,
    email,
    password,
    token: res.body.data.tokens.accessToken as string,
    userId: res.body.data.user.id as string,
  };
}

const pull = (token: string) =>
  request(server)
    .get(`${api}/sync/pull?protocolVersion=1&since=0&limit=500`)
    .set('Authorization', `Bearer ${token}`);

/** Count the delta by entity, which is the only view that matters to a device. */
async function delivered(token: string): Promise<Record<string, number>> {
  const res = await pull(token);
  expect(res.status).toBe(200);
  const counts: Record<string, number> = {};
  for (const change of res.body.changes as Array<{ entity: string }>) {
    counts[change.entity] = (counts[change.entity] ?? 0) + 1;
  }
  return counts;
}

describe('what a device receives from a newly registered organisation', () => {
  it('delivers the organisation itself', async () => {
    const owner = await register();
    // Without this the device has no organisation row to attach anything to.
    expect((await delivered(owner.token)).ORGANIZATION).toBe(1);
  });

  it('delivers the users, so an inspector can be shown who assigned their work', async () => {
    const owner = await register();
    expect((await delivered(owner.token)).USER).toBeGreaterThanOrEqual(1);
  });

  it('delivers the starter checklist, with the display fields the device cannot join for', async () => {
    const owner = await register();
    const res = await pull(owner.token);

    const version = (
      res.body.changes as Array<{ entity: string; data: Record<string, unknown> }>
    ).find((c) => c.entity === 'TEMPLATE_VERSION');

    expect(version).toBeTruthy();
    // A device holds `template_versions` and no `templates` table, so a bare
    // version row leaves `name` null and the insert fails on NOT NULL — taking
    // every later entity in the same delta with it.
    expect(version!.data.name).toBeTruthy();
    expect(version!.data.definition).toBeTruthy();
  });

  it('never sends a password hash to a device', async () => {
    const owner = await register();
    const res = await pull(owner.token);

    // Every member of the organisation replicates these rows.
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('orders the organisation before the rows that reference it', async () => {
    const owner = await register();
    const res = await pull(owner.token);

    const changes = res.body.changes as Array<{ entity: string; syncCursor: number }>;
    const org = changes.find((c) => c.entity === 'ORGANIZATION')!;
    const others = changes.filter((c) => c.entity !== 'ORGANIZATION');

    // A device applies in cursor order, so anything referencing the
    // organisation must arrive after it.
    for (const change of others) expect(change.syncCursor).toBeGreaterThan(org.syncCursor);
  });
});

describe('an inspector added to a registered organisation', () => {
  it('signs in and receives a usable delta — the failure this suite exists for', async () => {
    const owner = await register();

    const inspectorEmail = `${unique('inspector')}@test.invalid`;
    const inspectorPassword = strongPassword();
    const invited = await request(server)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        email: inspectorEmail,
        firstName: 'Field',
        lastName: 'Worker',
        role: 'INSPECTOR',
        password: inspectorPassword,
      });
    expect(invited.status).toBe(201);
    expect(invited.body.data.status).toBe('ACTIVE');

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: inspectorEmail, password: inspectorPassword, device: device() });
    expect(login.status).toBe(200);

    // Signing in was never the broken part. This is.
    const counts = await delivered(login.body.data.tokens.accessToken);
    expect(counts.ORGANIZATION).toBe(1);
    expect(counts.USER).toBeGreaterThanOrEqual(2);
    expect(counts.TEMPLATE_VERSION).toBe(1);
  });
});

describe('signup is for company owners only', () => {
  it('always makes the registrant an organisation ADMIN', async () => {
    const owner = await register();
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });

    // Never SUPER_ADMIN: that role acts across organisations in a shared
    // install, so handing it out at signup would let anyone who registers
    // reach every tenant.
    expect(stored.role).toBe('ADMIN');
  });

  it('ignores a role somebody puts in the request body', async () => {
    const email = `${unique('sneaky')}@test.invalid`;
    const res = await request(server)
      .post(`${api}/auth/register`)
      .send({
        email,
        password: strongPassword(),
        firstName: 'Would Be',
        lastName: 'Superuser',
        organizationName: unique('Escalation Attempt'),
        role: 'SUPER_ADMIN',
        device: device(),
      });

    expect(res.status).toBe(201);
    created.push(res.body.data.organization.id as string);
    expect(res.body.data.user.role).toBe('ADMIN');
  });

  it('cannot be used to join an existing organisation', async () => {
    const owner = await register();
    const before = await prisma.user.count({ where: { orgId: owner.orgId } });

    // Registering with the same organisation name makes a *separate*
    // organisation, which is the point: there is no self-service route into
    // somebody else's tenant. Inspectors exist only because an administrator
    // created them.
    const second = await request(server)
      .post(`${api}/auth/register`)
      .send({
        email: `${unique('outsider')}@test.invalid`,
        password: strongPassword(),
        firstName: 'Out',
        lastName: 'Sider',
        organizationName: (
          await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } })
        ).name,
        device: device(),
      });

    expect(second.status).toBe(201);
    const secondOrgId = second.body.data.organization.id as string;
    created.push(secondOrgId);

    expect(secondOrgId).not.toBe(owner.orgId);
    expect(await prisma.user.count({ where: { orgId: owner.orgId } })).toBe(before);
  });
});

describe('cursor allocation', () => {
  it('leaves the organisation sequence above every cursor it handed out', async () => {
    const owner = await register();

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: owner.orgId } });
    const highest = await prisma.changeLogEntry.aggregate({
      where: { orgId: owner.orgId },
      _max: { cursor: true },
    });

    // If the sequence trailed, the next write would reuse a cursor a device has
    // already seen and be skipped as old.
    expect(Number(org.syncSequence)).toBeGreaterThanOrEqual(Number(highest._max.cursor));
  });
});
