/**
 * The member lifecycle an organisation owner actually performs.
 *
 * Add someone, correct their details, reset the password they forgot, take
 * their access away when they leave, give it back when they return, and delete
 * the one you created with a typo five minutes ago.
 *
 * Two properties run through all of it.
 *
 * **A credential change must take effect at once.** Resetting a password that
 * leaves the old one working, or deactivating an account whose phone keeps
 * syncing, is worse than not offering the control — the administrator believes
 * they have acted and has not. So every case here checks the *next* login
 * rather than the response body.
 *
 * **History is never silently destroyed.** An inspection's `assignedTo` and
 * `reviewedBy` are `SetNull`, so deleting a user who did work leaves the
 * record in place with nobody's name on it. That is not a tidier database; it
 * is a compliance record that has quietly stopped saying who was there.
 * Permanent deletion is therefore refused the moment there is anything to
 * preserve, and the refusal says what.
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
  installationId: unique('mem'),
  name: 'Member Device',
  platform: 'android' as const,
  osVersion: '14',
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

const login = (email: string, password: string) =>
  request(server).post(`${api}/auth/login`).send({ email, password, device: device() });

/** Add a member the way the console does: everything set, password included. */
async function addMember(over: Record<string, unknown> = {}) {
  const email = `${unique('member')}@test.invalid`;
  const password = strongPassword();

  const res = await post('/users').send({
    email,
    firstName: 'Field',
    lastName: 'Worker',
    role: 'INSPECTOR',
    password,
    department: 'Operations',
    jobTitle: 'Site Inspector',
    ...over,
  });

  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, email, password };
}

describe('adding a member', () => {
  it('creates an account that can sign in immediately, with no email involved', async () => {
    const member = await addMember();

    // The whole point of an administrator-set password: no invitation, no
    // mail provider, nothing to deliver.
    expect((await login(member.email, member.password)).status).toBe(200);

    const stored = await prisma.user.findFirstOrThrow({ where: { id: member.id } });
    expect(stored.status).toBe('ACTIVE');
    expect(stored.department).toBe('Operations');
    expect(stored.jobTitle).toBe('Site Inspector');
  });

  it('records who created the account', async () => {
    const member = await addMember();
    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: member.id, action: 'RECORD_CREATED' },
    });
    expect(log?.userId).toBe(org.users.ADMIN!.id);
  });
});

describe('editing a member', () => {
  it('changes the details an administrator can see', async () => {
    const member = await addMember();

    const res = await patch(`/users/${member.id}`).send({
      firstName: 'Renamed',
      department: 'Compliance',
      jobTitle: 'Lead Inspector',
    });
    expect(res.status).toBe(200);

    const stored = await prisma.user.findFirstOrThrow({ where: { id: member.id } });
    expect(stored.firstName).toBe('Renamed');
    expect(stored.department).toBe('Compliance');
    expect(stored.jobTitle).toBe('Lead Inspector');
  });

  it('changes the email, and the new one is what signs in', async () => {
    const member = await addMember();
    const next = `${unique('moved')}@test.invalid`;

    expect((await patch(`/users/${member.id}`).send({ email: next })).status).toBe(200);

    expect((await login(next, member.password)).status).toBe(200);
    // The old address is a different account as far as the API is concerned.
    expect((await login(member.email, member.password)).status).toBe(401);
  });

  it('refuses an email another member already has', async () => {
    const first = await addMember();
    const second = await addMember();

    const res = await patch(`/users/${second.id}`).send({ email: first.email });
    // A collision reaching the database surfaces as an opaque 500 instead of a
    // field error somebody can act on.
    expect(res.status).toBe(409);
    expect(res.body.error.fields?.email).toBeTruthy();
  });

  it('changes the role, and signs them out because their token asserts the old one', async () => {
    const member = await addMember();
    const session = await login(member.email, member.password);
    const token = session.body.data.tokens.accessToken as string;

    await request(server).get(`${api}/auth/me`).set('Authorization', `Bearer ${token}`).expect(200);

    expect((await patch(`/users/${member.id}`).send({ role: 'VIEWER' })).status).toBe(200);

    const live = await prisma.refreshToken.count({ where: { userId: member.id, revokedAt: null } });
    expect(live).toBe(0);
  });
});

describe('resetting a password', () => {
  it('makes the old password stop working and the new one start', async () => {
    const member = await addMember();
    const next = strongPassword();

    const res = await post(`/users/${member.id}/reset-password`).send({ password: next });
    expect(res.status).toBe(200);
    expect(res.body.data.reset).toBe(true);

    // Both halves matter. A reset that leaves the old password working is the
    // failure an administrator would never notice.
    expect((await login(member.email, member.password)).status).toBe(401);
    expect((await login(member.email, next)).status).toBe(200);
  });

  it('signs out every device the person already had', async () => {
    const member = await addMember();
    const session = await login(member.email, member.password);
    const token = session.body.data.tokens.accessToken as string;

    await post(`/users/${member.id}/reset-password`)
      .send({ password: strongPassword() })
      .expect(200);

    // Backdate past the one-second resolution of the token's `iat`.
    await prisma.user.updateMany({
      where: { id: member.id },
      data: { passwordChangedAt: new Date(Date.now() + 1000) },
    });

    const after = await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);

    expect(await prisma.refreshToken.count({ where: { userId: member.id, revokedAt: null } })).toBe(
      0,
    );
  });

  it('holds the new password to the same policy as any other', async () => {
    const member = await addMember();

    const res = await post(`/users/${member.id}/reset-password`).send({ password: 'password123' });
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.password).toBeTruthy();

    // The refusal must leave the account exactly as it was.
    expect((await login(member.email, member.password)).status).toBe(200);
  });

  it('clears a lockout, so a forgotten password is not also a 15-minute wait', async () => {
    const member = await addMember();
    for (let i = 0; i < 6; i++) await login(member.email, strongPassword());

    const next = strongPassword();
    await post(`/users/${member.id}/reset-password`).send({ password: next }).expect(200);

    expect((await login(member.email, next)).status).toBe(200);
  });

  it('audits the reset without recording the password', async () => {
    const member = await addMember();
    const next = strongPassword();
    await post(`/users/${member.id}/reset-password`).send({ password: next }).expect(200);

    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: member.id, action: 'AUTH_PASSWORD_RESET' },
    });
    expect(log).not.toBeNull();
    expect(log!.userId).toBe(org.users.ADMIN!.id);
    expect(JSON.stringify(log!.metadata)).not.toContain(next);
  });

  it('refuses a caller who cannot manage that user', async () => {
    const member = await addMember();
    const res = await post(`/users/${member.id}/reset-password`, 'INSPECTOR').send({
      password: strongPassword(),
    });
    expect(res.status).toBe(403);
  });

  it('refuses resetting your own password here', async () => {
    const res = await post(`/users/${org.users.ADMIN!.id}/reset-password`).send({
      password: strongPassword(),
    });
    expect(res.status).toBe(403);
  });
});

describe('deactivating and reactivating', () => {
  it('denies sign-in once deactivated, and restores it on reactivation', async () => {
    const member = await addMember();
    expect((await login(member.email, member.password)).status).toBe(200);

    await del(`/users/${member.id}`).expect(200);

    const denied = await login(member.email, member.password);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ACCOUNT_DEACTIVATED');

    expect((await patch(`/users/${member.id}`).send({ status: 'ACTIVE' })).status).toBe(200);

    // The password survives deactivation — they sign back in with what they had.
    expect((await login(member.email, member.password)).status).toBe(200);
  });

  it('revokes the devices of somebody deactivated', async () => {
    const member = await addMember();
    await login(member.email, member.password);

    await del(`/users/${member.id}`).expect(200);

    expect(await prisma.device.count({ where: { userId: member.id, revokedAt: null } })).toBe(0);
  });

  it('keeps the account and its history', async () => {
    const member = await addMember();
    await del(`/users/${member.id}`).expect(200);

    const stored = await prisma.user.findFirstOrThrow({ where: { id: member.id } });
    expect(stored.deletedAt).toBeNull();
    expect(stored.status).toBe('DEACTIVATED');
  });
});

describe('permanent deletion', () => {
  it('removes somebody who never used the system', async () => {
    const member = await addMember();

    const res = await del(`/users/${member.id}/permanent`);
    expect(res.status).toBe(204);

    expect(await prisma.user.findFirst({ where: { id: member.id } })).toBeNull();
    // The person must leave every phone too, or they linger in the fleet.
    const tombstone = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: member.id, entity: 'USER', operation: 'DELETE' },
    });
    expect(tombstone).not.toBeNull();
  });

  it('refuses somebody with inspection history, and says why', async () => {
    const member = await addMember();
    await createInspection(org, member.id, { status: 'APPROVED' });

    const res = await del(`/users/${member.id}/permanent`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/deactivate/i);
    expect(res.body.error.fields?.assignedInspections).toBeTruthy();

    // Refusing is only meaningful if the row survives.
    expect(await prisma.user.findFirst({ where: { id: member.id } })).not.toBeNull();
  });

  it('refuses somebody who has acted, because their audit trail names them', async () => {
    const member = await addMember({ role: 'MANAGER' });
    // Any action at all writes an audit entry authored by them.
    await prisma.auditLog.create({
      data: {
        id: unique('a')
          .toUpperCase()
          .replace(/[^0-9A-Z]/g, '0')
          .slice(0, 26)
          .padEnd(26, '0'),
        orgId: org.orgId,
        userId: member.id,
        action: 'RECORD_UPDATED',
        entity: 'Client',
        entityId: org.clientId,
      },
    });

    const res = await del(`/users/${member.id}/permanent`);
    expect(res.status).toBe(409);
    expect(res.body.error.fields?.auditEntries).toBeTruthy();
  });

  it('audits the deletion with the email, since the id resolves to nothing afterwards', async () => {
    const member = await addMember();
    await del(`/users/${member.id}/permanent`).expect(204);

    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: member.id, action: 'RECORD_DELETED' },
      orderBy: { createdAt: 'desc' },
    });
    expect((log!.metadata as { email?: string; permanent?: boolean }).email).toBe(member.email);
    expect((log!.metadata as { permanent?: boolean }).permanent).toBe(true);
  });

  it('reports up front whether somebody can be deleted', async () => {
    const clean = await addMember();
    const used = await addMember();
    await createInspection(org, used.id);

    expect((await get(`/users/${clean.id}`)).body.data.deletable).toBe(true);

    const blocked = await get(`/users/${used.id}`);
    expect(blocked.body.data.deletable).toBe(false);
    expect(blocked.body.data.usage.assignedInspections).toBeGreaterThan(0);
  });

  it('refuses a caller who cannot manage that user', async () => {
    const member = await addMember();
    expect((await del(`/users/${member.id}/permanent`, 'INSPECTOR')).status).toBe(403);
    expect(await prisma.user.findFirst({ where: { id: member.id } })).not.toBeNull();
  });
});

describe('only administrators manage people', () => {
  const inspectorIsRefused: Array<[string, () => request.Test]> = [
    ['list people', () => get('/users', 'INSPECTOR')],
    ['add someone', () => post('/users', 'INSPECTOR').send({ email: 'x@test.invalid' })],
    [
      'edit someone',
      () => patch(`/users/${org.users.VIEWER!.id}`, 'INSPECTOR').send({ firstName: 'X' }),
    ],
    ['deactivate someone', () => del(`/users/${org.users.VIEWER!.id}`, 'INSPECTOR')],
    ['delete someone', () => del(`/users/${org.users.VIEWER!.id}/permanent`, 'INSPECTOR')],
    [
      'reset a password',
      () =>
        post(`/users/${org.users.VIEWER!.id}/reset-password`, 'INSPECTOR').send({
          password: 'Whatever123!x',
        }),
    ],
  ];

  it.each(inspectorIsRefused)('an inspector cannot %s', async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(403);
  });

  it('nobody reaches another organisation’s people', async () => {
    const other = await createTestOrg();
    try {
      const theirs = other.users.INSPECTOR!.id;
      expect((await get(`/users/${theirs}`)).status).toBe(404);
      expect((await patch(`/users/${theirs}`).send({ firstName: 'X' })).status).toBe(404);
      expect((await del(`/users/${theirs}`)).status).toBe(404);
      expect((await del(`/users/${theirs}/permanent`)).status).toBe(404);
      expect(
        (await post(`/users/${theirs}/reset-password`).send({ password: strongPassword() })).status,
      ).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});
