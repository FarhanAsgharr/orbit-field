/**
 * Reference data, seen from a customer's account.
 *
 * The generic resource routers behind `/clients`, `/projects`, `/sites` and
 * `/assets` scoped every query by organisation and nothing else. That is right
 * for staff — inside one company, colleagues seeing each other's work is the
 * point — and wrong for a customer, because two clients of the same firm may
 * be competitors.
 *
 * A production audit found it: a CLIENT account holds `site:read`, so it could
 * list every site in the organisation and fetch any one of them by id. One
 * customer read another's site by name. Nothing in the response looked wrong.
 *
 * These tests are written as pairs — the customer sees their own row, and does
 * not see the other customer's — because a test asserting only the first half
 * passes against a completely unscoped implementation, which is exactly what
 * shipped.
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
  installationId: unique('iso'),
  name: 'Isolation',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;
let clientToken: string;
let adminToken: string;
/** A site and an asset belonging to the *other* customer. */
let foreignSiteId: string;
let foreignAssetId: string;

beforeAll(async () => {
  org = await createTestOrg();

  const signIn = async (key: string): Promise<string> => {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: org.users[key]!.email, password: org.users[key]!.password, device: device() });
    expect(res.status).toBe(200);
    return res.body.data.tokens.accessToken;
  };

  clientToken = await signIn('CLIENT');
  adminToken = await signIn('ADMIN');

  // The second customer's site and asset. `org.siteId` already belongs to the
  // first customer, so this gives the pair the tests need.
  foreignSiteId = unique('S').padEnd(26, '0').slice(0, 26).toUpperCase();
  await prisma.site.create({
    data: {
      id: foreignSiteId,
      orgId: org.orgId,
      clientId: org.secondClientId,
      name: 'Competitor Refinery',
      code: unique('CR').slice(0, 20),
    },
  });

  foreignAssetId = unique('A').padEnd(26, '0').slice(0, 26).toUpperCase();
  await prisma.asset.create({
    data: {
      id: foreignAssetId,
      orgId: org.orgId,
      siteId: foreignSiteId,
      name: 'Competitor Pump 1',
      tag: unique('CP').slice(0, 20),
    },
  });
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

describe('sites, as a customer', () => {
  it('lists only the customer’s own sites', async () => {
    const res = await request(server)
      .get(`${api}/sites?pageSize=200`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((s: { id: string }) => s.id);
    expect(ids).toContain(org.siteId);
    expect(ids).not.toContain(foreignSiteId);

    // Belt and braces: every row carries the caller's own client id, so a new
    // site added to another customer cannot slip in through a missed filter.
    for (const site of res.body.data.items) {
      expect(site.clientId).toBe(org.clientId);
    }
  });

  it('cannot fetch another customer’s site by id', async () => {
    const res = await request(server)
      .get(`${api}/sites/${foreignSiteId}`)
      .set('Authorization', `Bearer ${clientToken}`);

    // 404 rather than 403: confirming the record exists is itself a
    // disclosure when the caller has no right to know.
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Competitor Refinery');
  });

  it('still shows staff every site in the organisation', async () => {
    const res = await request(server)
      .get(`${api}/sites?pageSize=200`)
      .set('Authorization', `Bearer ${adminToken}`);

    const ids = res.body.data.items.map((s: { id: string }) => s.id);
    // The fix must not narrow staff — an admin who cannot see a customer's
    // site cannot run the business.
    expect(ids).toContain(org.siteId);
    expect(ids).toContain(foreignSiteId);
  });
});

describe('assets, as a customer', () => {
  it('lists only assets standing on the customer’s own sites', async () => {
    const res = await request(server)
      .get(`${api}/assets?pageSize=200`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(org.assetId);
    expect(ids).not.toContain(foreignAssetId);
  });

  it('cannot fetch another customer’s asset by id', async () => {
    const res = await request(server)
      .get(`${api}/assets/${foreignAssetId}`)
      .set('Authorization', `Bearer ${clientToken}`);

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Competitor Pump');
  });
});

describe('everything else a customer must not reach', () => {
  it('refuses the client list outright', async () => {
    const res = await request(server)
      .get(`${api}/clients`)
      .set('Authorization', `Bearer ${clientToken}`);

    // `client:read` is not in the CLIENT permission set, so this is refused
    // before scoping is even consulted.
    expect(res.status).toBe(403);
  });

  it('refuses projects outright rather than narrowing them', async () => {
    const res = await request(server)
      .get(`${api}/projects`)
      .set('Authorization', `Bearer ${clientToken}`);

    /*
     * A project is how the company organises its own work — margins,
     * managers, internal codes — and a customer never sees one. The router
     * has no client scope for projects on purpose, and absence must mean
     * "refused" rather than "fall back to the whole organisation".
     */
    expect(res.status).toBe(403);
  });

  it('cannot create, edit or delete reference data', async () => {
    const create = await request(server)
      .post(`${api}/sites`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'Client-made site', code: unique('X').slice(0, 20) });
    expect(create.status).toBe(403);

    const update = await request(server)
      .patch(`${api}/sites/${org.siteId}`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ name: 'Renamed by a customer' });
    expect(update.status).toBe(403);

    const remove = await request(server)
      .delete(`${api}/sites/${org.siteId}`)
      .set('Authorization', `Bearer ${clientToken}`);
    expect(remove.status).toBe(403);
  });
});
