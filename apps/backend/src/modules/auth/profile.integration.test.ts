/**
 * Self-service account management.
 *
 * `/me` is deliberately minimal — the mobile app calls it on every cold start
 * and only needs identity and scope. Everything a person wants to see or change
 * about their own account had no endpoint at all, so an inspector could not
 * read their own department, and only an administrator could change anybody's
 * details.
 *
 * The rule under test is that self-service stops exactly where authority
 * begins: you may change your name and your phone number, and you may not
 * change your role, your status or your email. A person who can raise their own
 * role makes every permission check in the system advisory.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('pf'),
  name: 'Profile Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;
let token = '';

beforeAll(async () => {
  org = await createTestOrg();
  const user = org.users.INSPECTOR!;
  const res = await request(server)
    .post(`${api}/auth/login`)
    .send({ email: user.email, password: user.password, device: device() });
  token = res.body.data.tokens.accessToken;
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe('reading your own profile', () => {
  it('returns the details /me deliberately omits', async () => {
    const res = await request(server).get(`${api}/auth/profile`).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(org.users.INSPECTOR!.email);
    expect(res.body.data.role).toBe('INSPECTOR');
    expect(res.body.data.organization?.name).toBeTruthy();
    expect(Array.isArray(res.body.data.devices)).toBe(true);
  });

  it('never returns the password hash', async () => {
    const res = await request(server).get(`${api}/auth/profile`).set(auth());
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('needs a session', async () => {
    expect((await request(server).get(`${api}/auth/profile`)).status).toBe(401);
  });
});

describe('editing your own profile', () => {
  it('changes the details that are yours to change', async () => {
    const res = await request(server).patch(`${api}/auth/profile`).set(auth()).send({
      firstName: 'Renamed',
      phone: '+44 20 7946 0000',
      employeeId: 'EMP-777',
      jobTitle: 'Senior Inspector',
    });

    expect(res.status).toBe(200);
    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: org.users.INSPECTOR!.id },
    });
    expect(stored.firstName).toBe('Renamed');
    expect(stored.employeeId).toBe('EMP-777');
    expect(stored.jobTitle).toBe('Senior Inspector');
  });

  it('ignores a role or status somebody adds to the body', async () => {
    const res = await request(server).patch(`${api}/auth/profile`).set(auth()).send({
      firstName: 'Still Me',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      email: 'new@x.invalid',
    });

    expect(res.status).toBe(200);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: org.users.INSPECTOR!.id },
    });
    // The whole point: self-service stops where authority begins.
    expect(stored.role).toBe('INSPECTOR');
    expect(stored.email).toBe(org.users.INSPECTOR!.email);
  });

  it('audits the change', async () => {
    await request(server)
      .patch(`${api}/auth/profile`)
      .set(auth())
      .send({ department: 'Compliance' })
      .expect(200);

    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: org.users.INSPECTOR!.id, action: 'RECORD_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });
    expect((log?.metadata as { self?: boolean })?.self).toBe(true);
  });

  it('rejects an avatar that is not a URL', async () => {
    const res = await request(server)
      .patch(`${api}/auth/profile`)
      .set(auth())
      .send({ avatarUrl: 'not a url' });
    expect(res.status).toBe(422);
  });
});

describe('signing out everywhere', () => {
  it('revokes every device and every refresh token', async () => {
    const user = org.users.MANAGER!;
    const first = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });

    const res = await request(server)
      .post(`${api}/auth/logout-all`)
      .set({ Authorization: `Bearer ${first.body.data.tokens.accessToken}` });

    expect(res.status).toBe(200);
    expect(res.body.data.devicesRevoked).toBeGreaterThanOrEqual(2);

    expect(await prisma.device.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      0,
    );

    // The refresh token is dead, which is what stops a signed-out phone
    // silently renewing itself.
    const refreshed = await request(server)
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: first.body.data.tokens.refreshToken });
    expect(refreshed.status).toBe(401);
  });
});
