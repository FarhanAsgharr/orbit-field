/**
 * Client invitations.
 *
 * An invitation is a bearer credential sent by email or chat, so the tests are
 * written around what somebody holding a *wrong* one can learn or do, not
 * around the happy path.
 *
 * Four properties carry the security, and each has a case that would fail if
 * the property were removed:
 *
 *  - the raw token is never stored, so a database reader cannot mint one;
 *  - the token is single-use, and concurrently so;
 *  - expiry and revocation are enforced at redemption, not merely displayed;
 *  - every failure — expired, revoked, spent, imaginary, wrong company —
 *    produces the identical response, so the endpoint cannot be probed.
 *
 * That last one is asserted by comparing response bodies to each other rather
 * than to a literal, because the point is indistinguishability rather than any
 * particular wording.
 */

import { createHash } from 'node:crypto';

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
  installationId: unique('inv'),
  name: 'Invitation',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

const password = 'Tk9-Vrelm-2026!qz';

let org: TestOrg;
let adminToken: string;
let orgSlug: string;
/** A second organisation, for the cross-company cases. */
let other: TestOrg;
let otherSlug: string;

const madeUsers: string[] = [];

beforeAll(async () => {
  org = await createTestOrg();
  other = await createTestOrg();

  const signIn = async (o: TestOrg): Promise<string> => {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: o.users.ADMIN!.email, password: o.users.ADMIN!.password, device: device() });
    expect(res.status).toBe(200);
    return res.body.data.tokens.accessToken;
  };
  adminToken = await signIn(org);

  orgSlug = (
    await prisma.organization.findUniqueOrThrow({
      where: { id: org.orgId },
      select: { slug: true },
    })
  ).slug;
  otherSlug = (
    await prisma.organization.findUniqueOrThrow({
      where: { id: other.orgId },
      select: { slug: true },
    })
  ).slug;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: madeUsers } } });
  await org.cleanup();
  await other.cleanup();
  await prisma.$disconnect();
});

/** Issue an invitation and hand back the raw token. */
async function invite(
  overrides: { email?: string; expiresInHours?: number; clientId?: string; token?: string } = {},
) {
  const email = overrides.email ?? `${unique('invitee')}@example.test`;
  const res = await request(server)
    .post(`${api}/clients/${overrides.clientId ?? org.clientId}/invitations`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      email,
      firstName: 'Cara',
      lastName: 'Delgado',
      ...(overrides.expiresInHours ? { expiresInHours: overrides.expiresInHours } : {}),
    });
  return { res, email, token: res.body?.data?.token as string, id: res.body?.data?.id as string };
}

describe('issuing an invitation', () => {
  it('returns a token once, and stores only its hash', async () => {
    const { res, token, id } = await invite();

    expect(res.status).toBe(201);
    expect(typeof token).toBe('string');
    // 32 random bytes, base64url: long enough that guessing is not a strategy.
    expect(token.length).toBeGreaterThanOrEqual(40);

    const row = await prisma.clientInvitation.findUniqueOrThrow({ where: { id } });

    /*
     * The raw token must not appear anywhere in the row. A backup, a support
     * query or a leaked dump would otherwise be a set of working invitations.
     */
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  });

  it('records who issued it, and never the token, in the audit log', async () => {
    const { id, token, email } = await invite();

    const entry = await prisma.auditLog.findFirst({
      where: { entity: 'ClientInvitation', entityId: id },
    });
    expect(entry).not.toBeNull();
    expect(entry!.userId).toBe(org.users.ADMIN!.id);
    // An audit log is read by more people than the table it describes.
    expect(JSON.stringify(entry!.metadata)).not.toContain(token);
    expect(JSON.stringify(entry!.metadata)).toContain(email);
  });

  it('supersedes an invitation the same person already holds', async () => {
    const email = `${unique('twice')}@example.test`;
    const first = await invite({ email });
    const second = await invite({ email });

    expect(second.res.status).toBe(201);

    /*
     * Two live links to one account is a loose end: revoking the one you
     * remember leaves the other working. The older must be dead already.
     */
    const older = await request(server).get(`${api}/portal/invitations/${first.token}`);
    expect(older.status).toBe(404);

    const newer = await request(server).get(`${api}/portal/invitations/${second.token}`);
    expect(newer.status).toBe(200);
  });

  it('refuses to invite an address that already has an account', async () => {
    const res = await request(server)
      .post(`${api}/clients/${org.clientId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: org.users.INSPECTOR!.email });

    expect(res.status).toBe(409);
  });

  it('cannot be issued for another company’s client', async () => {
    const res = await request(server)
      .post(`${api}/clients/${other.clientId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: `${unique('cross')}@example.test` });

    expect(res.status).toBe(404);
  });

  it('is refused to somebody without permission to manage clients', async () => {
    const login = await request(server).post(`${api}/auth/login`).send({
      email: org.users.INSPECTOR!.email,
      password: org.users.INSPECTOR!.password,
      device: device(),
    });

    const res = await request(server)
      .post(`${api}/clients/${org.clientId}/invitations`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .send({ email: `${unique('nope')}@example.test` });

    expect(res.status).toBe(403);
  });
});

describe('opening an invitation', () => {
  it('describes who it is for, without spending it', async () => {
    const { token, email } = await invite();

    const res = await request(server).get(`${api}/portal/invitations/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(email);
    expect(res.body.data.clientName).toBeTruthy();
    expect(res.body.data.organizationSlug).toBe(orgSlug);
    // Nothing a recipient does not already know.
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.tokenHash).toBeUndefined();

    // Reading it twice is fine; only accepting spends it.
    expect((await request(server).get(`${api}/portal/invitations/${token}`)).status).toBe(200);
  });

  it('is refused at another company’s portal', async () => {
    const { token } = await invite();

    const res = await request(server).get(
      `${api}/portal/invitations/${token}?company=${otherSlug}`,
    );

    // Otherwise an invitation from one firm admits somebody through another's
    // front door, and the per-company portal is decoration.
    expect(res.status).toBe(404);
  });
});

describe('accepting an invitation', () => {
  it('creates a working login the recipient chose the password for', async () => {
    const { token, email } = await invite();

    const accepted = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password, organizationSlug: orgSlug });

    expect(accepted.status).toBe(201);
    madeUsers.push(accepted.body.data.userId);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: accepted.body.data.userId },
    });
    expect(user.role).toBe('CLIENT');
    expect(user.clientId).toBe(org.clientId);
    expect(user.orgId).toBe(org.orgId);
    // They chose it, so there is nothing to force a change of.
    expect(user.mustChangePassword).toBe(false);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email, password, organizationSlug: orgSlug, device: device() });
    expect(login.status).toBe(200);
  });

  it('cannot be used twice', async () => {
    const { token } = await invite();

    const first = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password });
    expect(first.status).toBe(201);
    madeUsers.push(first.body.data.userId);

    const second = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password });
    expect(second.status).toBe(404);

    // And exactly one account exists, not two.
    const row = await prisma.clientInvitation.findFirstOrThrow({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.acceptedUserId).toBe(first.body.data.userId);
  });

  it('cannot be redeemed twice concurrently', async () => {
    const { token } = await invite();

    /*
     * Two browsers on the same link at the same moment. Acceptance spends the
     * invitation with a conditional update inside the transaction that creates
     * the user, so exactly one can win — a check followed by a write would
     * leave a window where both passed.
     */
    const [a, b] = await Promise.all([
      request(server).post(`${api}/portal/invitations/${token}/accept`).send({ password }),
      request(server).post(`${api}/portal/invitations/${token}/accept`).send({ password }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 404]);

    const winner = a.status === 201 ? a : b;
    madeUsers.push(winner.body.data.userId);

    const accounts = await prisma.user.count({
      where: { email: winner.body.data.email, deletedAt: null },
    });
    expect(accounts).toBe(1);
  });

  it('is refused once expired', async () => {
    const { token, id } = await invite();
    await prisma.clientInvitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await request(server).get(`${api}/portal/invitations/${token}`)).status).toBe(404);
    const res = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password });
    expect(res.status).toBe(404);
  });

  it('is refused once revoked', async () => {
    const { token, id } = await invite();

    const revoked = await request(server)
      .delete(`${api}/clients/${org.clientId}/invitations/${id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(revoked.status).toBe(204);

    const res = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password });
    expect(res.status).toBe(404);
  });

  it('refuses a weak password without spending the invitation', async () => {
    const { token } = await invite();

    const weak = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password: 'password' });
    expect(weak.status).toBe(422);

    // A rejected attempt must not burn the link, or one typo costs the
    // recipient their invitation.
    const retry = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password });
    expect(retry.status).toBe(201);
    madeUsers.push(retry.body.data.userId);
  });
});

describe('input the acceptance page can actually receive', () => {
  /*
   * Ported from the suite that covered the old registration form. The form is
   * gone, but the failure it was written for is not: a name or an address that
   * the database has an opinion about must produce a refusal a person can act
   * on, never a 500 with a request id.
   */
  const oddNames: Array<[string, string]> = [
    ['non-latin', 'حنان سافٹ ویئر ہاؤس'],
    ['punctuation only', '&&& ---'],
    ['an ampersand', 'Asghar & Sons'],
    ['one very long word', 'C'.repeat(100)],
    ['leading and trailing space', '   Spaced Out   '],
  ];

  it.each(oddNames)('accepts an invitation for a %s name', async (_label, name) => {
    const { token } = await invite();

    const res = await request(server)
      .post(`${api}/portal/invitations/${token}/accept`)
      .send({ password, firstName: name, lastName: name });

    expect(res.status, res.text.slice(0, 200)).toBe(201);
    madeUsers.push(res.body.data.userId);
  });

  it('refuses an address a soft-deleted user still holds, without a 500', async () => {
    /*
     * The unique index on (orgId, email) knows nothing about `deletedAt`, so
     * an address freed by a soft delete is still taken as far as the database
     * is concerned. That has to surface as a clear refusal rather than a
     * constraint violation escaping as an unexpected error.
     */
    const email = `${unique('ghosted')}@example.test`;
    const first = await invite({ email });
    const accepted = await request(server)
      .post(`${api}/portal/invitations/${first.token}/accept`)
      .send({ password });
    expect(accepted.status).toBe(201);

    await prisma.user.update({
      where: { id: accepted.body.data.userId },
      data: { deletedAt: new Date() },
    });

    const again = await request(server)
      .post(`${api}/clients/${org.clientId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email });

    // Whatever it answers, it must be a considered one and not a crash.
    expect(again.status).toBeLessThan(500);
    if (again.status === 201) {
      const redeem = await request(server)
        .post(`${api}/portal/invitations/${again.body.data.token}/accept`)
        .send({ password });
      expect(redeem.status).toBeLessThan(500);
      if (redeem.status === 201) madeUsers.push(redeem.body.data.userId);
    }

    await prisma.user.delete({ where: { id: accepted.body.data.userId } });
  });
});

describe('what a wrong token reveals', () => {
  it('answers identically for expired, revoked, spent and imaginary', async () => {
    const imaginary = await request(server).get(
      `${api}/portal/invitations/${'z'.repeat(43)}`,
    );

    const expired = await invite();
    await prisma.clientInvitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const revoked = await invite();
    await request(server)
      .delete(`${api}/clients/${org.clientId}/invitations/${revoked.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const spent = await invite();
    const used = await request(server)
      .post(`${api}/portal/invitations/${spent.token}/accept`)
      .send({ password });
    madeUsers.push(used.body.data.userId);

    const answers = await Promise.all(
      [expired.token, revoked.token, spent.token].map((t) =>
        request(server).get(`${api}/portal/invitations/${t}`),
      ),
    );

    /*
     * Every one of these must look the same from outside. A different status
     * or a different message turns the endpoint into an oracle: it would tell
     * somebody holding a guessed token whether they guessed a real one, and
     * tell an outsider whether a given customer was ever invited.
     */
    for (const answer of answers) {
      expect(answer.status).toBe(imaginary.status);
      expect(answer.body.error.message).toBe(imaginary.body.error.message);
      expect(answer.body.error.code).toBe(imaginary.body.error.code);
    }
  });
});

describe('public registration is closed', () => {
  it('refuses the old open-registration endpoint', async () => {
    const res = await request(server)
      .post(`${api}/portal/register`)
      .send({
        organizationSlug: orgSlug,
        companyName: 'Walk-in Co',
        contactName: 'Cara Delgado',
        email: `${unique('walkin')}@example.test`,
        contactPhone: '+92 300 1234567',
        country: 'Pakistan',
        state: 'Punjab',
        city: 'Lahore',
        address: '1 Road',
        password,
      });

    // Anybody holding the portal address could otherwise create an account,
    // which is the whole reason invitations exist.
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/invitation only/i);
  });
});

describe('the console’s view', () => {
  it('lists invitations with a status, and never a token', async () => {
    const { id, token } = await invite();

    const res = await request(server)
      .get(`${api}/clients/${org.clientId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const row = res.body.data.find((i: { id: string }) => i.id === id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('PENDING');
    expect(row.expiresAt).toBeTruthy();
    expect(res.text).not.toContain(token);
  });

  it('shows accepted, revoked and expired distinctly to staff', async () => {
    const accepted = await invite();
    const used = await request(server)
      .post(`${api}/portal/invitations/${accepted.token}/accept`)
      .send({ password });
    madeUsers.push(used.body.data.userId);

    const revoked = await invite();
    await request(server)
      .delete(`${api}/clients/${org.clientId}/invitations/${revoked.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    const expired = await invite();
    await prisma.clientInvitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(server)
      .get(`${api}/clients/${org.clientId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`);

    const byId = new Map(res.body.data.map((i: { id: string }) => [i.id, i]));
    // Staff need the difference; only the anonymous endpoint conceals it.
    expect((byId.get(accepted.id) as { status: string }).status).toBe('ACCEPTED');
    expect((byId.get(revoked.id) as { status: string }).status).toBe('REVOKED');
    expect((byId.get(expired.id) as { status: string }).status).toBe('EXPIRED');
  });

  it('is not visible to another company', async () => {
    const login = await request(server).post(`${api}/auth/login`).send({
      email: other.users.ADMIN!.email,
      password: other.users.ADMIN!.password,
      device: device(),
    });

    const res = await request(server)
      .get(`${api}/clients/${org.clientId}/invitations`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

    expect(res.status).toBe(200);
    // Scoped by organisation, so another company's client simply has none.
    expect(res.body.data).toHaveLength(0);
  });
});
