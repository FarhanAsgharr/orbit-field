/**
 * Clearing sign-in history.
 *
 * Every successful login writes an audit entry, so on an active installation
 * these outnumber everything else several times over and bury the events
 * somebody is actually looking for. Clearing them is housekeeping.
 *
 * What these tests are really protecting is the difference between housekeeping
 * and redaction. An audit log you can quietly edit is not an audit log, so:
 * only authentication actions can go, the cut is always by age rather than by
 * "the last hour", and the clearance writes its own entry. Deleting the
 * evidence leaves evidence.
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
  installationId: unique('ap'),
  name: 'Audit Device',
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
    tokens[role] = res.body.data.tokens.accessToken;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const del = (role = 'SUPER_ADMIN') =>
  request(server).delete(`${api}/admin/audit-logs`).set('Authorization', `Bearer ${tokens[role]}`);

/** Seed one entry of each kind, aged into the past. */
async function seed(daysAgo: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  const rows = [
    'AUTH_LOGIN',
    'AUTH_LOGIN_FAILED',
    'AUTH_LOGOUT',
    'RECORD_UPDATED',
    'INSPECTION_APPROVED',
    'SETTINGS_CHANGED',
  ];
  for (const action of rows) {
    await prisma.auditLog.create({
      data: {
        id: unique('a')
          .toUpperCase()
          .replace(/[^0-9A-Z]/g, '0')
          .slice(0, 26)
          .padEnd(26, '0'),
        orgId: org.orgId,
        userId: org.users.ADMIN!.id,
        action,
        entity: 'Test',
        entityId: org.orgId,
        createdAt: at,
      },
    });
  }
}

const countOf = (action: string) => prisma.auditLog.count({ where: { orgId: org.orgId, action } });

describe('clearing sign-in history', () => {
  it('removes authentication entries older than the cutoff', async () => {
    await seed(30);
    const before = await countOf('AUTH_LOGIN');
    expect(before).toBeGreaterThan(0);

    const res = await del().send({
      before: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.purged).toBeGreaterThan(0);
    expect(await countOf('AUTH_LOGIN')).toBeLessThan(before);
  });

  it('never touches the record trail', async () => {
    await seed(30);
    const trail = {
      records: await countOf('RECORD_UPDATED'),
      reviews: await countOf('INSPECTION_APPROVED'),
      settings: await countOf('SETTINGS_CHANGED'),
    };

    await del()
      .send({ before: new Date(Date.now() - 7 * 86_400_000).toISOString() })
      .expect(200);

    // The answer to "who changed this inspection and when" must survive
    // anything an operator can do from the console.
    expect(await countOf('RECORD_UPDATED')).toBe(trail.records);
    expect(await countOf('INSPECTION_APPROVED')).toBe(trail.reviews);
    // SETTINGS_CHANGED grows by one: the clearance records itself.
    expect(await countOf('SETTINGS_CHANGED')).toBe(trail.settings + 1);
  });

  it('leaves entries newer than the cutoff alone', async () => {
    await seed(1);
    const recent = await prisma.auditLog.count({
      where: {
        orgId: org.orgId,
        action: 'AUTH_LOGIN',
        createdAt: { gte: new Date(Date.now() - 2 * 86_400_000) },
      },
    });

    await del()
      .send({ before: new Date(Date.now() - 7 * 86_400_000).toISOString() })
      .expect(200);

    expect(
      await prisma.auditLog.count({
        where: {
          orgId: org.orgId,
          action: 'AUTH_LOGIN',
          createdAt: { gte: new Date(Date.now() - 2 * 86_400_000) },
        },
      }),
    ).toBe(recent);
  });

  it('records who cleared it, how many went, and the cutoff', async () => {
    await seed(30);
    const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const res = await del().send({ before: cutoff });

    const entry = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entity: 'AuditLog', action: 'SETTINGS_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });

    // Deleting the evidence leaves evidence — the property that makes the log
    // worth keeping at all.
    expect(entry).not.toBeNull();
    expect(entry!.userId).toBe(org.users.SUPER_ADMIN!.id);
    const meta = entry!.metadata as { purged?: number; before?: string };
    expect(meta.purged).toBe(res.body.data.purged);
    expect(meta.before).toBe(cutoff);
  });

  it('refuses an administrator — this is the owner’s to do', async () => {
    await seed(30);
    const before = await countOf('AUTH_LOGIN');

    const res = await del('ADMIN').send({
      before: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    });

    expect(res.status).toBe(403);
    expect(await countOf('AUTH_LOGIN')).toBe(before);
  });

  it('refuses everybody without audit access', async () => {
    for (const role of ['MANAGER', 'SUPERVISOR', 'INSPECTOR', 'VIEWER']) {
      const res = await del(role).send({
        before: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      });
      expect(res.status).toBe(403);
    }
  });

  it('requires a cutoff, so it cannot be used to erase the last hour wholesale', async () => {
    expect((await del().send({})).status).toBe(422);
  });

  it('refuses a cutoff in the future', async () => {
    const res = await del().send({
      before: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.status).toBe(422);
  });

  it('refuses to purge an action that is not an authentication event', async () => {
    const res = await del().send({
      before: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      actions: ['RECORD_DELETED'],
    });
    // Restricted at the schema, so a mistyped request cannot take the trail.
    expect(res.status).toBe(422);
  });

  it('does not reach into another organisation', async () => {
    const other = await createTestOrg();
    try {
      // The fixture writes no audit entries, so give the other organisation
      // something that would be destroyed if the purge were not org-scoped.
      await prisma.auditLog.create({
        data: {
          id: unique('o')
            .toUpperCase()
            .replace(/[^0-9A-Z]/g, '0')
            .slice(0, 26)
            .padEnd(26, '0'),
          orgId: other.orgId,
          userId: other.users.ADMIN!.id,
          action: 'AUTH_LOGIN',
          entity: 'Test',
          entityId: other.orgId,
          createdAt: new Date(Date.now() - 30 * 86_400_000),
        },
      });

      const theirs = await prisma.auditLog.count({ where: { orgId: other.orgId } });
      expect(theirs).toBeGreaterThan(0);

      await del().send({ before: new Date().toISOString() }).expect(200);

      expect(await prisma.auditLog.count({ where: { orgId: other.orgId } })).toBe(theirs);
    } finally {
      await other.cleanup();
    }
  });
});
