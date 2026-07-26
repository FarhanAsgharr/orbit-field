/**
 * Authentication, end to end through the real app.
 *
 * Covers the paths where a mistake is a security incident rather than a bug:
 * credential handling, token issuance, refresh rotation, device enrolment and
 * account lockout. Each assertion is written against externally observable
 * behaviour — status codes, headers, and what a second request can then do —
 * because that is what an attacker sees too.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { strongPassword, unique } from '../../test/harness.js';

const app = createApp();
const api = '/api/v1';

const device = (installationId: string) => ({
  installationId,
  name: 'Integration Device',
  platform: 'android' as const,
  osVersion: '14',
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

describe('POST /auth/login', () => {
  it('issues an access and refresh token for valid credentials', async () => {
    const user = org.users.INSPECTOR!;
    const res = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect(res.body.data.tokens.refreshToken).toBeTruthy();
    expect(res.body.data.user.email).toBe(user.email);
    expect(res.body.data.user.role).toBe('INSPECTOR');
  });

  it('never returns the password hash', async () => {
    const user = org.users.ADMIN!;
    const res = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });

    expect(JSON.stringify(res.body)).not.toContain('argon2');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const user = org.users.ADMIN!;
    const wrongPassword = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: strongPassword(), device: device(unique('dev')) });
    const unknownAccount = await request(app)
      .post(`${api}/auth/login`)
      .send({
        email: `${unique('nobody')}@test.invalid`,
        password: strongPassword(),
        device: device(unique('dev')),
      });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // The same message for both, or the endpoint becomes an account oracle.
    expect(wrongPassword.body.error.message).toBe(unknownAccount.body.error.message);
  });

  it('requires a device, because enrolment is what makes offline sync possible', async () => {
    const user = org.users.INSPECTOR!;
    const res = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(422);
    expect(res.body.error.fields).toHaveProperty('device');
  });

  it('enrols distinct devices for distinct installations', async () => {
    const user = org.users.INSPECTOR!;
    const first = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });
    const second = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });

    expect(first.body.data.device.id).not.toBe(second.body.data.device.id);
  });

  it('reuses the device record when the same installation signs in again', async () => {
    const user = org.users.MANAGER!;
    const installation = unique('stable-install');
    const first = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(installation) });
    const second = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(installation) });

    expect(first.body.data.device.id).toBe(second.body.data.device.id);
  });

  it('refuses a deactivated account', async () => {
    const password = strongPassword();
    const email = `${unique('suspended')}@test.invalid`;
    await request(app)
      .post(`${api}/auth/register`)
      .send({
        email,
        password,
        firstName: 'Sus',
        lastName: 'Pended',
        organizationName: unique('Suspended Org'),
        device: device(unique('dev')),
      });
    await prisma.user.updateMany({ where: { email }, data: { status: 'DEACTIVATED' } });

    const res = await request(app)
      .post(`${api}/auth/login`)
      .send({ email, password, device: device(unique('dev')) });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.data?.tokens).toBeUndefined();

    const user = await prisma.user.findFirst({ where: { email }, select: { orgId: true } });
    if (user) await prisma.organization.deleteMany({ where: { id: user.orgId } });
  });
});

describe('access tokens', () => {
  it('are rejected when the signature is tampered with', async () => {
    const user = org.users.ADMIN!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });
    const token: string = login.body.data.tokens.accessToken;

    const res = await request(app)
      .get(`${api}/users`)
      .set('Authorization', `Bearer ${token.slice(0, -3)}AAA`);

    expect(res.status).toBe(401);
  });

  it('are rejected when re-signed with alg=none', async () => {
    const user = org.users.ADMIN!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });
    const [, payload] = (login.body.data.tokens.accessToken as string).split('.');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');

    const res = await request(app)
      .get(`${api}/users`)
      .set('Authorization', `Bearer ${header}.${payload}.`);

    expect(res.status).toBe(401);
  });

  it('are required — an unauthenticated request is refused', async () => {
    const res = await request(app).get(`${api}/users`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });
});

describe('POST /auth/refresh', () => {
  it('exchanges a refresh token for a new access token', async () => {
    const user = org.users.INSPECTOR!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });

    const res = await request(app).post(`${api}/auth/refresh`).send({
      refreshToken: login.body.data.tokens.refreshToken,
      deviceId: login.body.data.device.id,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
  });

  it('rotates: the same refresh token cannot be used twice', async () => {
    const user = org.users.INSPECTOR!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });
    const body = {
      refreshToken: login.body.data.tokens.refreshToken,
      deviceId: login.body.data.device.id,
    };

    const first = await request(app).post(`${api}/auth/refresh`).send(body);
    const replay = await request(app).post(`${api}/auth/refresh`).send(body);

    expect(first.status).toBe(200);
    // Replay is how a stolen refresh token gets used; it must not succeed.
    expect(replay.status).not.toBe(200);
  });

  it('rejects a refresh token that was never issued', async () => {
    const res = await request(app)
      .post(`${api}/auth/refresh`)
      .send({ refreshToken: 'not-a-real-token', deviceId: '01TESTDEVICE00000000000001' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.data?.tokens).toBeUndefined();
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token it was given', async () => {
    const user = org.users.VIEWER!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(unique('dev')) });
    const refreshToken: string = login.body.data.tokens.refreshToken;
    const deviceId: string = login.body.data.device.id;

    const logout = await request(app)
      .post(`${api}/auth/logout`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .send({ refreshToken, deviceId });
    expect(logout.status).toBeLessThan(300);

    const reuse = await request(app).post(`${api}/auth/refresh`).send({ refreshToken, deviceId });
    expect(reuse.status).not.toBe(200);
  });
});

describe('GET /auth/signup-available', () => {
  it('reports whether self-service registration is permitted', async () => {
    const res = await request(app).get(`${api}/auth/signup-available`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.available).toBe('boolean');
  });
});
