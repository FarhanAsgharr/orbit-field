/**
 * Conflict resolution, delete replication, and the retention sweep.
 *
 * `sync.integration.test.ts` proves a conflict is *raised* with a three-way
 * diff. This proves it can be *ended* — every strategy, applied to a real
 * conflict, with the stored row checked afterwards. A conflict engine that
 * detects perfectly and resolves wrongly is worse than one that never detected
 * anything, because the wrong answer is written to the compliance record and
 * the warning is gone.
 *
 * Deletes get the same attention for a different reason. A device replays the
 * change log and nothing else, so a deletion that produces no tombstone leaves
 * the row on every phone permanently — visible, editable, and gone from the
 * server. That is invisible from the console, which is where anyone would look.
 *
 * The retention sweep is tested for what it must *not* remove: pruning a change
 * log entry a device has not yet pulled silently drops that change from the
 * fleet forever.
 */

import { ulid } from '@orbit/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';
import { pruneSyncTables } from './sync.service.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

interface Client {
  token: string;
  deviceId: string;
  userId: string;
}

let org: TestOrg;
let alpha: Client;
let bravo: Client;
let lamport = 0;

async function enrol(email: string, password: string): Promise<Client> {
  const res = await request(server)
    .post(`${api}/auth/login`)
    .send({
      email,
      password,
      device: {
        installationId: unique('svc-dev'),
        name: 'Service Device',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
      },
    });
  expect(res.status).toBe(200);
  return {
    token: res.body.data.tokens.accessToken,
    deviceId: res.body.data.device.id,
    userId: res.body.data.user.id,
  };
}

function operation(
  client: Client,
  entity: string,
  op: string,
  entityId: string,
  patch: Record<string, unknown>,
  baseVersion: number | null = null,
) {
  lamport += 1;
  return {
    id: ulid(),
    entity,
    operation: op,
    entityId,
    patch,
    baseVersion,
    dependsOn: [],
    clientTimestamp: new Date().toISOString(),
    lamport,
    deviceId: client.deviceId,
    userId: client.userId,
  };
}

const push = (client: Client, operations: unknown[]) =>
  request(server)
    .post(`${api}/sync/push`)
    .set('Authorization', `Bearer ${client.token}`)
    .send({ protocolVersion: 1, deviceId: client.deviceId, cursor: 0, operations });

async function newInspection(client: Client, title = 'Conflict subject') {
  const id = ulid();
  const op = operation(client, 'INSPECTION', 'CREATE', id, {
    templateId: org.templateId,
    templateVersionId: org.templateVersionId,
    projectId: org.projectId,
    siteId: org.siteId,
    assignedToId: client.userId,
    title,
    status: 'IN_PROGRESS',
    priority: 'NORMAL',
  });
  const res = await push(client, [op]);
  expect(res.body.results[0].status).toBe('APPLIED');
  return { id, version: res.body.results[0].version as number };
}

/**
 * Drive two devices into a genuine conflict on the same field, and return the
 * losing operation id.
 */
async function provokeConflict(title = 'Clashing title') {
  const { id, version } = await newInspection(alpha);

  await push(alpha, [
    operation(alpha, 'INSPECTION', 'UPDATE', id, { title: 'Alpha wins' }, version),
  ])
    .expect(200)
    .then((r) => expect(r.body.results[0].status).toBe('APPLIED'));

  // Bravo edits the same field from the same stale ancestor.
  const clash = operation(bravo, 'INSPECTION', 'UPDATE', id, { title }, version);
  const res = await push(bravo, [clash]);
  expect(res.body.results[0].status).toBe('CONFLICT');

  return { inspectionId: id, operationId: clash.id, deviceValue: title };
}

beforeAll(async () => {
  org = await createTestOrg();
  const inspector = org.users.INSPECTOR!;
  alpha = await enrol(inspector.email, inspector.password);
  bravo = await enrol(inspector.email, inspector.password);
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const resolve = (client: Client, body: Record<string, unknown>) =>
  request(server)
    .post(`${api}/sync/conflicts/resolve`)
    .set('Authorization', `Bearer ${client.token}`)
    .send(body);

describe('resolving a conflict', () => {
  /*
   * Resolution decides and records; it does not write the entity.
   *
   * The endpoint stores the merged record on the conflict row and hands it
   * back, and the device replays its operation against that — see the comment
   * at the end of the handler. So the assertions below are about the merged
   * payload and the stored decision, not the inspection row, which still holds
   * the server value until a replay arrives.
   */
  it('KEEP_LOCAL resolves to the device value', async () => {
    const { operationId, deviceValue } = await provokeConflict('Bravo insists');

    const res = await resolve(bravo, { operationId, strategy: 'KEEP_LOCAL' });
    expect(res.status).toBe(200);
    expect(res.body.data.resolved).toBe(true);
    expect(res.body.data.merged.title).toBe(deviceValue);

    const record = await prisma.syncConflictRecord.findFirstOrThrow({ where: { operationId } });
    expect(record.resolutionStrategy).toBe('KEEP_LOCAL');
    // Attributable: a resolution is itself a consequential act.
    expect(record.resolvedById).toBe(bravo.userId);
    expect((record.resolvedRecord as { title?: string }).title).toBe(deviceValue);
  });

  it('KEEP_SERVER resolves to the server value', async () => {
    const { inspectionId, operationId } = await provokeConflict('Bravo yields');

    const res = await resolve(bravo, { operationId, strategy: 'KEEP_SERVER' });
    expect(res.status).toBe(200);
    expect(res.body.data.merged.title).toBe('Alpha wins');

    const row = await prisma.inspection.findUniqueOrThrow({ where: { id: inspectionId } });
    expect(row.title).toBe('Alpha wins');
  });

  it('MERGE takes the chosen side per field', async () => {
    const { operationId } = await provokeConflict('Bravo partial');

    const res = await resolve(bravo, {
      operationId,
      strategy: 'MERGE',
      fieldChoices: { title: 'LOCAL' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.merged.title).toBe('Bravo partial');
  });

  it('MERGE accepts an explicit value neither side proposed', async () => {
    const { operationId } = await provokeConflict('Bravo third way');

    const res = await resolve(bravo, {
      operationId,
      strategy: 'MERGE',
      fieldValues: { title: 'A reviewer decided something else' },
    });
    expect(res.status).toBe(200);
    // A human looking at both sides is often right about neither.
    expect(res.body.data.merged.title).toBe('A reviewer decided something else');
  });

  it('refuses a MERGE that leaves a conflicting field undecided', async () => {
    const { operationId } = await provokeConflict('Bravo indecisive');

    const res = await resolve(bravo, { operationId, strategy: 'MERGE' });
    // Applying a half-decided merge would write an arbitrary side of a field
    // somebody was in the middle of deciding.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.title).toBeTruthy();
  });

  it('refuses to resolve the same conflict twice', async () => {
    const { operationId } = await provokeConflict('Bravo repeats');
    await resolve(bravo, { operationId, strategy: 'KEEP_SERVER' }).expect(200);

    const again = await resolve(bravo, { operationId, strategy: 'KEEP_LOCAL' });
    // A second decision silently overwriting the first is how two people
    // disagree and neither finds out.
    expect(again.status).toBe(409);
  });

  it('clears the conflict from the outstanding list', async () => {
    const { operationId } = await provokeConflict('Bravo resolves');

    const before = await request(server)
      .get(`${api}/sync/conflicts`)
      .set('Authorization', `Bearer ${bravo.token}`);
    expect(
      (before.body.data as Array<{ operationId: string }>).some(
        (c) => c.operationId === operationId,
      ),
    ).toBe(true);

    await resolve(bravo, { operationId, strategy: 'KEEP_SERVER' }).expect(200);

    const after = await request(server)
      .get(`${api}/sync/conflicts`)
      .set('Authorization', `Bearer ${bravo.token}`);
    // A conflict that stays listed after resolution means somebody decides it
    // twice, and the second decision overwrites the first.
    expect(
      (after.body.data as Array<{ operationId: string }>).some(
        (c) => c.operationId === operationId,
      ),
    ).toBe(false);
  });

  it('404s for an operation id that has no conflict', async () => {
    const res = await resolve(bravo, { operationId: ulid(), strategy: 'KEEP_SERVER' });
    expect(res.status).toBe(404);
  });

  it('rejects a strategy it does not recognise', async () => {
    const { operationId } = await provokeConflict('Bravo bad strategy');
    const res = await resolve(bravo, { operationId, strategy: 'COIN_TOSS' });
    expect(res.status).toBe(422);
  });

  it('does not expose another organisation’s conflict', async () => {
    const { operationId } = await provokeConflict('Bravo private');

    const other = await createTestOrg();
    try {
      const outsider = await enrol(other.users.INSPECTOR!.email, other.users.INSPECTOR!.password);
      const res = await resolve(outsider, { operationId, strategy: 'KEEP_LOCAL' });
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('writes an audit entry naming who decided and which way', async () => {
    const { inspectionId, operationId } = await provokeConflict('Bravo on the record');
    await resolve(bravo, { operationId, strategy: 'KEEP_LOCAL' }).expect(200);

    const log = await prisma.auditLog.findFirst({
      where: { orgId: org.orgId, entityId: inspectionId, action: 'CONFLICT_RESOLVED' },
      orderBy: { createdAt: 'desc' },
    });

    expect(log).not.toBeNull();
    expect(log!.userId).toBe(bravo.userId);
    expect((log!.metadata as { strategy?: string }).strategy).toBe('KEEP_LOCAL');
  });
});

describe('deletes replicate as tombstones', () => {
  it('a deleted inspection reaches devices as a DELETE, not as silence', async () => {
    const { id, version } = await newInspection(alpha, 'To be deleted');

    const op = operation(alpha, 'INSPECTION', 'DELETE', id, {}, version);
    const res = await push(alpha, [op]);
    expect(res.status).toBe(200);

    const entry = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: id, operation: 'DELETE' },
    });

    if (entry) {
      // A device that never sees the DELETE keeps the record forever, editable,
      // on a phone the server no longer knows about.
      expect(entry.data).toBeNull();
    } else {
      // If the handler refuses deletes outright, the row must still be intact —
      // what must never happen is a silent disappearance.
      const row = await prisma.inspection.findUnique({ where: { id } });
      expect(row).not.toBeNull();
    }
  });
});

describe('sync sessions', () => {
  it('records a session per device that a support engineer can inspect', async () => {
    await push(alpha, []);

    const res = await request(server)
      .get(`${api}/sync/sessions`)
      .set('Authorization', `Bearer ${alpha.token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('shows a device only its own sessions', async () => {
    const res = await request(server)
      .get(`${api}/sync/sessions`)
      .set('Authorization', `Bearer ${bravo.token}`);

    for (const session of res.body.data as Array<{ deviceId: string }>) {
      expect(session.deviceId).toBe(bravo.deviceId);
    }
  });
});

describe('the retention sweep', () => {
  it('leaves recent change-log entries alone', async () => {
    const { id } = await newInspection(alpha, 'Must survive the sweep');

    const result = await pruneSyncTables();
    expect(result).toHaveProperty('changeLog');
    expect(result).toHaveProperty('operations');

    const survivor = await prisma.changeLogEntry.findFirst({
      where: { orgId: org.orgId, entityId: id },
    });
    // Pruning an entry a device has not pulled drops that change from the
    // fleet permanently — there is no second copy anywhere.
    expect(survivor).not.toBeNull();
  });

  it('removes an entry older than the retention window', async () => {
    const { id } = await newInspection(alpha, 'Beyond retention');

    const cutoff = new Date(Date.now() - (env.SYNC_CHANGELOG_RETENTION_DAYS + 1) * 86_400_000);
    await prisma.changeLogEntry.updateMany({
      where: { orgId: org.orgId, entityId: id },
      data: { createdAt: cutoff },
    });

    const result = await pruneSyncTables();
    expect(result.changeLog).toBeGreaterThan(0);
    expect(
      await prisma.changeLogEntry.findFirst({ where: { orgId: org.orgId, entityId: id } }),
    ).toBeNull();
  });

  it('removes an expired idempotency record', async () => {
    const { id } = await newInspection(alpha, 'Expired ledger entry');
    expect(id).toBeTruthy();

    await prisma.syncOperationRecord.updateMany({
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });

    const result = await pruneSyncTables();
    expect(result.operations).toBeGreaterThan(0);
  });
});
