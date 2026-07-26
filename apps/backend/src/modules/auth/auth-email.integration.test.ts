/**
 * The email-bearing auth flows, verified through the API.
 *
 * The point of these is the wiring, not the transport — `email.integration.test`
 * already proves SMTP and Resend work. What is asserted here is that hitting
 * `/auth/forgot-password` actually causes a message to leave the process
 * carrying a code that then works, which is precisely what was broken: the
 * service minted an OTP, wrote a log line, and delivered nothing.
 */

import { SMTPServer } from 'smtp-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { MAIL_CAPTURE_PORT, unique } from '../../test/harness.js';

const api = '/api/v1';

let smtpServer: SMTPServer;
const inbox: string[] = [];
let app: import('express').Express;
let org: TestOrg;

const device = () => ({
  installationId: unique('mail-dev'),
  name: 'Mail Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

/**
 * Decode enough quoted-printable to read a message body.
 *
 * Two transformations, both load-bearing: soft line breaks (`=\r\n`) are
 * removed because SMTP wraps at 76 characters and will split a token in half,
 * and `=3D` is decoded back to `=` because that is how QP escapes its own
 * marker — without it, a URL reads as `?token=3Dabc...` and every token
 * extracted is prefixed with a stray "3D".
 */
function decodeQuotedPrintable(raw: string): string {
  return raw.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
}

/** Pull the 6-digit code out of a captured message. */
function codeFrom(raw: string): string | null {
  const match = /\b(\d{6})\b/.exec(decodeQuotedPrintable(raw));
  return match ? match[1]! : null;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    smtpServer = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        let raw = '';
        stream.on('data', (c: Buffer) => (raw += c.toString()));
        stream.on('end', () => {
          inbox.push(raw);
          callback();
        });
      },
    });
    // The port the harness already told the app to send to — see harness.ts
    // for why it cannot be chosen here.
    smtpServer.listen(MAIL_CAPTURE_PORT, '127.0.0.1', () => resolve());
  });

  const { createApp } = await import('../../app.js');
  app = createApp();
  org = await createTestOrg();
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
  await new Promise<void>((resolve) => smtpServer.close(() => resolve()));
});

describe('POST /auth/forgot-password', () => {
  it('actually sends a reset code, and the code works', async () => {
    inbox.length = 0;
    const user = org.users.INSPECTOR!;

    const requested = await request(app)
      .post(`${api}/auth/forgot-password`)
      .send({ email: user.email });
    expect(requested.status).toBe(202);

    expect(inbox).toHaveLength(1);
    const code = codeFrom(inbox[0]!);
    expect(code).toBeTruthy();

    // The delivered code must be the one the server will accept — a mail
    // carrying a stale or unrelated code is worse than no mail at all.
    const verified = await request(app)
      .post(`${api}/auth/verify-otp`)
      .send({ email: user.email, code, purpose: 'PASSWORD_RESET' });

    expect(verified.status).toBe(200);
    expect(verified.body.data.actionToken).toBeTruthy();
  });

  it('sends nothing for an unknown address but answers identically', async () => {
    inbox.length = 0;
    const res = await request(app)
      .post(`${api}/auth/forgot-password`)
      .send({ email: `${unique('ghost')}@test.invalid` });

    // Same 202 as the real case: a different status or timing would let an
    // unauthenticated caller enumerate which addresses are registered.
    expect(res.status).toBe(202);
    expect(inbox).toHaveLength(0);
  });

  it('lets the code actually reset the password', async () => {
    inbox.length = 0;
    const user = org.users.VIEWER!;

    await request(app).post(`${api}/auth/forgot-password`).send({ email: user.email });
    const code = codeFrom(inbox[0]!);

    const verified = await request(app)
      .post(`${api}/auth/verify-otp`)
      .send({ email: user.email, code, purpose: 'PASSWORD_RESET' });

    const newPassword = `Rst${Date.now().toString(36)}Xy1`;
    const reset = await request(app)
      .post(`${api}/auth/reset-password`)
      .send({ actionToken: verified.body.data.actionToken, newPassword });
    expect(reset.status).toBeLessThan(300);

    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: newPassword, device: device() });
    expect(login.status).toBe(200);
  });
});

describe('POST /auth/magic-link', () => {
  it('sends a link that signs the user in exactly once', async () => {
    inbox.length = 0;
    const user = org.users.MANAGER!;

    const requested = await request(app).post(`${api}/auth/magic-link`).send({ email: user.email });
    expect(requested.status).toBe(202);
    expect(inbox).toHaveLength(1);

    const token = /token=([A-Za-z0-9_-]+)/.exec(decodeQuotedPrintable(inbox[0]!))?.[1];
    expect(token).toBeTruthy();

    const first = await request(app)
      .post(`${api}/auth/magic-link/consume`)
      .send({ token, device: device() });
    expect(first.status).toBe(200);
    expect(first.body.data.tokens.accessToken).toBeTruthy();

    // Single use: a link sitting in an inbox must not remain a live credential.
    const second = await request(app)
      .post(`${api}/auth/magic-link/consume`)
      .send({ token, device: device() });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('does not reveal whether an address exists', async () => {
    inbox.length = 0;
    const res = await request(app)
      .post(`${api}/auth/magic-link`)
      .send({ email: `${unique('nobody')}@test.invalid` });
    expect(res.status).toBe(202);
    expect(inbox).toHaveLength(0);
  });

  it('rejects a token that was never issued', async () => {
    const res = await request(app)
      .post(`${api}/auth/magic-link/consume`)
      .send({ token: 'a'.repeat(64), device: device() });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /users — invitation email', () => {
  it('emails an invitation when no password is supplied, and reports delivery', async () => {
    inbox.length = 0;
    const admin = org.users.ADMIN!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: admin.email, password: admin.password, device: device() });

    const res = await request(app)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .send({
        email: `${unique('invitee')}@test.invalid`,
        firstName: 'New',
        lastName: 'Joiner',
        role: 'VIEWER',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('INVITED');
    // Reported back so an administrator knows whether to pass details on by
    // hand — an invitation is the recipient's only route into the account.
    expect(res.body.data.emailDelivered).toBe(true);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toContain('Subject:');
  });

  it('sends no invitation when the administrator supplies a password', async () => {
    inbox.length = 0;
    const admin = org.users.ADMIN!;
    const login = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: admin.email, password: admin.password, device: device() });

    const res = await request(app)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .send({
        email: `${unique('direct')}@test.invalid`,
        firstName: 'Direct',
        lastName: 'Create',
        role: 'VIEWER',
        password: `Dir${Date.now().toString(36)}Xy1`,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('ACTIVE');
    // A second "set your password" route in would only confuse the recipient.
    expect(inbox).toHaveLength(0);
  });
});
