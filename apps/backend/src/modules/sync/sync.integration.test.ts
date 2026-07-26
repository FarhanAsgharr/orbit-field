/**
 * Sync protocol, end to end.
 *
 * This is the part of the system with the most ways to be subtly wrong, and the
 * fewest ways to notice: a device that mis-syncs does not error, it quietly
 * holds the wrong data, and the inspector finds out on site. The cases below are
 * the ones that decide whether the offline promise actually holds —
 *
 *  - a device-minted primary key is honoured rather than rewritten
 *  - a replayed operation is recognised, not applied twice
 *  - two devices editing different fields merge without a human
 *  - two devices editing the *same* field raise a conflict rather than one
 *    silently winning
 *  - a conflict survives as a record that can be resolved later
 *
 * Every one of these is asserted through the HTTP API with two independent
 * device identities, because that is the shape the real clients take.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ulid } from '@orbit/utils';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';

const app = createApp();
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
  const res = await request(app)
    .post(`${api}/auth/login`)
    .send({
      email,
      password,
      device: {
        installationId: unique('sync-dev'),
        name: 'Sync Device',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
      },
    });
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
  request(app)
    .post(`${api}/sync/push`)
    .set('Authorization', `Bearer ${client.token}`)
    .send({ protocolVersion: 1, deviceId: client.deviceId, cursor: 0, operations });

const pull = (client: Client, since = 0, limit = 500) =>
  request(app)
    .get(`${api}/sync/pull?protocolVersion=1&since=${since}&limit=${limit}`)
    .set('Authorization', `Bearer ${client.token}`);

/** Create an inspection owned by the pushing device, inside the fixture project. */
function newInspection(client: Client, title = 'Sync test inspection') {
  const id = ulid();
  return {
    id,
    op: operation(client, 'INSPECTION', 'CREATE', id, {
      templateId: org.templateId,
      templateVersionId: org.templateVersionId,
      // Both are required for an INSPECTOR to retain access: project scope is
      // checked before ownership, so a null projectId is refused outright.
      projectId: org.projectId,
      siteId: org.siteId,
      assignedToId: client.userId,
      title,
      status: 'IN_PROGRESS',
      priority: 'NORMAL',
    }),
  };
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

describe('POST /sync/push', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post(`${api}/sync/push`)
      .send({ protocolVersion: 1, deviceId: alpha.deviceId, cursor: 0, operations: [] });
    expect(res.status).toBe(401);
  });

  it('honours a device-minted ULID rather than assigning its own', async () => {
    const { id, op } = newInspection(alpha);
    const res = await push(alpha, [op]);

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('APPLIED');
    expect(res.body.results[0].entityId).toBe(id);
    expect(res.body.results[0].version).toBe(1);
    expect(typeof res.body.results[0].syncCursor).toBe('number');
  });

  it('reports a replayed operation as DUPLICATE and creates no second row', async () => {
    const { id, op } = newInspection(alpha);
    const first = await push(alpha, [op]);
    const replay = await push(alpha, [op]);

    expect(first.body.results[0].status).toBe('APPLIED');
    expect(replay.body.results[0].status).toBe('DUPLICATE');

    const rows = await prisma.inspection.findMany({ where: { id } });
    expect(rows).toHaveLength(1);
  });

  it('drains a backlog of queued operations in one request', async () => {
    const { id, op } = newInspection(alpha);
    await push(alpha, [op]);

    const backlog = Array.from({ length: 5 }, (_, n) =>
      operation(alpha, 'INSPECTION', 'UPDATE', id, { notes: `Queued while offline ${n}` }),
    );
    const res = await push(alpha, backlog);

    expect(res.status).toBe(200);
    for (const result of res.body.results) {
      expect(['APPLIED', 'DUPLICATE']).toContain(result.status);
    }
  });

  it('refuses an edit to an inspection the user does not own', async () => {
    const foreign = await createTestOrg();
    try {
      const { id, op } = newInspection(alpha);
      await push(alpha, [op]);
      // Reassigning to somebody in another organisation must not be accepted.
      const res = await push(alpha, [
        operation(alpha, 'INSPECTION', 'UPDATE', id, {
          assignedToId: foreign.users.INSPECTOR!.id,
        }),
      ]);
      expect(['REJECTED', 'CONFLICT']).toContain(res.body.results[0].status);
    } finally {
      await foreign.cleanup();
    }
  });
});

describe('GET /sync/pull', () => {
  it('returns a JSON number cursor, not a stringified BigInt', async () => {
    const res = await pull(alpha, 0);
    expect(res.status).toBe(200);
    // Postgres bigint arrives as a JS BigInt and JSON.stringify throws on it;
    // this is the exact defect that made every production login a 500.
    expect(typeof res.body.cursor).toBe('number');
  });

  it('replicates the reference data a device needs to work offline', async () => {
    const res = await pull(alpha, 0);
    const entities = new Set<string>(
      (res.body.changes as Array<{ entity: string }>).map((c) => c.entity),
    );
    for (const required of ['ORGANIZATION', 'USER', 'PROJECT', 'SITE', 'TEMPLATE_VERSION']) {
      expect(entities).toContain(required);
    }
  });

  it('carries the template definition, without which nothing is renderable', async () => {
    const res = await pull(alpha, 0);
    const version = (
      res.body.changes as Array<{ entity: string; data: Record<string, unknown> }>
    ).find((c) => c.entity === 'TEMPLATE_VERSION');
    expect(version).toBeDefined();
    expect(version!.data.definition).toBeDefined();
    // The display fields live on the parent Template, which devices do not
    // replicate — omitting them fails a NOT NULL constraint on the device and
    // takes the rest of the delta with it.
    expect(version!.data.name).toBeTruthy();
  });

  it('returns only changes after the supplied cursor', async () => {
    const before = await pull(alpha, 0);
    const cursor: number = before.body.cursor;

    const { op } = newInspection(alpha, 'After the cursor');
    await push(alpha, [op]);

    const after = await pull(alpha, cursor);
    expect(after.body.changes.length).toBeGreaterThan(0);
    for (const change of after.body.changes as Array<{ syncCursor: number }>) {
      expect(change.syncCursor).toBeGreaterThan(cursor);
    }
  });
});

describe('three-way merge', () => {
  it('auto-merges concurrent edits to different fields', async () => {
    const { id, op } = newInspection(alpha);
    await push(alpha, [op]);

    const alphaEdit = await push(alpha, [
      operation(alpha, 'INSPECTION', 'UPDATE', id, { notes: 'Alpha saw corrosion' }, 1),
    ]);
    // Bravo edits from the same base version but touches a different field, so
    // the merge is unambiguous and must not involve a human.
    const bravoEdit = await push(bravo, [
      operation(bravo, 'INSPECTION', 'UPDATE', id, { priority: 'CRITICAL' }, 1),
    ]);

    expect(alphaEdit.body.results[0].status).toBe('APPLIED');
    expect(bravoEdit.body.results[0].status).toBe('APPLIED');

    const row = await prisma.inspection.findUnique({ where: { id } });
    expect(row?.notes).toBe('Alpha saw corrosion');
    expect(row?.priority).toBe('CRITICAL');
  });
});

describe('conflicts', () => {
  it('raises a CONFLICT with a three-way diff when the same field clashes', async () => {
    const { id, op } = newInspection(alpha);
    await push(alpha, [op]);

    await push(alpha, [
      operation(alpha, 'INSPECTION', 'UPDATE', id, { title: 'Alpha renamed this' }, 1),
    ]);
    const clash = await push(bravo, [
      operation(bravo, 'INSPECTION', 'UPDATE', id, { title: 'Bravo renamed this' }, 1),
    ]);

    const result = clash.body.results[0];
    expect(result.status).toBe('CONFLICT');
    expect(Array.isArray(result.conflict.diffs)).toBe(true);

    const diff = (result.conflict.diffs as Array<Record<string, unknown>>).find(
      (d) => d.path === 'title',
    );
    expect(diff?.isConflicting).toBe(true);
    expect(diff?.localValue).toBe('Bravo renamed this');
    expect(diff?.serverValue).toBe('Alpha renamed this');
    expect(result.conflict.isAutoResolvable).toBe(false);

    // Nothing is silently overwritten: the server keeps the value it accepted.
    const row = await prisma.inspection.findUnique({ where: { id } });
    expect(row?.title).toBe('Alpha renamed this');
  });

  it('persists the conflict for later resolution', async () => {
    const { id, op } = newInspection(alpha);
    await push(alpha, [op]);
    await push(alpha, [operation(alpha, 'INSPECTION', 'UPDATE', id, { title: 'Server wins' }, 1)]);
    const clashOp = operation(bravo, 'INSPECTION', 'UPDATE', id, { title: 'Device wins' }, 1);
    await push(bravo, [clashOp]);

    const list = await request(app)
      .get(`${api}/sync/conflicts`)
      .set('Authorization', `Bearer ${bravo.token}`);

    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
  });

  it('resolves a conflict with the device value when told to', async () => {
    const { id, op } = newInspection(alpha);
    await push(alpha, [op]);
    await push(alpha, [operation(alpha, 'INSPECTION', 'UPDATE', id, { title: 'Server value' }, 1)]);
    const clashOp = operation(bravo, 'INSPECTION', 'UPDATE', id, { title: 'Device value' }, 1);
    await push(bravo, [clashOp]);

    const res = await request(app)
      .post(`${api}/sync/conflicts/resolve`)
      .set('Authorization', `Bearer ${bravo.token}`)
      .send({ operationId: clashOp.id, strategy: 'MERGE', fieldChoices: { title: 'LOCAL' } });

    expect(res.status).toBe(200);
    expect(res.body.data.merged.title).toBe('Device value');
  });
});
