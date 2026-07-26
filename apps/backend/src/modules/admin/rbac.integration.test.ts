/**
 * Role-based access control, asserted at the HTTP boundary.
 *
 * RBAC is the control that decides whether an inspector can read another
 * organisation's compliance record, so it is tested by contrast rather than in
 * isolation: for each endpoint, a role that should be allowed and a role that
 * should not, both asserted in the same test. A permission check that silently
 * stopped working would otherwise show up as "everything returns 200", which
 * reads as a passing suite.
 *
 * The user-creation cases also cover privilege escalation, which is the failure
 * mode that matters most: a user must never be able to mint an account at or
 * above their own authority.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { strongPassword, unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('rbac'),
  name: 'RBAC Device',
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

const get = (path: string, role: string) =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

describe('administrative endpoints', () => {
  const adminOnly = ['/users', '/admin/audit-logs', '/analytics/summary'];

  it.each(adminOnly)('%s is readable by ADMIN', async (path) => {
    expect((await get(path, 'ADMIN')).status).toBe(200);
  });

  it.each(adminOnly)('%s is refused for INSPECTOR', async (path) => {
    const res = await get(path, 'INSPECTOR');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it.each(adminOnly)('%s is refused for VIEWER', async (path) => {
    expect((await get(path, 'VIEWER')).status).toBe(403);
  });
});

describe('shared endpoints', () => {
  const shared = ['/inspections', '/templates', '/admin/organization'];

  it.each(shared)('%s is readable by both ADMIN and INSPECTOR', async (path) => {
    expect((await get(path, 'ADMIN')).status).toBe(200);
    expect((await get(path, 'INSPECTOR')).status).toBe(200);
  });
});

describe('POST /users — privilege escalation', () => {
  const invite = (role: string, body: Record<string, unknown>) =>
    request(server).post(`${api}/users`).set('Authorization', `Bearer ${tokens[role]}`).send(body);

  it('lets an ADMIN create a role below their own', async () => {
    const res = await invite('ADMIN', {
      email: `${unique('created')}@test.invalid`,
      firstName: 'New',
      lastName: 'Inspector',
      role: 'INSPECTOR',
      password: strongPassword(),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('INSPECTOR');
    // A supplied password means the account is usable immediately; without one
    // it would sit INVITED waiting for an email this install may not send.
    expect(res.body.data.status).toBe('ACTIVE');
  });

  it('refuses an ADMIN creating a peer ADMIN', async () => {
    const res = await invite('ADMIN', {
      email: `${unique('peer')}@test.invalid`,
      firstName: 'Peer',
      lastName: 'Admin',
      role: 'ADMIN',
      password: strongPassword(),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a SUPER_ADMIN creating another SUPER_ADMIN', async () => {
    const res = await invite('SUPER_ADMIN', {
      email: `${unique('peer-super')}@test.invalid`,
      firstName: 'Peer',
      lastName: 'Super',
      role: 'SUPER_ADMIN',
      password: strongPassword(),
    });
    expect(res.status).toBe(403);
  });

  it('refuses an INSPECTOR creating anyone at all', async () => {
    const res = await invite('INSPECTOR', {
      email: `${unique('escalate')}@test.invalid`,
      firstName: 'Esc',
      lastName: 'Alate',
      role: 'VIEWER',
      password: strongPassword(),
    });
    expect(res.status).toBe(403);
  });

  it('enforces the password policy on admin-created accounts', async () => {
    const res = await invite('ADMIN', {
      email: `${unique('weak')}@test.invalid`,
      firstName: 'Weak',
      lastName: 'Pass',
      role: 'VIEWER',
      password: 'short',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty('password');
  });

  it('creates an INVITED account when no password is supplied', async () => {
    const res = await invite('ADMIN', {
      email: `${unique('invited')}@test.invalid`,
      firstName: 'Inv',
      lastName: 'Ited',
      role: 'VIEWER',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('INVITED');
  });

  it('never returns a password hash for a created user', async () => {
    const res = await invite('ADMIN', {
      email: `${unique('nohash')}@test.invalid`,
      firstName: 'No',
      lastName: 'Hash',
      role: 'VIEWER',
      password: strongPassword(),
    });
    expect(JSON.stringify(res.body)).not.toContain('argon2');
  });

  it('refuses a duplicate email inside the same organisation', async () => {
    const email = `${unique('dupe')}@test.invalid`;
    const body = {
      email,
      firstName: 'Du',
      lastName: 'Pe',
      role: 'VIEWER',
      password: strongPassword(),
    };
    expect((await invite('ADMIN', body)).status).toBe(201);
    expect((await invite('ADMIN', body)).status).toBe(409);
  });
});

describe('tenant isolation', () => {
  it('does not leak another organisation’s users', async () => {
    const other = await createTestOrg();
    try {
      const res = await get('/users', 'ADMIN');
      const emails: string[] = (res.body.data.items ?? []).map((u: { email: string }) => u.email);
      expect(emails.length).toBeGreaterThan(0);
      for (const user of Object.values(other.users)) {
        expect(emails).not.toContain(user.email);
      }
    } finally {
      await other.cleanup();
    }
  });
});

describe('first-login password change', () => {
  const invite = (role: string, body: Record<string, unknown>) =>
    request(server).post(`${api}/users`).set('Authorization', `Bearer ${tokens[role]}`).send(body);

  it('flags an account whose password the administrator chose', async () => {
    const email = `${unique('forced')}@test.invalid`;
    const password = strongPassword();
    const created = await invite('ADMIN', {
      email,
      firstName: 'Forced',
      lastName: 'Change',
      role: 'VIEWER',
      password,
    });
    expect(created.status).toBe(201);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email, password, device: device() });

    // The session is issued so the app is usable, but the client is told the
    // credential is shared: the owner did not choose it and it travelled out
    // of band, so it is known to at least two people until they replace it.
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(true);
  });

  it('does not flag an account that set its own password', async () => {
    const user = org.users.INSPECTOR!;
    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    expect(login.body.data.user.mustChangePassword).toBe(false);
  });

  it('clears the flag once the user changes the password themselves', async () => {
    const email = `${unique('clears')}@test.invalid`;
    const initial = strongPassword();
    await invite('ADMIN', {
      email,
      firstName: 'Clears',
      lastName: 'Flag',
      role: 'VIEWER',
      password: initial,
    });

    const first = await request(server)
      .post(`${api}/auth/login`)
      .send({ email, password: initial, device: device() });
    expect(first.body.data.user.mustChangePassword).toBe(true);

    const chosen = strongPassword();
    const changed = await request(server)
      .post(`${api}/auth/change-password`)
      .set('Authorization', `Bearer ${first.body.data.tokens.accessToken}`)
      .send({ currentPassword: initial, newPassword: chosen });
    expect(changed.status).toBeLessThan(300);

    const second = await request(server)
      .post(`${api}/auth/login`)
      .send({ email, password: chosen, device: device() });
    expect(second.body.data.user.mustChangePassword).toBe(false);
  });
});
