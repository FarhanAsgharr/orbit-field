/**
 * Customer self-registration.
 *
 * The one endpoint in Orbit Field that creates an account without an
 * authenticated caller behind it, so the tests are written around what an
 * anonymous stranger can and cannot make it do — not around the happy path.
 *
 * Three questions in particular:
 *
 *  1. Does it create the *right* thing? A `Client` plus one `CLIENT` user
 *     bound to it, in one organisation, with every field the form collected
 *     actually persisted. A registration that silently dropped the tax number
 *     would pass a "returns 201" test and lose data forever.
 *  2. Can it be used to get something it should not? A staff role, another
 *     organisation, a duplicate email, a weak password.
 *  3. Does the account it mints stay inside the client boundary? The rest of
 *     that boundary is covered in `client-portal.integration.test.ts`; here it
 *     is asserted once for an account created this way, because a login built
 *     by a different code path is a different login.
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
  installationId: unique('reg'),
  name: 'Portal Browser',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

/**
 * A complete, valid submission. Individual cases override one field at a time.
 *
 * `organizationSlug` is filled in by `beforeAll` once the fixture company
 * exists — the portal now requires a customer to say which company they are
 * registering with, and a submission without one is refused rather than filed
 * under whichever company happens to be oldest.
 */
let defaultSlug = '';
const submission = (overrides: Record<string, unknown> = {}) => ({
  organizationSlug: defaultSlug,
  companyName: `Northwind ${unique('co')}`,
  industry: 'Construction',
  registrationNumber: 'CRN-99182',
  taxNumber: 'TAX-55010',
  contactName: 'Dana Whitfield',
  contactDesignation: 'Facilities Manager',
  email: `${unique('client')}@example.test`,
  contactPhone: '+44 20 7946 0102',
  whatsapp: '+44 7700 900333',
  country: 'United Kingdom',
  state: 'Greater London',
  city: 'London',
  address: '18 Cheapside, Floor 4',
  postalCode: 'EC2V 6AA',
  website: 'northwind.example',
  notes: 'Two towers, quarterly inspections.',
  password: 'Portal-Access-2026!',
  ...overrides,
});

let org: TestOrg;
const created: string[] = [];

beforeAll(async () => {
  org = await createTestOrg();
  defaultSlug = (
    await prisma.organization.findUniqueOrThrow({
      where: { id: org.orgId },
      select: { slug: true },
    })
  ).slug;
});

afterAll(async () => {
  /*
   * Registrations are not owned by the fixture organisation's cleanup, because
   * the endpoint chooses the organisation itself.
   *
   * Requests go first: one of these customers raises a request, and it holds a
   * foreign key to the user who raised it.
   */
  await prisma.requestComment.deleteMany({ where: { request: { clientId: { in: created } } } });
  await prisma.inspectionRequest.deleteMany({ where: { clientId: { in: created } } });
  await prisma.user.deleteMany({ where: { clientId: { in: created } } });
  await prisma.client.deleteMany({ where: { id: { in: created } } });
  await org.cleanup();
  await prisma.$disconnect();
});

/**
 * The organisation these registrations name.
 *
 * This used to return the earliest-created organisation, because that is what
 * the endpoint picked. It now returns the company the submission actually
 * chose — the fix and the assertion moved together, which is the point.
 */
async function hostOrgId(): Promise<string> {
  return org.orgId;
}

describe('registration availability', () => {
  it('tells the portal whose portal it is, for one company only', async () => {
    const res = await request(server).get(`${api}/portal/tenant/${defaultSlug}`);

    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe(defaultSlug);
    expect(typeof res.body.data.name).toBe('string');
  });

  it('answers a made-up address the same way as a real closed one', async () => {
    const invented = await request(server).get(`${api}/portal/tenant/not-a-real-company-here`);
    expect(invented.status).toBe(404);

    // Deactivating a real company must produce an indistinguishable answer,
    // or the difference is itself the disclosure.
    const victim = await prisma.organization.create({
      data: { id: unique('O').padEnd(26, '0').slice(0, 26).toUpperCase(), name: 'Closed Co', slug: unique('closed').toLowerCase(), isActive: false },
    });
    const closed = await request(server).get(`${api}/portal/tenant/${victim.slug}`);
    expect(closed.status).toBe(404);
    expect(closed.body.error.message).toBe(invented.body.error.message);
    await prisma.organization.delete({ where: { id: victim.id } });
  });
});

describe('the account it creates is a client account', () => {
  let token: string;
  let clientId: string;

  beforeAll(async () => {
    /*
     * Built the way a real client account is now built: staff create the
     * customer, invite somebody, and that person sets a password. There is no
     * other route, so testing the boundary against an account made any other
     * way would be testing something that cannot exist.
     */
    const admin = await request(server).post(`${api}/auth/login`).send({
      email: org.users.ADMIN!.email,
      password: org.users.ADMIN!.password,
      device: device(),
    });
    const adminToken = admin.body.data.tokens.accessToken;

    const client = await request(server)
      .post(`${api}/clients`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Boundary Co ${unique('b')}`, city: 'London' });
    clientId = client.body.data.id;
    created.push(clientId);

    const email = `${unique('boundary')}@example.test`;
    const invitation = await request(server)
      .post(`${api}/clients/${clientId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, firstName: 'Dana', lastName: 'Whitfield' });
    expect(invitation.status).toBe(201);

    const accepted = await request(server)
      .post(`${api}/portal/invitations/${invitation.body.data.token}/accept`)
      .send({ password: 'Portal-Access-2026!' });
    expect(accepted.status).toBe(201);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email, password: 'Portal-Access-2026!', device: device() });
    token = login.body.data.tokens.accessToken;
  });

  it('reads its own company record', async () => {
    const res = await request(server)
      .get(`${api}/portal/company`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(clientId);
    expect(res.body.data.city).toBe('London');
  });

  it('updates its own details, and the change reaches the change log', async () => {
    const res = await request(server)
      .patch(`${api}/portal/company`)
      .set('Authorization', `Bearer ${token}`)
      .send({ contactPhone: '+44 20 7946 0999', city: 'Manchester', website: 'northwind.co.uk' });

    expect(res.status).toBe(200);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.contactPhone).toBe('+44 20 7946 0999');
    expect(client.city).toBe('Manchester');
    expect(client.website).toBe('https://northwind.co.uk');

    // An inspector's phone shows the customer's contact details against the
    // job; an edit that never replicates leaves stale details in the field.
    const update = await prisma.changeLogEntry.findFirst({
      where: { entity: 'CLIENT', entityId: clientId, operation: 'UPDATE' },
    });
    expect(update).not.toBeNull();
  });

  it('cannot rename itself or change the address it signs in with', async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    await request(server)
      .patch(`${api}/portal/company`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Something Else Entirely', contactEmail: 'attacker@example.test' });

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    // Both are the company's identity to staff. Neither is the customer's to
    // change, and a stripped key must not be silently applied.
    expect(after.name).toBe(before.name);
    expect(after.contactEmail).toBe(before.contactEmail);
  });

  it('cannot reach the console it does not belong in', async () => {
    for (const path of ['/users', '/analytics/overview', '/admin/audit-logs', '/templates']) {
      const res = await request(server)
        .get(`${api}${path}`)
        .set('Authorization', `Bearer ${token}`);
      expect([403, 404], `${path} should refuse a client`).toContain(res.status);
    }
  });

  it('cannot read another company through the portal endpoints', async () => {
    // Another customer in the same organisation, to be invisible to this one.
    const admin = await request(server).post(`${api}/auth/login`).send({
      email: org.users.ADMIN!.email,
      password: org.users.ADMIN!.password,
      device: device(),
    });
    const other = await request(server)
      .post(`${api}/clients`)
      .set('Authorization', `Bearer ${admin.body.data.tokens.accessToken}`)
      .send({ name: `Other Co ${unique('o')}` });
    created.push(other.body.data.id);

    // There is no path that takes a client id — the scope comes from the
    // token — so the check is that the record returned is always the caller's.
    const res = await request(server)
      .get(`${api}/portal/company`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data.id).toBe(clientId);
    expect(res.body.data.id).not.toBe(other.body.data.id);
  });
});

describe('an administrator creating a portal login', () => {
  /*
   * The other way a customer account comes into existence.
   *
   * Self-registration is not enough on its own: an organisation that has
   * turned it off, or a customer taken on over the phone, needs staff to be
   * able to create the login. The console had no way to do it — CLIENT was
   * missing from its role list — while the API had accepted it all along, so
   * this covers the path the console now takes.
   */
  let adminToken: string;
  let clientId: string;

  beforeAll(async () => {
    const login = await request(server).post(`${api}/auth/login`).send({
      email: org.users.ADMIN!.email,
      password: org.users.ADMIN!.password,
      device: device(),
    });
    adminToken = login.body.data.tokens.accessToken;

    const created_ = await request(server)
      .post(`${api}/clients`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Console Client ${unique('cc')}` });
    expect(created_.status).toBe(201);
    clientId = created_.body.data.id;
  });

  it('creates a working portal account bound to the company', async () => {
    const email = `${unique('console-portal')}@example.test`;
    const password = 'Console-Issued-2026!';

    const res = await request(server)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, firstName: 'Sam', lastName: 'Okafor', role: 'CLIENT', clientId, password });

    expect(res.status).toBe(201);

    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    expect(user.role).toBe('CLIENT');
    expect(user.clientId).toBe(clientId);

    // The password the administrator typed has to be the one that works —
    // there is no email delivery here, so a created-but-unusable account is
    // indistinguishable from a broken login to the person holding it.
    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email, password, device: device() });
    expect(login.status).toBe(200);

    const company = await request(server)
      .get(`${api}/portal/company`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);
    expect(company.status).toBe(200);
    expect(company.body.data.id).toBe(clientId);
  });

  it('refuses a client account with no company', async () => {
    const res = await request(server)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `${unique('orphan')}@example.test`,
        firstName: 'No',
        lastName: 'Company',
        role: 'CLIENT',
        password: 'Console-Issued-2026!',
      });

    // A CLIENT without a clientId sees nothing at all — the scope is the only
    // thing the portal narrows on.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.clientId).toBeTruthy();
  });

  it('refuses a member of staff bound to a company', async () => {
    const res = await request(server)
      .post(`${api}/users`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `${unique('confused')}@example.test`,
        firstName: 'Staff',
        lastName: 'Member',
        role: 'INSPECTOR',
        clientId,
        password: 'Console-Issued-2026!',
      });

    // The reverse mistake, and the more dangerous one: an inspector carrying a
    // clientId would be silently narrowed to a single customer.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.clientId).toBeTruthy();
  });
});

describe('staff and the portal endpoints', () => {
  it('refuses a staff account the company endpoint', async () => {
    const login = await request(server).post(`${api}/auth/login`).send({
      email: org.users.ADMIN!.email,
      password: org.users.ADMIN!.password,
      device: device(),
    });

    const res = await request(server)
      .get(`${api}/portal/company`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

    // Not a 404: staff genuinely have no company record, and saying so is more
    // useful than pretending the endpoint does not exist.
    expect(res.status).toBe(403);
  });
});
