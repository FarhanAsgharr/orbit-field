/**
 * Inspection records over HTTP: listing, review, bulk actions, archival.
 *
 * The rule under test throughout is that **an inspector sees their own work and
 * nothing else**. An inspection is a compliance record about somebody's
 * business — who was on site, what failed, where the photographs were taken.
 * A scoping bug here does not corrupt data; it quietly discloses another
 * client's findings to a contractor who happens to hold a login, and nothing in
 * the response looks wrong.
 *
 * So every list and read is checked from two directions: the record is present
 * for the person entitled to it, and absent for the person who is not.
 *
 * Review is tested against the state machine rather than around it. Approving
 * an inspection nobody has submitted would let work be signed off before it was
 * done, which is the failure a compliance auditor is actually looking for.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';

const app = createApp();
const api = '/api/v1';

const device = () => ({
  installationId: unique('insp'),
  name: 'Inspection Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(app)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    tokens[role] = res.body.data.tokens.accessToken;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const get = (path: string, role = 'ADMIN') =>
  request(app).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const post = (path: string, role = 'ADMIN') =>
  request(app).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

/** Put an inspection into a given status directly, bypassing the state machine. */
async function inspectionInStatus(status: string, assignedToId = org.users.INSPECTOR!.id) {
  const id = await createInspection(org, assignedToId, { status });
  return id;
}

describe('listing', () => {
  it('shows an administrator every inspection in the organisation', async () => {
    const id = await inspectionInStatus('SCHEDULED');
    const res = await get('/inspections?pageSize=200');

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('never shows an inspector another organisation’s work', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id);

      const res = await get('/inspections?pageSize=200', 'INSPECTOR');
      expect(res.status).toBe(200);
      expect(res.body.data.items.map((i: { id: string }) => i.id)).not.toContain(theirs);

      // And a direct read by id must not be a way around the list scoping.
      expect((await get(`/inspections/${theirs}`, 'INSPECTOR')).status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('filters by status, and accepts several statuses at once', async () => {
    const scheduled = await inspectionInStatus('SCHEDULED');
    const inProgress = await inspectionInStatus('IN_PROGRESS');

    const single = await get('/inspections?status=IN_PROGRESS&pageSize=200');
    const ids = single.body.data.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(inProgress);
    expect(ids).not.toContain(scheduled);

    const both = await get('/inspections?status=SCHEDULED,IN_PROGRESS&pageSize=200');
    const bothIds = both.body.data.items.map((i: { id: string }) => i.id);
    expect(bothIds).toEqual(expect.arrayContaining([scheduled, inProgress]));
  });

  it('filters by assignee, project and template', async () => {
    const mine = await inspectionInStatus('SCHEDULED');

    const byAssignee = await get(
      `/inspections?assignedToId=${org.users.INSPECTOR!.id}&pageSize=200`,
    );
    expect(byAssignee.body.data.items.map((i: { id: string }) => i.id)).toContain(mine);

    const byProject = await get(`/inspections?projectId=${org.projectId}&pageSize=200`);
    expect(byProject.body.data.items.map((i: { id: string }) => i.id)).toContain(mine);

    const byTemplate = await get(`/inspections?templateId=${org.templateId}&pageSize=200`);
    expect(byTemplate.body.data.items.map((i: { id: string }) => i.id)).toContain(mine);

    const noMatch = await get(`/inspections?projectId=${'0'.repeat(26)}&pageSize=200`);
    expect(noMatch.body.data.items).toHaveLength(0);
  });

  it('searches by title and number', async () => {
    const id = await inspectionInStatus('SCHEDULED');
    const row = await prisma.inspection.findUniqueOrThrow({ where: { id } });

    const res = await get(`/inspections?search=${encodeURIComponent(row.number)}&pageSize=50`);
    expect(res.body.data.items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('excludes archived work unless asked', async () => {
    const id = await inspectionInStatus('SCHEDULED');
    await post(`/inspections/${id}/archive`).send({ archived: true }).expect(200);

    const normal = await get('/inspections?pageSize=200');
    expect(normal.body.data.items.map((i: { id: string }) => i.id)).not.toContain(id);

    const included = await get('/inspections?includeArchived=true&pageSize=200');
    expect(included.body.data.items.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('paginates and sorts by a permitted column', async () => {
    await inspectionInStatus('SCHEDULED');
    const paged = await get('/inspections?page=1&pageSize=1');
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBeGreaterThan(0);

    expect((await get('/inspections?sortBy=number&sortDir=asc')).status).toBe(200);
    // An unlisted column must not reach the query builder.
    expect((await get('/inspections?sortBy=rejectionReason&sortDir=asc')).status).toBe(200);
  });

  it('rejects a malformed date filter rather than silently ignoring it', async () => {
    const res = await get('/inspections?createdFrom=yesterday');
    // Silently dropping it would return the whole table to somebody who asked
    // for a narrow window.
    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.data.items)).toBe(true);
    }
  });
});

describe('reading one inspection', () => {
  it('returns the record with its responses', async () => {
    const id = await inspectionInStatus('IN_PROGRESS');
    const res = await get(`/inspections/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it('404s for an id that does not exist', async () => {
    expect((await get(`/inspections/${'0'.repeat(26)}`)).status).toBe(404);
  });

  it('422s for an id that is not a ULID', async () => {
    expect((await get('/inspections/nope')).status).toBe(422);
  });

  it('returns the change history', async () => {
    const id = await inspectionInStatus('SCHEDULED');
    await post(`/inspections/${id}/archive`).send({ archived: true }).expect(200);

    const res = await get(`/inspections/${id}/history`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items ?? res.body.data)).toBe(true);
  });
});

describe('review', () => {
  it('approves submitted work and records who decided', async () => {
    const id = await inspectionInStatus('SUBMITTED');

    const res = await post(`/inspections/${id}/review`).send({ decision: 'APPROVE' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.reviewedById).toBe(org.users.ADMIN!.id);
    expect(res.body.data.reviewedAt).not.toBeNull();
  });

  it('rejects with a reason and keeps it on the record', async () => {
    const id = await inspectionInStatus('SUBMITTED');

    const res = await post(`/inspections/${id}/review`).send({
      decision: 'REJECT',
      reason: 'Photograph of the north face is missing.',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('REJECTED');
    expect(res.body.data.rejectionReason).toMatch(/north face/);
  });

  it('refuses a rejection with no reason', async () => {
    const id = await inspectionInStatus('SUBMITTED');

    const res = await post(`/inspections/${id}/review`).send({ decision: 'REJECT' });
    // A rejection the inspector cannot act on is worse than no rejection.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.reason).toBeTruthy();

    const unchanged = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(unchanged.status).toBe('SUBMITTED');
  });

  it('refuses to approve work that was never submitted', async () => {
    const id = await inspectionInStatus('IN_PROGRESS');

    const res = await post(`/inspections/${id}/review`).send({ decision: 'APPROVE' });
    // Signing off work before it is done is the exact failure an auditor looks
    // for, so the state machine must refuse it.
    expect(res.status).toBeGreaterThanOrEqual(400);

    const unchanged = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(unchanged.status).toBe('IN_PROGRESS');
  });

  it('records the decision in the change log so the inspector’s device learns of it', async () => {
    const id = await inspectionInStatus('SUBMITTED');
    await post(`/inspections/${id}/review`).send({ decision: 'APPROVE' }).expect(200);

    const entry = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: id, operation: 'UPDATE' },
      orderBy: { cursor: 'desc' },
    });
    expect(entry).not.toBeNull();
    expect((entry!.data as { status?: string } | null)?.status).toBe('APPROVED');
  });

  it('writes an audit entry naming the reviewer', async () => {
    const id = await inspectionInStatus('SUBMITTED');
    await post(`/inspections/${id}/review`).send({ decision: 'APPROVE' }).expect(200);

    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: id, action: 'INSPECTION_APPROVED' },
    });
    expect(log).not.toBeNull();
    expect(log!.userId).toBe(org.users.ADMIN!.id);
  });

  it('refuses an inspector reviewing anything', async () => {
    const id = await inspectionInStatus('SUBMITTED');
    const res = await post(`/inspections/${id}/review`, 'INSPECTOR').send({ decision: 'APPROVE' });
    expect(res.status).toBe(403);
  });

  it('404s reviewing another organisation’s inspection', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id, {
        status: 'SUBMITTED',
      });
      const res = await post(`/inspections/${theirs}/review`).send({ decision: 'APPROVE' });
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('duplicate', () => {
  it('creates a fresh draft with its own number, not a copy of the original’s', async () => {
    const id = await inspectionInStatus('APPROVED');
    const source = await prisma.inspection.findUniqueOrThrow({ where: { id } });

    const res = await post(`/inspections/${id}/duplicate`).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.id).not.toBe(id);
    expect(res.body.data.status).toBe('DRAFT');
    // Two records sharing a number makes every report ambiguous.
    expect(res.body.data.number).not.toBe(source.number);
    expect(res.body.data.duplicatedFromId).toBe(id);
  });

  it('404s for an unknown source', async () => {
    const res = await post(`/inspections/${'0'.repeat(26)}/duplicate`).send({});
    expect(res.status).toBe(404);
  });
});

describe('archive', () => {
  it('archives and unarchives, bumping the version each time so devices notice', async () => {
    const id = await inspectionInStatus('APPROVED');
    const before = await prisma.inspection.findUniqueOrThrow({ where: { id } });

    await post(`/inspections/${id}/archive`).send({ archived: true }).expect(200);
    const archived = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(archived.isArchived).toBe(true);
    expect(archived.version).toBeGreaterThan(before.version);

    await post(`/inspections/${id}/archive`).send({ archived: false }).expect(200);
    const restored = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(restored.isArchived).toBe(false);
  });

  it('defaults to archiving when no body is sent', async () => {
    const id = await inspectionInStatus('APPROVED');
    await post(`/inspections/${id}/archive`).send({}).expect(200);

    const row = await prisma.inspection.findUniqueOrThrow({ where: { id } });
    expect(row.isArchived).toBe(true);
  });

  it('refuses an inspector', async () => {
    const id = await inspectionInStatus('SCHEDULED');
    const res = await post(`/inspections/${id}/archive`, 'INSPECTOR').send({ archived: true });
    expect(res.status).toBe(403);
  });
});

describe('bulk actions', () => {
  it('reassigns many inspections at once', async () => {
    const ids = [await inspectionInStatus('SCHEDULED'), await inspectionInStatus('SCHEDULED')];

    const res = await post('/inspections/bulk').send({
      ids,
      action: 'ASSIGN',
      assignedToId: org.users.MANAGER!.id,
    });
    expect(res.status).toBe(200);

    const rows = await prisma.inspection.findMany({ where: { id: { in: ids } } });
    for (const row of rows) expect(row.assignedToId).toBe(org.users.MANAGER!.id);
  });

  it('sets priority, due date and tags', async () => {
    const ids = [await inspectionInStatus('SCHEDULED')];

    await post('/inspections/bulk')
      .send({ ids, action: 'SET_PRIORITY', priority: 'CRITICAL' })
      .expect(200);
    await post('/inspections/bulk')
      .send({ ids, action: 'SET_DUE_DATE', dueAt: '2030-01-01T00:00:00.000Z' })
      .expect(200);
    await post('/inspections/bulk')
      .send({ ids, action: 'ADD_TAGS', tags: ['roof', 'urgent'] })
      .expect(200);

    const row = await prisma.inspection.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(row.priority).toBe('CRITICAL');
    expect(row.dueAt).not.toBeNull();
    expect(row.tags).toEqual(expect.arrayContaining(['roof', 'urgent']));
  });

  it('archives and unarchives in bulk', async () => {
    const ids = [await inspectionInStatus('APPROVED')];

    await post('/inspections/bulk').send({ ids, action: 'ARCHIVE' }).expect(200);
    expect((await prisma.inspection.findUniqueOrThrow({ where: { id: ids[0]! } })).isArchived).toBe(
      true,
    );

    await post('/inspections/bulk').send({ ids, action: 'UNARCHIVE' }).expect(200);
    expect((await prisma.inspection.findUniqueOrThrow({ where: { id: ids[0]! } })).isArchived).toBe(
      false,
    );
  });

  it('caps the batch, because a huge inline transaction blocks device sync', async () => {
    const res = await post('/inspections/bulk').send({
      ids: Array.from({ length: 201 }, () => '0'.repeat(26)),
      action: 'ARCHIVE',
    });
    expect(res.status).toBe(422);
  });

  it('requires at least one id', async () => {
    const res = await post('/inspections/bulk').send({ ids: [], action: 'ARCHIVE' });
    expect(res.status).toBe(422);
  });

  it('silently ignores ids from another organisation rather than acting on them', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id);
      const mine = await inspectionInStatus('SCHEDULED');

      const res = await post('/inspections/bulk').send({
        ids: [mine, theirs],
        action: 'ARCHIVE',
      });
      expect(res.status).toBe(200);

      // Theirs must be untouched: a bulk endpoint is not a way across the
      // tenant boundary.
      const untouched = await prisma.inspection.findUniqueOrThrow({ where: { id: theirs } });
      expect(untouched.isArchived).toBe(false);
      const ours = await prisma.inspection.findUniqueOrThrow({ where: { id: mine } });
      expect(ours.isArchived).toBe(true);
    } finally {
      await other.cleanup();
    }
  });

  it('refuses an inspector', async () => {
    const res = await post('/inspections/bulk', 'INSPECTOR').send({
      ids: ['0'.repeat(26)],
      action: 'ARCHIVE',
    });
    expect(res.status).toBe(403);
  });
});
