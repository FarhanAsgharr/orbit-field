/**
 * Administration: user lifecycle, reference data, audit trail, org settings.
 *
 * Two properties drive what is tested here.
 *
 * The first is that **privilege cannot be escalated**. Every route that mints
 * or modifies a user is a potential path to granting yourself more authority
 * than you hold, so each is tested from below as well as from above: not just
 * "an admin can do it" but "a manager cannot, and the database is unchanged
 * afterwards".
 *
 * The second is that **every reference-data mutation reaches devices**. Clients,
 * projects, sites and assets are replicated, and a device replays the change
 * log and nothing else. A site created without a log entry exists in the
 * console and nowhere else, so an inspector standing at that site cannot file
 * against it. That failure is invisible from the console, which is exactly why
 * it is asserted here rather than left to be noticed in the field.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { strongPassword, unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('adm'),
  name: 'Admin Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    tokens[role] = res.body.data.tokens.accessToken;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const get = (path: string, role = 'ADMIN') =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const post = (path: string, role = 'ADMIN') =>
  request(server).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const patch = (path: string, role = 'ADMIN') =>
  request(server).patch(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const del = (path: string, role = 'ADMIN') =>
  request(server).delete(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

const newUser = (over: Record<string, unknown> = {}) => ({
  email: `${unique('created')}@test.invalid`,
  firstName: 'Created',
  lastName: 'Person',
  role: 'INSPECTOR',
  ...over,
});

describe('creating users', () => {
  it('creates an INVITED account with no password and reports whether the invitation was sent', async () => {
    const body = newUser();
    const res = await post('/users').send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.email).toBe(body.email);
    // Without a password this email is the only route into the account, so
    // delivery is reported rather than swallowed.
    expect(typeof res.body.data.emailDelivered).toBe('boolean');

    const stored = await prisma.user.findFirstOrThrow({ where: { email: body.email } });
    expect(stored.status).toBe('INVITED');
    expect(stored.passwordHash).toBeNull();
  });

  it('creates an ACTIVE account when a password is supplied, and forces a change', async () => {
    const body = newUser({ password: strongPassword() });
    const res = await post('/users').send(body);

    expect(res.status).toBe(201);
    // Nothing to accept, so INVITED would be a status that never resolves.
    expect(res.body.data.status).toBe('ACTIVE');
    // No invitation: the administrator handed the credential over themselves.
    expect(res.body.data.emailDelivered).toBeNull();

    const stored = await prisma.user.findFirstOrThrow({ where: { email: body.email } });
    // The owner did not choose it and it travelled out of band, so it is known
    // to at least two people until they replace it.
    expect(stored.mustChangePassword).toBe(true);
    expect(stored.passwordHash).not.toBeNull();
  });

  it('holds an administrator-set password to the same policy the user would face', async () => {
    const res = await post('/users').send(newUser({ password: 'password' }));

    expect(res.status).toBe(422);
    expect(res.body.error.fields?.password).toBeTruthy();
  });

  it('refuses a password containing the new account’s own name', async () => {
    const res = await post('/users').send(
      newUser({ firstName: 'Bartholomew', password: 'Bartholomew99!x' }),
    );
    expect(res.status).toBe(422);
  });

  it('never lets a caller mint a role at or above their own', async () => {
    const before = await prisma.user.count({ where: { orgId: org.orgId } });

    const escalation = await post('/users', 'MANAGER').send(newUser({ role: 'ADMIN' }));
    expect(escalation.status).toBe(403);
    expect(escalation.body.error.message).toMatch(/at or above your own/i);

    const sideways = await post('/users', 'MANAGER').send(newUser({ role: 'MANAGER' }));
    expect(sideways.status).toBe(403);

    // The refusal is only meaningful if no row was written.
    expect(await prisma.user.count({ where: { orgId: org.orgId } })).toBe(before);
  });

  it('lets an admin mint a role below their own', async () => {
    const res = await post('/users', 'ADMIN').send(newUser({ role: 'MANAGER' }));
    expect(res.status).toBe(201);
  });

  it('stops a manager minting even a role below their own, because role assignment is an admin power', async () => {
    // MANAGER outranks INSPECTOR, and holds USER_INVITE — but USER_ROLE_ASSIGN
    // belongs to ADMIN, and every invitation names a role. The effect is that a
    // manager cannot create any account at all.
    const res = await post('/users', 'MANAGER').send(newUser({ role: 'INSPECTOR' }));
    expect(res.status).toBe(403);
  });

  it('rejects a duplicate email within the organisation', async () => {
    const body = newUser();
    await post('/users').send(body).expect(201);

    const again = await post('/users').send(body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  it('attaches project memberships when asked', async () => {
    const res = await post('/users').send(newUser({ projectIds: [org.projectId] }));
    expect(res.status).toBe(201);

    const memberships = await prisma.projectMember.count({
      where: { userId: res.body.data.id, projectId: org.projectId },
    });
    expect(memberships).toBe(1);
  });

  it('refuses an inspector entirely', async () => {
    const res = await post('/users', 'INSPECTOR').send(newUser());
    expect(res.status).toBe(403);
  });
});

describe('updating users', () => {
  it('revokes existing tokens when a role changes, because the old token asserts the old role', async () => {
    const created = await post('/users').send(newUser({ password: strongPassword() }));
    const target = created.body.data.id as string;

    await prisma.refreshToken.count({ where: { userId: target } });
    const res = await patch(`/users/${target}`).send({ role: 'VIEWER' });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('VIEWER');

    const live = await prisma.refreshToken.count({
      where: { userId: target, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('refuses to change your own role', async () => {
    const me = org.users.ADMIN!.id;
    const res = await patch(`/users/${me}`).send({ role: 'VIEWER' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/your own/i);

    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: me } });
    expect(unchanged.role).toBe('ADMIN');
  });

  it('refuses to manage a user above your own level', async () => {
    const res = await patch(`/users/${org.users.SUPER_ADMIN!.id}`, 'MANAGER').send({
      status: 'SUSPENDED',
    });
    expect(res.status).toBe(403);

    const unchanged = await prisma.user.findUniqueOrThrow({
      where: { id: org.users.SUPER_ADMIN!.id },
    });
    expect(unchanged.status).toBe('ACTIVE');
  });

  it('rejects a permission override that names something that does not exist', async () => {
    const created = await post('/users').send(newUser());
    const res = await patch(`/users/${created.body.data.id}`).send({
      extraPermissions: ['inspection:read', 'summon:kraken'],
    });

    // Silently dropping it would leave an operator believing they granted
    // something they did not.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.extraPermissions).toMatch(/summon:kraken/);
  });

  it('accepts a permission override that names real permissions', async () => {
    const created = await post('/users').send(newUser());
    const res = await patch(`/users/${created.body.data.id}`).send({
      extraPermissions: ['inspection:read'],
    });
    expect(res.status).toBe(200);
  });

  it('replaces project membership wholesale rather than appending', async () => {
    const created = await post('/users').send(newUser({ projectIds: [org.projectId] }));
    const id = created.body.data.id as string;

    const res = await patch(`/users/${id}`).send({ projectIds: [] });
    expect(res.status).toBe(200);
    expect(await prisma.projectMember.count({ where: { userId: id } })).toBe(0);
  });

  it('revokes tokens when an account is suspended', async () => {
    const created = await post('/users').send(newUser({ password: strongPassword() }));
    const id = created.body.data.id as string;

    await patch(`/users/${id}`).send({ status: 'SUSPENDED' }).expect(200);

    const live = await prisma.refreshToken.count({ where: { userId: id, revokedAt: null } });
    expect(live).toBe(0);
  });

  it('404s for a user in another organisation', async () => {
    const other = await createTestOrg();
    try {
      const res = await patch(`/users/${other.users.INSPECTOR!.id}`).send({ firstName: 'Nope' });
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('deactivating users', () => {
  it('deactivates rather than deletes, revokes devices, and reports orphaned work', async () => {
    const created = await post('/users').send(newUser({ password: strongPassword() }));
    const id = created.body.data.id as string;
    await createInspection(org, id, { status: 'IN_PROGRESS' });

    const res = await del(`/users/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deactivated).toBe(true);
    // Work assigned to a departing user must be reassigned, not silently
    // orphaned — so the count comes back rather than being left to discover.
    expect(res.body.data.openInspections).toBe(1);
    expect(res.body.data.warning).toMatch(/reassigned/i);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id } });
    // Audit trails reference the user id, so the row must survive.
    expect(stored.deletedAt).toBeNull();
    expect(stored.status).toBe('DEACTIVATED');

    const liveDevices = await prisma.device.count({ where: { userId: id, revokedAt: null } });
    expect(liveDevices).toBe(0);
  });

  it('reports no warning when the user has no open work', async () => {
    const created = await post('/users').send(newUser());
    const res = await del(`/users/${created.body.data.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.openInspections).toBe(0);
    expect(res.body.data.warning).toBeNull();
  });

  it('refuses to deactivate a peer', async () => {
    const res = await del(`/users/${org.users.SUPER_ADMIN!.id}`, 'ADMIN');
    expect(res.status).toBe(403);
  });
});

describe('reading users and the role catalogue', () => {
  it('never returns a password hash', async () => {
    const res = await get('/users?pageSize=100');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('searches and filters by role', async () => {
    const res = await get('/users?role=INSPECTOR&pageSize=100');
    expect(res.status).toBe(200);
    for (const u of res.body.data.items) expect(u.role).toBe('INSPECTOR');
  });

  it('returns one user', async () => {
    const res = await get(`/users/${org.users.INSPECTOR!.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(org.users.INSPECTOR!.id);
  });

  it('tells the UI which roles the caller may assign, so restrictions are not discovered via 403', async () => {
    const res = await get('/users/meta/roles', 'ADMIN');
    expect(res.status).toBe(200);

    const byRole = Object.fromEntries(
      res.body.data.roles.map((r: { role: string; assignable: boolean }) => [r.role, r.assignable]),
    );
    // Strictly below the caller's own rank, never at or above it.
    expect(byRole.MANAGER).toBe(true);
    expect(byRole.INSPECTOR).toBe(true);
    expect(byRole.ADMIN).toBe(false);
    expect(byRole.SUPER_ADMIN).toBe(false);
    expect(res.body.data.permissions.length).toBeGreaterThan(0);
  });

  it('marks every role unassignable for a manager, who lacks the role-assign permission', async () => {
    const res = await get('/users/meta/roles', 'MANAGER');
    expect(res.status).toBe(200);
    const assignable = res.body.data.roles.filter(
      (r: { assignable: boolean }) => r.assignable,
    ) as unknown[];
    expect(assignable).toHaveLength(0);
  });
});

describe('user changes reach devices', () => {
  /*
   * The console shows a colleague the moment they are added. A phone shows
   * them only if a change-log entry was written, because a device replays the
   * change log and nothing else.
   *
   * When this was missing, an inspector added by an administrator was invisible
   * to every device in the organisation — and on a freshly registered
   * organisation, where the org and its owner were also unpublished, the app
   * had nothing at all to build local state from. Sign-in returned a token and
   * the app still could not start, which reads in the field as "the login is
   * broken".
   */
  it('publishes a newly created colleague', async () => {
    const res = await post('/users').send(newUser());
    expect(res.status).toBe(201);

    const entry = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: res.body.data.id, entity: 'USER' },
    });
    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe('CREATE');
    expect((entry!.data as { email?: string }).email).toBe(res.body.data.email);
  });

  it('never puts a password hash in the change log', async () => {
    const res = await post('/users').send(newUser({ password: strongPassword() }));

    const entry = await prisma.changeLogEntry.findFirstOrThrow({
      where: { orgId: org.orgId, entityId: res.body.data.id, entity: 'USER' },
    });
    // This row is replicated to every member of the organisation and then sits
    // on their phones.
    const payload = JSON.stringify(entry.data);
    expect(payload).not.toContain('argon2');
    expect(payload).not.toContain('passwordHash');
  });

  it('publishes an edit, so a phone stops showing the old name', async () => {
    const created = await post('/users').send(newUser());
    const id = created.body.data.id as string;

    await patch(`/users/${id}`).send({ firstName: 'Renamed' }).expect(200);

    const entries = await prisma.changeLogEntry.findMany({
      where: { orgId: org.orgId, entityId: id, entity: 'USER' },
      orderBy: { cursor: 'asc' },
    });
    expect(entries.map((e) => e.operation)).toContain('UPDATE');
    expect((entries.at(-1)!.data as { firstName?: string }).firstName).toBe('Renamed');
  });

  it('publishes a deactivation as an update, keeping the row on the device', async () => {
    const created = await post('/users').send(newUser());
    const id = created.body.data.id as string;

    await del(`/users/${id}`).expect(200);

    const last = await prisma.changeLogEntry.findFirstOrThrow({
      where: { orgId: org.orgId, entityId: id, entity: 'USER' },
      orderBy: { cursor: 'desc' },
    });
    // A tombstone would take the name off historical work that person did.
    expect(last.operation).toBe('UPDATE');
    expect((last.data as { status?: string }).status).toBe('DEACTIVATED');
  });
});

describe('reference data reaches devices', () => {
  const resources = [
    { path: '/clients', entity: 'CLIENT', body: () => ({ name: unique('Client') }) },
    {
      path: '/projects',
      entity: 'PROJECT',
      body: () => ({ name: unique('Project'), code: unique('PC').slice(0, 20) }),
    },
    { path: '/sites', entity: 'SITE', body: () => ({ name: unique('Site') }) },
    {
      path: '/assets',
      entity: 'ASSET',
      body: () => ({ name: unique('Asset'), tag: unique('AT').slice(0, 30) }),
    },
  ];

  it.each(resources)('creating a $path row writes a change-log entry', async (resource) => {
    const res = await post(resource.path).send(resource.body());
    expect(res.status).toBe(201);

    // A row without a log entry is invisible to every phone, which looks like
    // nothing at all from the console.
    const logged = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: res.body.data.id, entity: resource.entity as never },
    });
    expect(logged).not.toBeNull();
    expect(logged!.operation).toBe('CREATE');
  });

  it.each(resources)('updating a $path row logs the new version', async (resource) => {
    const created = await post(resource.path).send(resource.body());
    const id = created.body.data.id as string;

    const updated = await patch(`${resource.path}/${id}`).send({ name: unique('Renamed') });
    expect(updated.status).toBe(200);

    const entries = await prisma.changeLogEntry.findMany({
      where: { orgId: org.orgId, entityId: id },
      orderBy: { cursor: 'asc' },
    });
    expect(entries.map((e) => e.operation)).toContain('UPDATE');
  });

  it.each(resources)('deleting a $path row leaves a tombstone, not a gap', async (resource) => {
    const created = await post(resource.path).send(resource.body());
    const id = created.body.data.id as string;

    const removed = await del(`${resource.path}/${id}`);
    expect(removed.status).toBe(204);

    // A device that never sees a DELETE keeps showing the row forever.
    const tombstone = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: id, operation: 'DELETE' },
    });
    expect(tombstone).not.toBeNull();
    expect(tombstone!.data).toBeNull();
  });

  it.each(resources)('$path hides soft-deleted rows from the list', async (resource) => {
    const created = await post(resource.path).send(resource.body());
    const id = created.body.data.id as string;
    await del(`${resource.path}/${id}`).expect(204);

    const list = await get(`${resource.path}?pageSize=100`);
    expect(list.body.data.items.map((r: { id: string }) => r.id)).not.toContain(id);
  });
});

describe('reference data referential integrity', () => {
  it('refuses to attach a project to another organisation’s client', async () => {
    const other = await createTestOrg();
    try {
      const res = await post('/projects').send({
        name: unique('Cross'),
        code: unique('X').slice(0, 20),
        clientId: other.clientId,
      });
      // Guessing an id must not reach across the tenant boundary.
      expect([404, 422]).toContain(res.status);

      const leaked = await prisma.project.findFirst({
        where: { orgId: org.orgId, clientId: other.clientId },
      });
      expect(leaked).toBeNull();
    } finally {
      await other.cleanup();
    }
  });

  it('refuses a geofence radius on a site with no coordinates', async () => {
    const res = await post('/sites').send({
      name: unique('Nowhere'),
      geofenceRadiusMeters: 100,
    });
    // A radius without a centre silently never applies, which reads as
    // "geofencing is broken" rather than "the site has no location".
    expect(res.status).toBe(422);
  });

  it('accepts a geofence when coordinates are present', async () => {
    const res = await post('/sites').send({
      name: unique('Somewhere'),
      latitude: 51.5,
      longitude: -0.1,
      geofenceRadiusMeters: 100,
    });
    expect(res.status).toBe(201);
  });

  it('404s reading a resource from another organisation', async () => {
    const other = await createTestOrg();
    try {
      expect((await get(`/clients/${other.clientId}`)).status).toBe(404);
      expect((await get(`/projects/${other.projectId}`)).status).toBe(404);
      expect((await get(`/sites/${other.siteId}`)).status).toBe(404);
      expect((await get(`/assets/${other.assetId}`)).status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('searches and paginates', async () => {
    const name = unique('Findable');
    await post('/clients').send({ name }).expect(201);

    const found = await get(`/clients?search=${encodeURIComponent(name)}`);
    expect(found.body.data.items).toHaveLength(1);

    const paged = await get('/clients?page=1&pageSize=1');
    expect(paged.body.data.items).toHaveLength(1);
  });
});

describe('audit trail', () => {
  it('records who changed what, and is readable only by an administrator', async () => {
    const created = await post('/users').send(newUser());

    const logs = await get(`/admin/audit-logs?pageSize=100`);
    expect(logs.status).toBe(200);

    const entry = logs.body.data.items.find(
      (l: { entityId: string }) => l.entityId === created.body.data.id,
    );
    expect(entry).toBeTruthy();
    expect(entry.action).toBe('RECORD_CREATED');
    expect(entry.userId).toBe(org.users.ADMIN!.id);

    // Metadata records that a password was set, never what it was.
    expect(JSON.stringify(entry)).not.toContain('argon2');
  });

  it('refuses an inspector', async () => {
    expect((await get('/admin/audit-logs', 'INSPECTOR')).status).toBe(403);
  });

  it('filters by action and entity', async () => {
    const res = await get('/admin/audit-logs?action=RECORD_CREATED&entity=User&pageSize=50');
    expect(res.status).toBe(200);
    for (const l of res.body.data.items) {
      expect(l.action).toBe('RECORD_CREATED');
      expect(l.entity).toBe('User');
    }
  });

  it('exposes sync sessions, sync health and unresolved conflicts', async () => {
    for (const path of ['/admin/sync-sessions', '/admin/sync-health', '/admin/conflicts']) {
      const res = await get(path);
      expect(res.status).toBe(200);
    }
  });
});

describe('organisation settings', () => {
  it('reads the organisation with its counts', async () => {
    const res = await get('/admin/organization');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(org.orgId);
    expect(res.body.data._count.users).toBeGreaterThan(0);
  });

  it('updates settings and persists them', async () => {
    const res = await patch('/admin/organization').send({
      timezone: 'Europe/London',
      settings: { requireGpsOnSubmit: true, maxDevicesPerUser: 3 },
    });
    expect(res.status).toBe(200);

    const stored = await prisma.organization.findUniqueOrThrow({ where: { id: org.orgId } });
    expect(stored.timezone).toBe('Europe/London');
    expect((stored.settings as { requireGpsOnSubmit?: boolean }).requireGpsOnSubmit).toBe(true);
  });

  it('rejects a number prefix that is not upper-case alphanumeric', async () => {
    const res = await patch('/admin/organization').send({ numberPrefix: 'lower case' });
    expect(res.status).toBe(422);
  });

  it('refuses settings changes from a manager', async () => {
    const res = await patch('/admin/organization', 'MANAGER').send({ timezone: 'UTC' });
    expect(res.status).toBe(403);
  });
});
