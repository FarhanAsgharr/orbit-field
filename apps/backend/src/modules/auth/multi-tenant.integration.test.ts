/**
 * Several companies in one installation.
 *
 * Orbit Field used to allow exactly one registration, on an empty database.
 * That single fact was what made handing the registrant SUPER_ADMIN safe:
 * there was only ever one organisation for an owner to be owner of. Opening
 * signup so anybody can register their own company removes that guarantee, so
 * the isolation it was standing in for has to be real and has to be tested.
 *
 * The question these tests ask is not "can an owner do everything" — of course
 * they can, inside their own company. It is whether an owner is a *stranger*
 * everywhere else: cannot read another company's people, cannot administer
 * them, cannot see their work, and cannot take an email address that already
 * belongs to somebody.
 *
 * Every case is a pair — the owner succeeds inside their own tenant and fails
 * outside it — because a test that only asserted the failure would pass
 * against an installation where nothing works at all.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('mt'),
  name: 'Multi-tenant',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

interface Company {
  orgId: string;
  userId: string;
  email: string;
  password: string;
  token: string;
}

const created: string[] = [];

/** Register a company through the public endpoint, exactly as the console does. */
async function registerCompany(label: string): Promise<Company> {
  const email = `${unique(label)}@example.test`;
  const password = 'Tk9-Vrelm-2026!qz';

  const res = await request(server)
    .post(`${api}/auth/register`)
    .send({
      email,
      password,
      firstName: 'Rhona',
      lastName: label === 'alpha' ? 'Aldridge' : 'Brennan',
      organizationName: `${label} Industries ${unique('n')}`,
      device: device(),
    });
  expect(res.status, res.text.slice(0, 200)).toBe(201);

  const login = await request(server)
    .post(`${api}/auth/login`)
    .send({ email, password, device: device() });
  expect(login.status).toBe(200);

  const orgId = String(login.body.data.organization.id);
  created.push(orgId);

  return {
    orgId,
    userId: String(login.body.data.user.id),
    email,
    password,
    token: login.body.data.tokens.accessToken,
  };
}

let alpha: Company;
let bravo: Company;
/** A member of staff inside Bravo, for Alpha to fail to reach. */
let bravoStaffId: string;

beforeAll(async () => {
  alpha = await registerCompany('alpha');
  bravo = await registerCompany('bravo');

  const staff = await request(server)
    .post(`${api}/users`)
    .set('Authorization', `Bearer ${bravo.token}`)
    .send({
      email: `${unique('bravostaff')}@example.test`,
      firstName: 'Bravo',
      lastName: 'Fieldstone',
      role: 'INSPECTOR',
      password: 'Tk9-Vrelm-2026!qz',
    });
  expect(staff.status).toBe(201);
  bravoStaffId = staff.body.data.id;
});

afterAll(async () => {
  for (const orgId of created) {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('registering a company', () => {
  it('is open, and each registration gets its own organisation', () => {
    expect(alpha.orgId).not.toBe(bravo.orgId);
  });

  it('makes the registrant the owner of what they created', async () => {
    const me = await request(server)
      .get(`${api}/auth/me`)
      .set('Authorization', `Bearer ${alpha.token}`);

    expect(me.status).toBe(200);
    expect(me.body.data.role).toBe('SUPER_ADMIN');
    expect(String(me.body.data.orgId)).toBe(alpha.orgId);
  });

  it('seeds a usable checklist, so the company is not a dead end', async () => {
    const templates = await request(server)
      .get(`${api}/templates`)
      .set('Authorization', `Bearer ${alpha.token}`);

    // Without one, an inspector opens the app, taps "start an inspection" and
    // finds nothing to start.
    expect(templates.status).toBe(200);
    expect(templates.body.data.items.length).toBeGreaterThan(0);
  });
});

describe('an owner inside their own company', () => {
  it('can see and administer their own people', async () => {
    const list = await request(server)
      .get(`${api}/users`)
      .set('Authorization', `Bearer ${alpha.token}`);

    expect(list.status).toBe(200);
    expect(list.body.data.items.map((u: { id: string }) => u.id)).toContain(alpha.userId);
  });
});

describe('an owner is a stranger to every other company', () => {
  it('never sees another company’s people in a listing', async () => {
    const list = await request(server)
      .get(`${api}/users?pageSize=200`)
      .set('Authorization', `Bearer ${alpha.token}`);

    const ids = list.body.data.items.map((u: { id: string }) => u.id);
    expect(ids).not.toContain(bravo.userId);
    expect(ids).not.toContain(bravoStaffId);
  });

  it('cannot read another company’s user by id', async () => {
    const res = await request(server)
      .get(`${api}/users/${bravoStaffId}`)
      .set('Authorization', `Bearer ${alpha.token}`);

    expect([403, 404]).toContain(res.status);
  });

  it('cannot administer another company’s user', async () => {
    /*
     * The case the exemption used to allow. `canManageUser` compared tenants
     * but let a SUPER_ADMIN through, which was survivable when only one
     * organisation could exist and is a cross-company takeover now that
     * anybody can register one.
     */
    const patch = await request(server)
      .patch(`${api}/users/${bravoStaffId}`)
      .set('Authorization', `Bearer ${alpha.token}`)
      .send({ role: 'VIEWER' });
    expect([403, 404]).toContain(patch.status);

    const removed = await request(server)
      .delete(`${api}/users/${bravoStaffId}`)
      .set('Authorization', `Bearer ${alpha.token}`);
    expect([403, 404]).toContain(removed.status);

    const reset = await request(server)
      .post(`${api}/users/${bravoStaffId}/reset-password`)
      .set('Authorization', `Bearer ${alpha.token}`)
      .send({ password: 'Tk9-Vrelm-Reset!qz' });
    expect([403, 404]).toContain(reset.status);

    // And the target is untouched, not merely un-responded-to.
    const target = await prisma.user.findUniqueOrThrow({ where: { id: bravoStaffId } });
    expect(target.role).toBe('INSPECTOR');
    expect(target.deletedAt).toBeNull();
  });

  it('cannot reach another company’s work, clients or settings', async () => {
    for (const path of ['/inspections', '/clients', '/sites', '/templates', '/analytics/summary']) {
      const res = await request(server)
        .get(`${api}${path}?pageSize=200`)
        .set('Authorization', `Bearer ${alpha.token}`);

      if (res.status !== 200) continue;
      const items = res.body.data?.items ?? [];
      for (const row of items) {
        // Whatever comes back must belong to the caller's own company.
        if (row.orgId) expect(String(row.orgId)).toBe(alpha.orgId);
      }
    }

    const org = await request(server)
      .get(`${api}/admin/organization`)
      .set('Authorization', `Bearer ${alpha.token}`);
    expect(String(org.body.data.id)).toBe(alpha.orgId);
  });
});

describe('a company-specific portal is a door to that company only', () => {
  /*
   * The Client Portal is per company: `/acme/login` is Acme's front door. It
   * sends its own slug with the sign-in, and the server must refuse an account
   * belonging to anybody else — otherwise every portal address is a front door
   * to every tenant and the separation is decoration.
   */
  it('lets a company’s own account in through its own portal', async () => {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: alpha.email,
        password: alpha.password,
        organizationSlug: (
          await prisma.organization.findUniqueOrThrow({
            where: { id: alpha.orgId },
            select: { slug: true },
          })
        ).slug,
        device: device(),
      });

    expect(res.status).toBe(200);
    expect(String(res.body.data.organization.id)).toBe(alpha.orgId);
  });

  it('refuses valid credentials presented at another company’s portal', async () => {
    const bravoSlug = (
      await prisma.organization.findUniqueOrThrow({
        where: { id: bravo.orgId },
        select: { slug: true },
      })
    ).slug;

    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({
        // Alpha's owner, correct password, Bravo's portal.
        email: alpha.email,
        password: alpha.password,
        organizationSlug: bravoSlug,
        device: device(),
      });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('says nothing about which company an address belongs to', async () => {
    const bravoSlug = (
      await prisma.organization.findUniqueOrThrow({
        where: { id: bravo.orgId },
        select: { slug: true },
      })
    ).slug;

    const wrongDoor = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: alpha.email, password: alpha.password, organizationSlug: bravoSlug, device: device() });

    const nobody = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: `ghost.${unique('x')}@example.test`,
        password: 'Tk9-Vrelm-2026!qz',
        organizationSlug: bravoSlug,
        device: device(),
      });

    /*
     * Identical answers. "Right password, wrong company" would confirm that
     * the address holds a real account somewhere on the platform — the same
     * thing removing the public company list was meant to stop.
     */
    expect(wrongDoor.status).toBe(nobody.status);
    expect(wrongDoor.body.error.message).toBe(nobody.body.error.message);
  });

  it('still lets the console and the phone app sign in without a company', async () => {
    // Neither is a company-specific front door, so neither sends a slug.
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: alpha.email, password: alpha.password, device: device() });

    expect(res.status).toBe(200);
    expect(String(res.body.data.organization.id)).toBe(alpha.orgId);
  });
});

describe('email addresses across companies', () => {
  it('refuses to register a company with an address already in use', async () => {
    const res = await request(server)
      .post(`${api}/auth/register`)
      .send({
        email: bravo.email,
        password: 'Tk9-Vrelm-2026!qz',
        firstName: 'Impostor',
        lastName: 'Calloway',
        organizationName: `Impostor ${unique('n')}`,
        device: device(),
      });

    expect(res.status).toBe(409);
  });

  it('refuses to create a user with an address another company already holds', async () => {
    /*
     * Sign-in resolves an address with `findFirst`. Two accounts sharing one
     * email means one of those two people silently lands in the other's
     * company on every login, with no way to reach their own — so the address
     * has to be unique across the installation, not merely per company.
     */
    const res = await request(server)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${alpha.token}`)
      .send({
        email: bravo.email,
        firstName: 'Collision',
        lastName: 'Marsden',
        role: 'INSPECTOR',
        password: 'Tk9-Vrelm-2026!qz',
      });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  it('still signs each owner into their own company', async () => {
    for (const company of [alpha, bravo]) {
      const login = await request(server)
        .post(`${api}/auth/login`)
        .send({ email: company.email, password: company.password, device: device() });

      expect(login.status).toBe(200);
      expect(String(login.body.data.organization.id)).toBe(company.orgId);
    }
  });
});
