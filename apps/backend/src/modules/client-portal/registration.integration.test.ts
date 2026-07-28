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

describe('which company a customer registers with', () => {
  /*
   * The bug this covers, in full.
   *
   * Registration used to file every customer under the earliest-created
   * organisation. On an installation with more than one company that is a
   * silent misfiling: the customer registers, raises a request, gets a
   * reference number, and the request lands in a console belonging to a
   * company they have never dealt with. Nothing errors. The staff they *are*
   * dealing with simply never see it, and tenant isolation — working exactly
   * as designed — makes it invisible rather than wrong.
   *
   * So these cases are about where the row lands, not whether the call
   * succeeds. A test asserting only a 201 passed throughout the entire life of
   * the bug.
   */
  it('files the customer under the company they chose', async () => {
    const others = await prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, slug: true },
    });
    const oldest = others[0]!;
    // The fixture organisation is not the oldest, which is the whole point:
    // choosing it must beat the old "first one wins" behaviour.
    const target = await prisma.organization.findUniqueOrThrow({
      where: { id: org.orgId },
      select: { id: true, slug: true },
    });

    const res = await request(server)
      .post(`${api}/portal/register`)
      .send(submission({ organizationSlug: target.slug }));

    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    const client = await prisma.client.findUniqueOrThrow({
      where: { id: res.body.data.clientId },
      select: { orgId: true },
    });
    const user = await prisma.user.findFirstOrThrow({
      where: { clientId: res.body.data.clientId },
      select: { orgId: true },
    });

    expect(client.orgId).toBe(target.id);
    expect(user.orgId).toBe(target.id);
    if (oldest.id !== target.id) expect(client.orgId).not.toBe(oldest.id);
  });

  it('puts the customer’s requests where that company’s staff will see them', async () => {
    const target = await prisma.organization.findUniqueOrThrow({
      where: { id: org.orgId },
      select: { slug: true },
    });
    const body = submission({ organizationSlug: target.slug });
    const reg = await request(server).post(`${api}/portal/register`).send(body);
    created.push(reg.body.data.clientId);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: body.email, password: body.password, device: device() });

    const raised = await request(server)
      .post(`${api}/inspection-requests`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .send({ title: 'Does this reach the right console?', priority: 'NORMAL' });
    expect(raised.status).toBe(201);

    // The end of the chain, and the thing that was actually broken: an
    // administrator of the chosen company opens their queue and sees it.
    const adminLogin = await request(server).post(`${api}/auth/login`).send({
      email: org.users.ADMIN!.email,
      password: org.users.ADMIN!.password,
      device: device(),
    });
    const queue = await request(server)
      .get(`${api}/inspection-requests?pageSize=100`)
      .set('Authorization', `Bearer ${adminLogin.body.data.tokens.accessToken}`);

    expect(queue.status).toBe(200);
    expect(queue.body.data.items.map((r: { id: string }) => r.id)).toContain(raised.body.data.id);
  });

  it('refuses to guess when several companies are on offer', async () => {
    const count = await prisma.organization.count({ where: { isActive: true } });
    if (count < 2) return;

    const { organizationSlug: _omitted, ...withoutCompany } = submission();
    const res = await request(server).post(`${api}/portal/register`).send(withoutCompany);

    // Silently picking one is what caused the misfiling.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.organizationSlug).toBeTruthy();
  });

  it('refuses a company that is not on the portal', async () => {
    const res = await request(server)
      .post(`${api}/portal/register`)
      .send(submission({ organizationSlug: 'no-such-company-anywhere' }));

    expect(res.status).toBe(422);
  });

  it('offers the companies a visitor may choose from', async () => {
    const res = await request(server).get(`${api}/portal/registration`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.companies)).toBe(true);
    // The portal draws its picker from this; a slug missing here is a company
    // nobody can register with.
    const slugs = res.body.data.companies.map((c: { slug: string }) => c.slug);
    const mine = await prisma.organization.findUniqueOrThrow({
      where: { id: org.orgId },
      select: { slug: true },
    });
    expect(slugs).toContain(mine.slug);
  });
});

describe('registration availability', () => {
  it('reports that the portal is open and names the company behind it', async () => {
    const res = await request(server).get(`${api}/portal/registration`);
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);

    /*
     * The portal draws its company picker from this. `organizationName` is
     * filled in only when there is exactly one company — with several, naming
     * one of them on the sign-in screen would be picking for the visitor,
     * which is the habit that misfiled customers in the first place.
     */
    expect(Array.isArray(res.body.data.companies)).toBe(true);
    expect(res.body.data.companies.length).toBeGreaterThan(0);
    for (const company of res.body.data.companies) {
      expect(typeof company.slug).toBe('string');
      expect(typeof company.name).toBe('string');
    }
  });
});

describe('creating a client account', () => {
  it('persists every field the form collected', async () => {
    const body = submission();
    const res = await request(server).post(`${api}/portal/register`).send(body);

    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    const client = await prisma.client.findUniqueOrThrow({
      where: { id: res.body.data.clientId },
    });

    // Every field, not a sample. A form that collects eighteen values and
    // stores twelve is the failure this case exists to catch.
    expect(client.name).toBe(body.companyName);
    expect(client.industry).toBe('Construction');
    expect(client.registrationNumber).toBe('CRN-99182');
    expect(client.taxNumber).toBe('TAX-55010');
    expect(client.contactName).toBe('Dana Whitfield');
    expect(client.contactDesignation).toBe('Facilities Manager');
    expect(client.contactEmail).toBe(body.email.toLowerCase());
    expect(client.contactPhone).toBe('+44 20 7946 0102');
    expect(client.whatsapp).toBe('+44 7700 900333');
    expect(client.country).toBe('United Kingdom');
    expect(client.state).toBe('Greater London');
    expect(client.city).toBe('London');
    expect(client.address).toBe('18 Cheapside, Floor 4');
    expect(client.postalCode).toBe('EC2V 6AA');
    expect(client.notes).toBe('Two towers, quarterly inspections.');
    expect(client.isActive).toBe(true);
    // A scheme is added rather than the value being refused: people type
    // "acme.com".
    expect(client.website).toBe('https://northwind.example');
    expect(client.code).toBeTruthy();
  });

  it('creates exactly one CLIENT user, bound to that company', async () => {
    const body = submission();
    const res = await request(server).post(`${api}/portal/register`).send(body);
    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    const users = await prisma.user.findMany({ where: { clientId: res.body.data.clientId } });
    expect(users).toHaveLength(1);

    const user = users[0]!;
    // The role is the whole security story: CLIENT carries five read
    // permissions and reaches no admin surface.
    expect(user.role).toBe('CLIENT');
    expect(user.status).toBe('ACTIVE');
    expect(user.email).toBe(body.email.toLowerCase());
    expect(user.clientId).toBe(res.body.data.clientId);
    expect(user.orgId).toBe(await hostOrgId());
    // Split on whitespace, so "Dana Whitfield" is a first and a last name.
    expect(user.firstName).toBe('Dana');
    expect(user.lastName).toBe('Whitfield');
  });

  it('signs in with the password that was chosen', async () => {
    const body = submission();
    const created_ = await request(server).post(`${api}/portal/register`).send(body);
    expect(created_.status).toBe(201);
    created.push(created_.body.data.clientId);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: body.email, password: body.password, device: device() });

    expect(login.status).toBe(200);
    expect(String(login.body.data.user.role)).toBe('CLIENT');
  });

  it('publishes the client to the change log so devices see it', async () => {
    const res = await request(server).post(`${api}/portal/register`).send(submission());
    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    /*
     * A device replays the change log and nothing else. A client created only
     * in the database is invisible to every phone in the organisation, so the
     * inspector sent to their site sees a job for nobody.
     */
    const entry = await prisma.changeLogEntry.findFirst({
      where: { entity: 'CLIENT', entityId: res.body.data.clientId },
    });
    expect(entry).not.toBeNull();
    expect(entry!.operation).toBe('CREATE');
  });

  it('appears in the console with its full record and its portal login', async () => {
    const body = submission();
    const res = await request(server).post(`${api}/portal/register`).send(body);
    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    // Staff of the host organisation, since that is where the client landed.
    const hostAdmin = await prisma.user.findFirstOrThrow({
      where: { orgId: await hostOrgId(), role: { in: ['SUPER_ADMIN', 'ADMIN'] }, deletedAt: null },
      select: { id: true, orgId: true },
    });

    const client = await prisma.client.findUniqueOrThrow({
      where: { id: res.body.data.clientId },
      include: {
        _count: { select: { projects: true, sites: true, inspections: true, requests: true } },
        portalUsers: { where: { role: 'CLIENT', deletedAt: null }, select: { email: true } },
      },
    });

    expect(client.orgId).toBe(hostAdmin.orgId);
    expect(client.portalUsers.map((u) => u.email)).toContain(body.email.toLowerCase());
    expect(client._count.requests).toBe(0);
  });
});

describe('what a stranger cannot do with it', () => {
  it('refuses an email that already has an account', async () => {
    const body = submission();
    const first = await request(server).post(`${api}/portal/register`).send(body);
    expect(first.status).toBe(201);
    created.push(first.body.data.clientId);

    const second = await request(server)
      .post(`${api}/portal/register`)
      .send(submission({ email: body.email }));

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('DUPLICATE_RESOURCE');
  });

  it('gives a fresh code when a deleted client already holds the obvious one', async () => {
    /*
     * Found on production, not here.
     *
     * `@@unique([orgId, code])` is a database constraint that knows nothing
     * about `deletedAt`, so a deleted client keeps its derived code reserved.
     * The uniqueness probe used to skip deleted rows, hand back a code that was
     * already taken, and fail the insert — surfacing to the customer as a
     * duplicate-key error about a column they never saw.
     */
    const name = `Collision Test ${unique('x')}`;

    const first = await request(server)
      .post(`${api}/portal/register`)
      .send(submission({ companyName: name }));
    expect(first.status).toBe(201);
    created.push(first.body.data.clientId);

    const code = (
      await prisma.client.findUniqueOrThrow({ where: { id: first.body.data.clientId } })
    ).code;

    // Soft delete, exactly as `DELETE /clients/:id` does.
    await prisma.client.update({
      where: { id: first.body.data.clientId },
      data: { deletedAt: new Date() },
    });

    const second = await request(server)
      .post(`${api}/portal/register`)
      .send(submission({ companyName: name }));

    expect(second.status).toBe(201);
    created.push(second.body.data.clientId);

    const secondCode = (
      await prisma.client.findUniqueOrThrow({ where: { id: second.body.data.clientId } })
    ).code;
    expect(secondCode).not.toBe(code);
  });

  it('refuses a weak password', async () => {
    const res = await request(server)
      .post(`${api}/portal/register`)
      .send(submission({ password: 'password' }));

    expect(res.status).toBe(422);
    expect(res.body.error.fields?.password).toBeTruthy();
  });

  it('refuses a submission missing a field the company needs', async () => {
    for (const field of [
      'companyName',
      'contactName',
      'email',
      'contactPhone',
      'country',
      'city',
      'address',
    ]) {
      const body = submission();
      delete (body as Record<string, unknown>)[field];
      const res = await request(server).post(`${api}/portal/register`).send(body);
      expect(res.status, `${field} should be required`).toBe(422);
    }
  });

  it('cannot be used to choose a role or an organisation', async () => {
    const res = await request(server)
      .post(`${api}/portal/register`)
      .send({
        ...submission(),
        // Both ignored by the schema — asserted rather than assumed, because
        // "zod strips unknown keys" is a property of the code, not a law.
        role: 'SUPER_ADMIN',
        orgId: org.orgId,
        clientId: 'someone-elses-client',
      });

    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    const user = await prisma.user.findFirstOrThrow({
      where: { clientId: res.body.data.clientId },
    });
    expect(user.role).toBe('CLIENT');
    expect(user.orgId).toBe(await hostOrgId());
  });

  it('never returns a session or a token', async () => {
    const res = await request(server).post(`${api}/portal/register`).send(submission());
    expect(res.status).toBe(201);
    created.push(res.body.data.clientId);

    // Sessions are minted in exactly one place. A registration that also
    // returned tokens would be a second one, with its own device binding and
    // lockout behaviour to keep in step.
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toMatch(/accessToken|refreshToken/i);
  });
});

describe('the account it creates is a client account', () => {
  let token: string;
  let clientId: string;

  beforeAll(async () => {
    const body = submission();
    const res = await request(server).post(`${api}/portal/register`).send(body);
    clientId = res.body.data.clientId;
    created.push(clientId);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: body.email, password: body.password, device: device() });
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
    const other = await request(server).post(`${api}/portal/register`).send(submission());
    created.push(other.body.data.clientId);

    // There is no path that takes a client id — the scope comes from the
    // token — so the check is that the record returned is always the caller's.
    const res = await request(server)
      .get(`${api}/portal/company`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data.id).toBe(clientId);
    expect(res.body.data.id).not.toBe(other.body.data.clientId);
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
