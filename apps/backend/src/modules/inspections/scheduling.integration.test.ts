/**
 * Scheduling work from the console, rather than from a phone.
 *
 * Orbit Field was built offline-first: an inspection originates on a device,
 * through `POST /sync/push`, made by the person standing in front of the asset.
 * That path has always worked. What did not exist was the other direction — an
 * administrator planning next week's work and handing it to somebody — which is
 * why the console had no "Create inspection" button. There was no endpoint for
 * it to call.
 *
 * The property that decides whether this feature works is not the 201. It is
 * whether the assignee's phone receives the job. A device replays the change
 * log and nothing else, so an inspection written straight to the table exists
 * in the console and on no phone, and the inspector is never told. Every test
 * here that creates or changes work therefore checks the delta, not the row.
 *
 * The second property is scoping: an inspector must receive their own work and
 * nobody else's. An over-broad delta is not a crash, it is one contractor
 * reading another's compliance record.
 */

import { ulid } from '@orbit/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = () => ({
  installationId: unique('sched'),
  name: 'Scheduling Device',
  platform: 'android' as const,
  osVersion: '14',
  appVersion: '1.0.0',
});

let org: TestOrg;
const tokens: Record<string, string> = {};
let inspectorToken = '';

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    tokens[role] = res.body.data.tokens.accessToken;
    if (role === 'INSPECTOR') inspectorToken = res.body.data.tokens.accessToken;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const get = (path: string, role = 'ADMIN') =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const post = (path: string, role = 'ADMIN') =>
  request(server).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const patch = (path: string, role = 'ADMIN') =>
  request(server).patch(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const del = (path: string, role = 'ADMIN') =>
  request(server).delete(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

const body = (over: Record<string, unknown> = {}) => ({
  title: 'Quarterly roof inspection',
  description: 'Check flashing, drainage and guard rails.',
  templateId: org.templateId,
  projectId: org.projectId,
  siteId: org.siteId,
  assignedToId: org.users.INSPECTOR!.id,
  priority: 'HIGH',
  dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  notes: 'Access via the north stair.',
  ...over,
});

/** Everything the assignee's device would pull from a given cursor. */
async function deltaFor(token: string, since = 0) {
  const res = await request(server)
    .get(`${api}/sync/pull?protocolVersion=1&since=${since}&limit=500`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.changes as Array<{
    entity: string;
    operation: string;
    entityId: string;
    data: Record<string, unknown> | null;
    syncCursor: number;
  }>;
}

describe('creating an inspection', () => {
  it('allocates a number, stores every field, and returns the record', async () => {
    const res = await post('/inspections').send(body());

    expect(res.status).toBe(201);
    expect(res.body.data.number).toMatch(/^[A-Z0-9-]+-\d{4}-\d{6}$/);
    expect(res.body.data.title).toBe('Quarterly roof inspection');
    expect(res.body.data.description).toMatch(/flashing/);
    expect(res.body.data.notes).toMatch(/north stair/);
    expect(res.body.data.priority).toBe('HIGH');
    expect(res.body.data.status).toBe('SCHEDULED');
    expect(res.body.data.assignedToId).toBe(org.users.INSPECTOR!.id);
    expect(res.body.data.dueAt).not.toBeNull();
  });

  it('reaches the assigned inspector’s device', async () => {
    const before = (await deltaFor(inspectorToken)).at(-1)?.syncCursor ?? 0;
    const created = await post('/inspections').send(body());
    expect(created.status).toBe(201);

    const delta = await deltaFor(inspectorToken, before);
    const entry = delta.find(
      (c) => c.entity === 'INSPECTION' && c.entityId === created.body.data.id,
    );

    // The whole point. Without this the job exists in the console and on no
    // phone, and the inspector is never told there is work.
    expect(entry).toBeTruthy();
    expect(entry!.operation).toBe('CREATE');
    expect(entry!.data?.title).toBe('Quarterly roof inspection');
  });

  it('pins the template’s published version, not the template', async () => {
    const res = await post('/inspections').send(body());

    // An inspection renders the questions it was started with, years later.
    expect(res.body.data.templateVersionId).toBe(org.templateVersionId);
  });

  it('derives the client from the project rather than trusting the caller', async () => {
    const res = await post('/inspections').send(body());
    expect(res.body.data.clientId).toBe(org.clientId);
  });

  it('gives consecutive inspections distinct numbers', async () => {
    const a = await post('/inspections').send(body());
    const b = await post('/inspections').send(body());
    expect(a.body.data.number).not.toBe(b.body.data.number);
  });

  it('can be scheduled without an assignee, for triage later', async () => {
    const res = await post('/inspections').send(body({ assignedToId: null }));
    expect(res.status).toBe(201);
    expect(res.body.data.assignedToId).toBeNull();
  });

  it('refuses a checklist that has never been published', async () => {
    const draft = await post('/templates').send({
      name: unique('Unpublished'),
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
                  { value: 'pass', label: 'Yes' },
                  { value: 'fail', label: 'No' },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(draft.status).toBe(201);

    const res = await post('/inspections').send(body({ templateId: draft.body.data.id }));
    // A draft has no questions an inspector could answer — it would render as
    // a blank form on site.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.templateId).toBeTruthy();
  });

  it('refuses reference data belonging to another organisation', async () => {
    const other = await createTestOrg();
    try {
      for (const [field, value] of [
        ['templateId', other.templateId],
        ['projectId', other.projectId],
        ['siteId', other.siteId],
        ['assignedToId', other.users.INSPECTOR!.id],
      ] as const) {
        const res = await post('/inspections').send(body({ [field]: value }));
        // Every id on the body is attacker-controlled; unchecked, each is a
        // cross-tenant read that would put another company on this report.
        expect(res.status).toBe(422);
        expect(res.body.error.fields?.[field]).toBeTruthy();
      }
    } finally {
      await other.cleanup();
    }
  });

  it('refuses a status that claims work already happened', async () => {
    for (const status of ['SUBMITTED', 'APPROVED', 'IN_PROGRESS']) {
      const res = await post('/inspections').send(body({ status }));
      // Creating an APPROVED inspection would be a signed-off record nobody
      // carried out.
      expect(res.status).toBe(422);
    }
  });

  it('requires a title', async () => {
    expect((await post('/inspections').send(body({ title: '' }))).status).toBe(422);
  });

  it('writes an audit entry naming who scheduled it', async () => {
    const res = await post('/inspections').send(body());
    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: res.body.data.id, action: 'RECORD_CREATED' },
    });
    expect(log?.userId).toBe(org.users.ADMIN!.id);
  });
});

describe('editing an inspection', () => {
  it('changes the details and reaches devices as an update', async () => {
    const created = await post('/inspections').send(body());
    const id = created.body.data.id as string;
    const before = (await deltaFor(inspectorToken)).at(-1)?.syncCursor ?? 0;

    const res = await patch(`/inspections/${id}`).send({
      title: 'Rescheduled roof inspection',
      priority: 'CRITICAL',
      description: 'Now includes the plant room.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Rescheduled roof inspection');
    expect(res.body.data.priority).toBe('CRITICAL');

    const entry = (await deltaFor(inspectorToken, before)).find((c) => c.entityId === id);
    expect(entry?.operation).toBe('UPDATE');
    expect(entry?.data?.title).toBe('Rescheduled roof inspection');
  });

  it('reassigns to a different inspector', async () => {
    const created = await post('/inspections').send(body());
    const res = await patch(`/inspections/${created.body.data.id}`).send({
      assignedToId: org.users.MANAGER!.id,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.assignedToId).toBe(org.users.MANAGER!.id);
  });

  it('bumps the version so a device with a stale copy detects the change', async () => {
    const created = await post('/inspections').send(body());
    const before = created.body.data.version as number;

    const res = await patch(`/inspections/${created.body.data.id}`).send({ title: 'Renamed' });
    expect(res.body.data.version).toBeGreaterThan(before);
  });

  it('refuses to edit work that has been submitted', async () => {
    const created = await post('/inspections').send(body());
    const id = created.body.data.id as string;
    await prisma.inspection.update({ where: { id }, data: { status: 'SUBMITTED' } });

    const res = await patch(`/inspections/${id}`).send({ title: 'Rewritten after the fact' });
    // Changing the site under a completed inspection rewrites what was
    // inspected after somebody signed for it.
    expect(res.status).toBe(409);

    const unchanged = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(unchanged.title).not.toBe('Rewritten after the fact');
  });

  it('404s across the organisation boundary', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id);
      expect((await patch(`/inspections/${theirs}`).send({ title: 'X' })).status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('deleting an inspection', () => {
  it('soft-deletes, removes it from the list, and tombstones it for devices', async () => {
    const created = await post('/inspections').send(body());
    const id = created.body.data.id as string;
    const before = (await deltaFor(inspectorToken)).at(-1)?.syncCursor ?? 0;

    expect((await del(`/inspections/${id}`)).status).toBe(204);

    const row = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    // Soft: the row carries answers and photographs a report may already have
    // been produced from.
    expect(row.deletedAt).not.toBeNull();

    const listed = await get('/inspections?pageSize=200');
    expect(listed.body.data.items.map((i: { id: string }) => i.id)).not.toContain(id);

    const entry = (await deltaFor(inspectorToken, before)).find((c) => c.entityId === id);
    // Without the tombstone the job stays on the phone forever, and the
    // inspector turns up to do work the office cancelled.
    expect(entry?.operation).toBe('DELETE');
    expect(entry?.data).toBeNull();
  });

  it('refuses to delete submitted work', async () => {
    const created = await post('/inspections').send(body());
    const id = created.body.data.id as string;
    await prisma.inspection.update({ where: { id }, data: { status: 'SUBMITTED' } });

    const res = await del(`/inspections/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/archive/i);
  });
});

describe('what an inspector may do', () => {
  it('cannot schedule work for anybody', async () => {
    const res = await post('/inspections', 'INSPECTOR').send(body());
    // Inspectors hold INSPECTION_CREATE — making work they are standing in
    // front of is their job. Handing work to somebody else is not.
    expect(res.status).toBe(403);
  });

  it('cannot edit or delete', async () => {
    const created = await post('/inspections').send(body());
    const id = created.body.data.id as string;

    expect((await patch(`/inspections/${id}`, 'INSPECTOR').send({ title: 'X' })).status).toBe(403);
    expect((await del(`/inspections/${id}`, 'INSPECTOR')).status).toBe(403);
  });

  it('still receives and can read the work assigned to them', async () => {
    const created = await post('/inspections').send(body());

    const list = await get('/inspections?pageSize=200', 'INSPECTOR');
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i: { id: string }) => i.id)).toContain(created.body.data.id);

    expect((await get(`/inspections/${created.body.data.id}`, 'INSPECTOR')).status).toBe(200);
  });

  it('never receives work assigned to somebody else in another organisation', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id);
      const delta = await deltaFor(inspectorToken);
      expect(delta.map((c) => c.entityId)).not.toContain(theirs);
    } finally {
      await other.cleanup();
    }
  });

  it('can still create their own work through sync, which is the offline path', async () => {
    // The REST refusal above must not have closed the door the product is
    // built on: an inspector in a basement creating an inspection on device.
    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: org.users.INSPECTOR!.email,
        password: org.users.INSPECTOR!.password,
        device: device(),
      });
    const deviceId = login.body.data.device.id as string;
    const token = login.body.data.tokens.accessToken as string;
    const id = ulid();

    const push = await request(server)
      .post(`${api}/sync/push`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        protocolVersion: 1,
        deviceId,
        cursor: 0,
        operations: [
          {
            id: ulid(),
            entity: 'INSPECTION',
            operation: 'CREATE',
            entityId: id,
            patch: {
              templateId: org.templateId,
              templateVersionId: org.templateVersionId,
              projectId: org.projectId,
              siteId: org.siteId,
              assignedToId: login.body.data.user.id,
              title: 'Found on site',
              status: 'IN_PROGRESS',
              priority: 'NORMAL',
            },
            baseVersion: null,
            dependsOn: [],
            clientTimestamp: new Date().toISOString(),
            lamport: 1,
            deviceId,
            userId: login.body.data.user.id,
          },
        ],
      });

    expect(push.status).toBe(200);
    expect(push.body.results[0].status).toBe('APPLIED');
  });
});

describe('the admin list, which the console renders', () => {
  it('surfaces every status an administrator tracks', async () => {
    const created = await post('/inspections').send(body());
    const id = created.body.data.id as string;

    for (const status of [
      'SCHEDULED',
      'IN_PROGRESS',
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'REJECTED',
    ]) {
      await prisma.inspection.update({ where: { id }, data: { status: status as never } });
      const res = await get(`/inspections?status=${status}&pageSize=200`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).toContain(id);
    }
  });

  it('filters by assignee, so an administrator can see one person’s workload', async () => {
    const created = await post('/inspections').send(body());
    const res = await get(`/inspections?assignedToId=${org.users.INSPECTOR!.id}&pageSize=200`);
    expect(res.body.data.items.map((i: { id: string }) => i.id)).toContain(created.body.data.id);
  });
});
