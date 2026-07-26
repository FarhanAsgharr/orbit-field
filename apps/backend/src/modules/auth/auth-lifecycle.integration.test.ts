/**
 * Account lifecycle: lockout, password change, session identity, suspension.
 *
 * `auth.integration.test.ts` covers issuing and rotating tokens. This covers
 * what happens to an account over time, and the theme is that **a credential
 * change must invalidate what came before it**.
 *
 * That is the part people get wrong. Changing a password feels like it has
 * worked — the new one signs in — while a 15-minute access token minted before
 * the change keeps working for the rest of its life. Somebody changing their
 * password because they believe it is compromised is doing so precisely to end
 * an attacker's session, so a token that survives the change defeats the only
 * reason they acted.
 *
 * Lockout is tested the same way: not just "the sixth attempt is refused" but
 * "the correct password is refused too while the lock holds", because a lock
 * that admits the right password stops nobody who is guessing.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { hashPassword } from '../../lib/crypto.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { strongPassword, unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('life'),
  name: 'Lifecycle Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg();
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

/** A throwaway account, so a lockout or password change cannot affect other tests. */
async function scratchUser(role = 'INSPECTOR') {
  const password = strongPassword();
  const email = `${unique('scratch')}@test.invalid`;
  const user = await prisma.user.create({
    data: {
      id: unique('u')
        .toUpperCase()
        .replace(/[^0-9A-Z]/g, '0')
        .slice(0, 26)
        .padEnd(26, '0'),
      orgId: org.orgId,
      email,
      emailVerifiedAt: new Date(),
      firstName: 'Scratch',
      lastName: 'Account',
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      role: role as never,
      status: 'ACTIVE',
    },
  });
  return { id: user.id, email, password };
}

const login = (email: string, password: string) =>
  request(server).post(`${api}/auth/login`).send({ email, password, device: device() });

describe('failed attempts and lockout', () => {
  it('locks the account after the configured number of wrong passwords', async () => {
    const user = await scratchUser();

    for (let i = 0; i < env.MAX_FAILED_LOGINS; i++) {
      const res = await login(user.email, strongPassword());
      expect(res.status).toBe(401);
    }

    const locked = await login(user.email, user.password);
    // The correct password must not open a locked account, or the lock stops
    // nobody who is guessing.
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(locked.body.error.message).toMatch(/minute/i);
  });

  it('clears the failure count once a correct password gets through', async () => {
    const user = await scratchUser();

    await login(user.email, strongPassword()).expect(401);
    await login(user.email, user.password).expect(200);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.failedLoginAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('lets the account back in once the lock has expired', async () => {
    const user = await scratchUser();
    for (let i = 0; i < env.MAX_FAILED_LOGINS; i++) {
      await login(user.email, strongPassword());
    }
    await login(user.email, user.password).expect(429);

    // Backdate rather than waiting out ACCOUNT_LOCK_MINUTES.
    await prisma.user.update({
      where: { id: user.id },
      data: { lockedUntil: new Date(Date.now() - 60_000) },
    });

    const res = await login(user.email, user.password);
    expect(res.status).toBe(200);
  });
});

describe('changing a password', () => {
  it('invalidates the tokens that existed before the change', async () => {
    const user = await scratchUser();
    const session = await login(user.email, user.password).expect(200);
    const accessToken = session.body.data.tokens.accessToken as string;
    const refreshToken = session.body.data.tokens.refreshToken as string;

    // The token works right now.
    await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    const next = strongPassword();
    const changed = await request(server)
      .post(`${api}/auth/change-password`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: user.password, newPassword: next });
    expect(changed.status).toBeLessThan(300);

    /*
     * The test and the token are created in the same second, and `iat` has
     * only second resolution — so the comparison cannot tell "minted before
     * the change" from "minted during the same second as it" and deliberately
     * keeps the token, rather than rejecting a session a user has only just
     * legitimately established. Advancing the stored timestamp by a second
     * removes that ambiguity and asserts the mechanism itself.
     *
     * The residual window is under one second on a real deployment.
     */
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordChangedAt: new Date(Date.now() + 1000) },
    });

    // Somebody changing their password to end an attacker's session gets
    // nothing if the attacker's token outlives the change.
    const after = await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(after.status).toBe(401);

    // Refresh tokens are revoked outright, with no timing subtlety.
    const refreshed = await request(server).post(`${api}/auth/refresh`).send({ refreshToken });
    expect(refreshed.status).toBe(401);

    // And the new password works.
    await login(user.email, next).expect(200);
  });

  it('refuses when the current password is wrong', async () => {
    const user = await scratchUser();
    const session = await login(user.email, user.password).expect(200);

    const res = await request(server)
      .post(`${api}/auth/change-password`)
      .set('Authorization', `Bearer ${session.body.data.tokens.accessToken}`)
      .send({ currentPassword: strongPassword(), newPassword: strongPassword() });

    expect(res.status).toBe(401);
    // The old password must still work, or a failed change has locked them out.
    await login(user.email, user.password).expect(200);
  });

  it('holds the new password to the strength policy', async () => {
    const user = await scratchUser();
    const session = await login(user.email, user.password).expect(200);

    const res = await request(server)
      .post(`${api}/auth/change-password`)
      .set('Authorization', `Bearer ${session.body.data.tokens.accessToken}`)
      .send({ currentPassword: user.password, newPassword: 'password123' });

    expect(res.status).toBe(422);
  });

  it('clears the must-change flag an administrator set', async () => {
    const user = await scratchUser();
    await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });

    const session = await login(user.email, user.password).expect(200);
    const next = strongPassword();

    await request(server)
      .post(`${api}/auth/change-password`)
      .set('Authorization', `Bearer ${session.body.data.tokens.accessToken}`)
      .send({ currentPassword: user.password, newPassword: next })
      .expect((res) => expect(res.status).toBeLessThan(300));

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.mustChangePassword).toBe(false);
  });
});

describe('who am I', () => {
  it('returns the caller with their organisation and role, and no secrets', async () => {
    const user = await scratchUser('MANAGER');
    const session = await login(user.email, user.password).expect(200);

    const res = await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${session.body.data.tokens.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(user.id);
    expect(res.body.data.orgId).toBe(org.orgId);
    expect(res.body.data.role).toBe('MANAGER');
    // It returns the resolved subject, not a user row — so there is nothing
    // sensitive to leak in the first place.
    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(res.body.data.email).toBeUndefined();
  });

  it('is refused without a token', async () => {
    expect((await request(server).get(`${api}/auth/me`)).status).toBe(401);
  });

  it('is refused with a token from another installation’s secret', async () => {
    // A token signed by something other than this deployment must never work,
    // even though it is structurally valid.
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(
        JSON.stringify({ sub: org.users.ADMIN!.id, orgId: org.orgId, role: 'SUPER_ADMIN' }),
      ).toString('base64url'),
      Buffer.from('not-a-real-signature').toString('base64url'),
    ].join('.');

    const res = await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});

describe('account status changes take effect immediately', () => {
  it('stops a suspended user mid-session', async () => {
    const user = await scratchUser();
    const session = await login(user.email, user.password).expect(200);
    const accessToken = session.body.data.tokens.accessToken as string;

    await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });

    // Status is checked against the database on every request precisely so a
    // 15-minute token cannot keep a suspended account working.
    const after = await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(after.status).toBeGreaterThanOrEqual(401);

    const attempt = await login(user.email, user.password);
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('refuses a user whose organisation has been switched off', async () => {
    const other = await createTestOrg();
    try {
      const user = other.users.INSPECTOR!;
      await login(user.email, user.password).expect(200);

      await prisma.organization.update({
        where: { id: other.orgId },
        data: { isActive: false },
      });

      const res = await login(user.email, user.password);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error.code).toBe('ORG_MISMATCH');
    } finally {
      await other.cleanup();
    }
  });
});

describe('logout', () => {
  it('ends only the session it was given, not every device the user has', async () => {
    const user = await scratchUser();
    const first = await login(user.email, user.password).expect(200);
    const second = await login(user.email, user.password).expect(200);

    await request(server)
      .post(`${api}/auth/logout`)
      .set('Authorization', `Bearer ${first.body.data.tokens.accessToken}`)
      .send({ refreshToken: first.body.data.tokens.refreshToken })
      .expect((res) => expect(res.status).toBeLessThan(300));

    // Signing out of a phone must not sign somebody out of the tablet they are
    // holding, halfway through an inspection.
    const stillValid = await request(server)
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: second.body.data.tokens.refreshToken });
    expect(stillValid.status).toBe(200);
  });
});

describe('input validation at the edge', () => {
  it('rejects a malformed email before it reaches the database', async () => {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: 'not-an-email', password: strongPassword(), device: device() });
    expect(res.status).toBe(422);
  });

  it('rejects an unknown platform', async () => {
    const user = await scratchUser();
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: user.email,
        password: user.password,
        device: { ...device(), platform: 'blackberry' },
      });
    expect(res.status).toBe(422);
  });

  it('treats the email case-insensitively', async () => {
    const user = await scratchUser();
    const res = await login(user.email.toUpperCase(), user.password);
    expect(res.status).toBe(200);
  });

  it('rejects a body that is not an object at all', async () => {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('"a string"');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
