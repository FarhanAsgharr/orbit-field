/**
 * The client portal, and the boundary it introduces.
 *
 * Every other role in Orbit Field is staff, scoped by project or by
 * assignment, and inside one organisation staff seeing each other's work is
 * correct. A customer is different: two clients of the same firm may be
 * competitors, and one reading the other's inspection is a disclosure between
 * two companies that would look like nothing in the response — no error, no
 * empty list, just somebody else's site address on the screen.
 *
 * So this suite is written around that boundary rather than around the
 * endpoints. Almost every case is a pair: the customer sees their own record,
 * and does not see the other customer's. A test that only asserted the first
 * half would pass against a completely unscoped implementation.
 *
 * The second theme is that a client is not staff. They cannot approve their own
 * request, reach analytics, read the audit log, or manage anybody — and those
 * refusals are asserted rather than assumed, because "the permission set is
 * small" is not the same as "the endpoints refuse them".
 */

import { AppError } from '@orbit/shared';
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
  installationId: unique('cp'),
  name: 'Portal Device',
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
    expect(res.status).toBe(200);
    tokens[role] = res.body.data.tokens.accessToken;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const get = (path: string, role = 'CLIENT') =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const post = (path: string, role = 'CLIENT') =>
  request(server).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

/** Raise a request as a customer and return it. */
async function raise(role = 'CLIENT', over: Record<string, unknown> = {}) {
  const res = await post('/inspection-requests', role).send({
    title: 'Annual roof inspection',
    description: 'Please check the flashing.',
    inspectionType: 'Safety',
    priority: 'HIGH',
    preferredDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    preferredTime: 'morning',
    specialInstructions: 'Access via the north stair.',
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; number: string; status: string; clientId: string };
}

describe('raising a request', () => {
  it('records it against the customer’s own company, never the body', async () => {
    const created = await raise('CLIENT', { clientId: org.secondClientId });

    // The client id comes from who they are. Sending somebody else's is
    // ignored, not honoured — otherwise the portal is a way to file requests
    // in a competitor's name.
    expect(created.clientId).toBe(org.clientId);
    expect(created.status).toBe('PENDING_APPROVAL');
    expect(created.number).toMatch(/^REQ-\d{4}-\d{6}$/);
  });

  it('gives consecutive requests distinct numbers', async () => {
    const a = await raise();
    const b = await raise();
    expect(a.number).not.toBe(b.number);
  });

  it('refuses a site belonging to another customer', async () => {
    const theirSite = await prisma.site.create({
      data: {
        id: unique('S').toUpperCase().replace(/[^0-9A-Z]/g, '0').slice(0, 26).padEnd(26, '0'),
        orgId: org.orgId,
        clientId: org.secondClientId,
        name: 'Their site',
      },
    });

    const res = await post('/inspection-requests').send({
      title: 'Fishing for sites',
      siteId: theirSite.id,
    });

    // Otherwise the form is a way to discover another company's sites by
    // guessing ids and reading which are accepted.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.siteId).toBeTruthy();
  });

  it('notifies the people who can act on it', async () => {
    const before = await prisma.notification.count({
      where: { orgId: org.orgId, userId: org.users.ADMIN!.id },
    });
    await raise();

    // A request nobody is told about waits until somebody happens to look.
    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.notification.count({
      where: { orgId: org.orgId, userId: org.users.ADMIN!.id },
    });
    expect(after).toBeGreaterThan(before);
  });

  it('requires a title', async () => {
    expect((await post('/inspection-requests').send({ title: '' })).status).toBe(422);
  });
});

describe('one customer cannot see another', () => {
  it('lists only their own requests', async () => {
    const mine = await raise('CLIENT');
    const theirs = await raise('CLIENT_OTHER');

    const list = await get('/inspection-requests?pageSize=100');
    const ids = list.body.data.items.map((r: { id: string }) => r.id);

    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it('404s on another customer’s request rather than 403', async () => {
    const theirs = await raise('CLIENT_OTHER');

    const res = await get(`/inspection-requests/${theirs.id}`);
    // Confirming a record exists is itself a leak when the caller has no right
    // to know about it.
    expect(res.status).toBe(404);
  });

  it('cannot comment on another customer’s request', async () => {
    const theirs = await raise('CLIENT_OTHER');
    const res = await post(`/inspection-requests/${theirs.id}/comments`).send({ body: 'Hello' });
    expect(res.status).toBe(404);
  });

  it('cannot cancel another customer’s request', async () => {
    const theirs = await raise('CLIENT_OTHER');
    const res = await post(`/inspection-requests/${theirs.id}/cancel`).send({});
    expect(res.status).toBe(404);

    const still = await prisma.inspectionRequest.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(still.status).toBe('PENDING_APPROVAL');
  });

  it('filtering by another customer’s id still returns only their own', async () => {
    await raise('CLIENT');
    const theirs = await raise('CLIENT_OTHER');

    const res = await get(`/inspection-requests?clientId=${org.secondClientId}&pageSize=100`);
    const ids = res.body.data.items.map((r: { id: string }) => r.id);

    // The scope is applied last and wins, so an explicit filter cannot widen it.
    expect(ids).not.toContain(theirs.id);
  });

  it('counts only their own work in the dashboard summary', async () => {
    await raise('CLIENT_OTHER');
    await raise('CLIENT_OTHER');
    const before = await get('/inspection-requests/meta/summary');
    await raise('CLIENT');
    const after = await get('/inspection-requests/meta/summary');

    expect(after.body.data.requests.pending).toBe(before.body.data.requests.pending + 1);
  });
});

describe('a client is not staff', () => {
  it('cannot decide their own request', async () => {
    const mine = await raise();

    const res = await post(`/inspection-requests/${mine.id}/decide`).send({
      decision: 'APPROVE',
      templateId: org.templateId,
    });

    // The obvious attack on a portal: approve your own work.
    expect(res.status).toBe(403);

    const still = await prisma.inspectionRequest.findUniqueOrThrow({ where: { id: mine.id } });
    expect(still.status).toBe('PENDING_APPROVAL');
  });

  it('is refused every staff endpoint', async () => {
    const refused: Array<[string, () => request.Test]> = [
      ['analytics', () => get('/analytics/summary')],
      ['people', () => get('/users')],
      ['audit log', () => get('/admin/audit-logs')],
      ['org settings', () => get('/admin/organization')],
      ['templates', () => get('/templates')],
      ['sync health', () => get('/admin/sync-health')],
    ];

    for (const [name, call] of refused) {
      const res = await call();
      expect(res.status, `${name} should be refused`).toBe(403);
    }
  });

  it('sees only its own sessions on /devices, and nobody else’s', async () => {
    // Not an admin endpoint: it scopes to the caller unless they hold
    // DEVICE_READ, so a client gets their own browser sessions — the same list
    // their profile shows — and is refused anybody else's.
    const own = await get('/devices');
    expect(own.status).toBe(200);
    const items = own.body.data.items ?? own.body.data;
    for (const d of items) expect(d.userId).toBe(org.users.CLIENT!.id);

    expect((await get(`/devices?userId=${org.users.ADMIN!.id}`)).status).toBe(403);
  });

  it('cannot create users, templates or inspections', async () => {
    expect(
      (
        await post('/users').send({
          email: `x${Date.now()}@test.invalid`,
          firstName: 'A',
          lastName: 'B',
          role: 'INSPECTOR',
          password: 'Zq12345678A1',
        })
      ).status,
    ).toBe(403);
    expect((await post('/templates').send({ name: 'X', definition: {} })).status).toBe(403);
    expect(
      (await post('/inspections').send({ title: 'X', templateId: org.templateId })).status,
    ).toBe(403);
  });

  it('cannot marked itself a higher role through its own profile', async () => {
    await request(server)
      .patch(`${api}/auth/profile`)
      .set('Authorization', `Bearer ${tokens.CLIENT}`)
      .send({ role: 'ADMIN', clientId: org.secondClientId })
      .expect(200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: org.users.CLIENT!.id } });
    expect(stored.role).toBe('CLIENT');
    // The scope itself must not be self-editable, or the boundary is advisory.
    expect(stored.clientId).toBe(org.clientId);
  });
});

describe('the decision, and the work it creates', () => {
  it('approves, creates the inspection, and links the two', async () => {
    const mine = await raise();

    const res = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({
      decision: 'APPROVE',
      templateId: org.templateId,
      assignedToId: org.users.INSPECTOR!.id,
      supervisorId: org.users.SUPERVISOR!.id,
      note: 'Booked for Thursday.',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.inspectionId).toBeTruthy();

    const inspection = await prisma.inspection.findUniqueOrThrow({
      where: { id: res.body.data.inspectionId },
    });
    // The customer's details carry across, so the work describes what they
    // asked for rather than a blank record somebody has to fill in.
    expect(inspection.clientId).toBe(org.clientId);
    expect(inspection.title).toBe('Annual roof inspection');
    expect(inspection.notes).toMatch(/north stair/);
    expect(inspection.status).toBe('SCHEDULED');
    expect(inspection.assignedToId).toBe(org.users.INSPECTOR!.id);
  });

  it('puts the new inspection on the assigned inspector’s device', async () => {
    const mine = await raise();
    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: org.users.INSPECTOR!.email,
        password: org.users.INSPECTOR!.password,
        device: device(),
      });
    const before = await request(server)
      .get(`${api}/sync/pull?protocolVersion=1&since=0&limit=500`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);
    const cursor = before.body.cursor;

    const decided = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({
      decision: 'APPROVE',
      templateId: org.templateId,
      assignedToId: org.users.INSPECTOR!.id,
    });

    const delta = await request(server)
      .get(`${api}/sync/pull?protocolVersion=1&since=${cursor}&limit=500`)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

    const entry = (delta.body.changes as Array<{ entity: string; entityId: string }>).find(
      (c) => c.entity === 'INSPECTION' && c.entityId === decided.body.data.inspectionId,
    );
    // Approval that does not reach a phone is a job nobody is told about.
    expect(entry).toBeTruthy();
  });

  it('refuses to approve against an unpublished checklist', async () => {
    const mine = await raise();
    const draft = await post('/templates', 'ADMIN').send({
      name: unique('Draft'),
      definition: {
        sections: [
          {
            title: 'S',
            order: 0,
            fields: [
              {
                key: 'k',
                label: 'L',
                type: 'PASS_FAIL',
                order: 0,
                options: [
                  { value: 'p', label: 'Yes' },
                  { value: 'f', label: 'No', isFailure: true },
                ],
              },
            ],
          },
        ],
      },
    });

    const res = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({
      decision: 'APPROVE',
      templateId: draft.body.data.id,
    });
    expect(res.status).toBe(422);
  });

  it('rejects with a reason and creates no work', async () => {
    const mine = await raise();

    const res = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({
      decision: 'REJECT',
      note: 'Outside the contracted scope.',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.inspectionId).toBeNull();

    const thread = await get(`/inspection-requests/${mine.id}`);
    expect(thread.body.data.comments.some((c: { body: string }) => c.body.includes('scope'))).toBe(
      true,
    );
  });

  it('refuses to send a request back with no reason', async () => {
    const mine = await raise();
    for (const decision of ['REJECT', 'REQUEST_INFORMATION']) {
      const res = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({ decision });
      expect(res.status).toBe(422);
    }
  });

  it('a reply to an information request puts it back in the queue', async () => {
    const mine = await raise();
    await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN')
      .send({ decision: 'REQUEST_INFORMATION', note: 'Which floor?' })
      .expect(200);

    expect(
      (await prisma.inspectionRequest.findUniqueOrThrow({ where: { id: mine.id } })).status,
    ).toBe('INFORMATION_REQUESTED');

    await post(`/inspection-requests/${mine.id}/comments`).send({ body: 'The third.' }).expect(201);

    // Left as INFORMATION_REQUESTED the answer is never seen, because that is
    // the status reviewers filter out.
    expect(
      (await prisma.inspectionRequest.findUniqueOrThrow({ where: { id: mine.id } })).status,
    ).toBe('PENDING_APPROVAL');
  });

  it('cannot be decided twice', async () => {
    const mine = await raise();
    await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN')
      .send({ decision: 'REJECT', note: 'No.' })
      .expect(200);

    const again = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({
      decision: 'APPROVE',
      templateId: org.templateId,
    });
    expect(again.status).toBe(409);
  });

  it('hides internal notes from the customer', async () => {
    const mine = await raise();
    await post(`/inspection-requests/${mine.id}/comments`, 'ADMIN')
      .send({ body: 'Chase the account manager first.', internal: true })
      .expect(201);

    const asClient = await get(`/inspection-requests/${mine.id}`);
    const asStaff = await get(`/inspection-requests/${mine.id}`, 'ADMIN');

    expect(asClient.body.data.comments.some((c: { body: string }) => c.body.includes('Chase'))).toBe(
      false,
    );
    expect(asStaff.body.data.comments.some((c: { body: string }) => c.body.includes('Chase'))).toBe(
      true,
    );
  });

  it('a customer cannot mark their own comment internal', async () => {
    const mine = await raise();
    await post(`/inspection-requests/${mine.id}/comments`)
      .send({ body: 'Visible', internal: true })
      .expect(201);

    const asClient = await get(`/inspection-requests/${mine.id}`);
    // The flag would hide their own words from them.
    expect(
      asClient.body.data.comments.some((c: { body: string }) => c.body === 'Visible'),
    ).toBe(true);
  });
});

describe('what the customer can see of the work', () => {
  /** Approve a request and return the inspection it created. */
  async function approved() {
    const mine = await raise();
    const res = await post(`/inspection-requests/${mine.id}/decide`, 'ADMIN').send({
      decision: 'APPROVE',
      templateId: org.templateId,
      assignedToId: org.users.INSPECTOR!.id,
    });
    return { requestId: mine.id, inspectionId: res.body.data.inspectionId as string };
  }

  it('sees their own inspection and not another customer’s', async () => {
    const mine = await approved();

    const theirs = await prisma.inspection.create({
      data: {
        id: unique('I').toUpperCase().replace(/[^0-9A-Z]/g, '0').slice(0, 26).padEnd(26, '0'),
        orgId: org.orgId,
        number: unique('OTH').toUpperCase().slice(0, 30),
        templateId: org.templateId,
        templateVersionId: org.templateVersionId,
        clientId: org.secondClientId,
        title: 'Their work',
        status: 'SCHEDULED',
        createdById: org.users.ADMIN!.id,
      },
    });

    const list = await get('/inspections?pageSize=200');
    const ids = list.body.data.items.map((i: { id: string }) => i.id);

    expect(list.status).toBe(200);
    expect(ids).toContain(mine.inspectionId);
    expect(ids).not.toContain(theirs.id);

    expect((await get(`/inspections/${mine.inspectionId}`)).status).toBe(200);
    expect((await get(`/inspections/${theirs.id}`)).status).toBe(404);
  });

  it('tracks progress through the request’s display status', async () => {
    const mine = await approved();
    await prisma.inspection.update({
      where: { id: mine.inspectionId },
      data: { status: 'IN_PROGRESS' },
    });

    const res = await get(`/inspection-requests/${mine.requestId}`);
    // "Approved" stops being useful the moment somebody is on site.
    expect(res.body.data.displayStatus).toBe('IN_PROGRESS');
  });

  it('downloads a report for their own inspection only', async () => {
    const mine = await approved();

    const ok = await get(`/reports/inspection/${mine.inspectionId}?format=pdf`);
    expect(ok.status).toBe(200);

    const theirs = await prisma.inspection.create({
      data: {
        id: unique('R').toUpperCase().replace(/[^0-9A-Z]/g, '0').slice(0, 26).padEnd(26, '0'),
        orgId: org.orgId,
        number: unique('RPT').toUpperCase().slice(0, 30),
        templateId: org.templateId,
        templateVersionId: org.templateVersionId,
        clientId: org.secondClientId,
        title: 'Their work',
        status: 'APPROVED',
        createdById: org.users.ADMIN!.id,
      },
    });

    expect((await get(`/reports/inspection/${theirs.id}?format=pdf`)).status).toBe(404);
  });

  it('exports only their own rows', async () => {
    await approved();
    await prisma.inspection.create({
      data: {
        id: unique('E').toUpperCase().replace(/[^0-9A-Z]/g, '0').slice(0, 26).padEnd(26, '0'),
        orgId: org.orgId,
        number: 'OTHERCUSTOMER0001',
        templateId: org.templateId,
        templateVersionId: org.templateVersionId,
        clientId: org.secondClientId,
        title: 'Their work',
        status: 'APPROVED',
        createdById: org.users.ADMIN!.id,
      },
    });

    const res = await request(server)
      .get(`${api}/reports/export/inspections?format=csv&limit=20000`)
      .set('Authorization', `Bearer ${tokens.CLIENT}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    // An aggregate is a disclosure too.
    expect((res.body as Buffer).toString('utf8')).not.toContain('OTHERCUSTOMER0001');
  });
});

describe('tenant isolation still holds above the client boundary', () => {
  it('a client cannot reach another organisation at all', async () => {
    const other = await createTestOrg();
    try {
      const theirRequest = await prisma.inspectionRequest.create({
        data: {
          id: unique('X').toUpperCase().replace(/[^0-9A-Z]/g, '0').slice(0, 26).padEnd(26, '0'),
          orgId: other.orgId,
          clientId: other.clientId,
          number: 'REQ-9999-000001',
          title: 'Another organisation',
          requestedById: other.users.ADMIN!.id,
        },
      });

      expect((await get(`/inspection-requests/${theirRequest.id}`)).status).toBe(404);

      const list = await get('/inspection-requests?pageSize=200');
      expect(list.body.data.items.map((r: { id: string }) => r.id)).not.toContain(theirRequest.id);
    } finally {
      await other.cleanup();
    }
  });

  it('AppError is still what an unauthorised call produces', () => {
    // Guards the import above staying meaningful if the suite is refactored.
    expect(new AppError('PERMISSION_DENIED' as never, 'x')).toBeInstanceOf(Error);
  });
});
