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

/**
 * Register a fresh organisation and return the owner's session.
 *
 * Registration is bootstrap-only — it succeeds on an empty installation and is
 * refused once any organisation exists. The suite therefore empties the table
 * first, which is safe because the harness refuses to run against anything but
 * `orbit_test` and each case builds what it needs.
 */
async function register() {
  await prisma.organization.deleteMany({});
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

describe('signup is bootstrap only', () => {
  it('makes the first registrant the organisation owner', async () => {
    const owner = await register();
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } });

    // SUPER_ADMIN is safe here precisely because the gate below closes signup
    // afterwards: there is exactly one organisation for the role to reach and
    // it is this person's own.
    expect(stored.role).toBe('SUPER_ADMIN');
  });

  it('refuses a second registration with 403, permanently', async () => {
    await register();

    const second = await request(server)
      .post(`${api}/auth/register`)
      .send({
        email: `${unique('second')}@test.invalid`,
        password: strongPassword(),
        firstName: 'Second',
        lastName: 'Company',
        organizationName: unique('Another Company'),
        device: device(),
      });

    // Orbit Field is one company's system. A second organisation created
    // through the public website would be invisible to the company that owns
    // the deployment, because tenants cannot see each other.
    expect(second.status).toBe(403);
    expect(await prisma.organization.count()).toBe(1);
  });

  it('reports itself unavailable once an organisation exists', async () => {
    await register();

    const res = await request(server).get(`${api}/auth/signup-available`);
    expect(res.status).toBe(200);
    // The console hides its "Create account" tab on this answer, so it has to
    // agree with what /auth/register would actually do.
    expect(res.body.data.available).toBe(false);
  });

  it('reports itself available on an empty installation', async () => {
    await prisma.organization.deleteMany({});

    const res = await request(server).get(`${api}/auth/signup-available`);
    expect(res.body.data.available).toBe(true);
  });

  it('ignores a role somebody puts in the request body', async () => {
    await prisma.organization.deleteMany({});

    const res = await request(server)
      .post(`${api}/auth/register`)
      .send({
        email: `${unique('sneaky')}@test.invalid`,
        password: strongPassword(),
        firstName: 'Would Be',
        lastName: 'Superuser',
        organizationName: unique('Escalation Attempt'),
        role: 'VIEWER',
        device: device(),
      });

    expect(res.status).toBe(201);
    created.push(res.body.data.organization.id as string);
    // The role comes from the bootstrap rule, never from the request.
    expect(res.body.data.user.role).toBe('SUPER_ADMIN');
  });

  it('cannot be used to join an existing organisation', async () => {
    const owner = await register();
    const before = await prisma.user.count({ where: { orgId: owner.orgId } });

    const outsider = await request(server)
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

    // Refused outright, so there is no self-service route into somebody else's
    // company. Inspectors exist only because an administrator created them.
    expect(outsider.status).toBe(403);
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
