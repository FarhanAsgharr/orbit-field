/**
 * Sync handlers for every entity a device can push, not just inspections.
 *
 * `sync.integration.test.ts` covers the protocol — cursors, replay, three-way
 * merge, conflicts — using inspections as its vehicle. This file covers the
 * other four handlers, because each one has its own authorisation and
 * validation rules and a gap in any of them is a gap in the only write path
 * mobile clients have.
 *
 * What makes these worth testing individually: a device pushes what it recorded
 * hours ago in a basement, and the server is the last place a bad write can be
 * stopped. If a response can be attached to an inspection the pusher does not
 * own, that is cross-tenant data injection performed by an ordinary user with a
 * valid token — no exploit needed, just a modified client. Every handler's
 * `authorize` is therefore tested by pushing across a boundary and asserting
 * both the refusal and that no row appeared.
 *
 * Refusals are also checked to be *per-operation*: one bad operation in a batch
 * must not discard the nineteen good ones queued behind it, or a single
 * malformed record costs an inspector a day of offline work.
 */

import { ulid } from '@orbit/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import {
  createTestOrg,
  TEST_FIELD_ID,
  TEST_SECTION_ID,
  type TestOrg,
} from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

interface Client {
  token: string;
  deviceId: string;
  userId: string;
}

let org: TestOrg;
let inspector: Client;
let admin: Client;
let lamport = 0;

async function enrol(email: string, password: string): Promise<Client> {
  const res = await request(server)
    .post(`${api}/auth/login`)
    .send({
      email,
      password,
      device: {
        installationId: unique('eh-dev'),
        name: 'Handler Device',
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

/** Outcome for one operation id, so a batch can be asserted per-operation. */
function resultFor(
  body: { results: { operationId: string; status: string }[] },
  id: string,
): { operationId: string; status: string } | undefined {
  return body.results.find((r) => r.operationId === id);
}

/** Push a new inspection owned by the given client and return its id. */
async function newInspection(client: Client, title = 'Handler inspection') {
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
  expect(res.status).toBe(200);
  expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');
  return id;
}

beforeAll(async () => {
  org = await createTestOrg();
  inspector = await enrol(org.users.INSPECTOR!.email, org.users.INSPECTOR!.password);
  admin = await enrol(org.users.ADMIN!.email, org.users.ADMIN!.password);
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

describe('responses', () => {
  it('records an answer against its inspection', async () => {
    const inspectionId = await newInspection(inspector);
    const id = ulid();

    const op = operation(inspector, 'RESPONSE', 'CREATE', id, {
      inspectionId,
      sectionId: TEST_SECTION_ID,
      fieldId: TEST_FIELD_ID,
      value: { value: 'pass' },
    });
    const res = await push(inspector, [op]);

    expect(res.status).toBe(200);
    expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');

    const stored = await prisma.inspectionResponse.findUnique({ where: { id } });
    expect(stored).not.toBeNull();
    expect(stored!.inspectionId).toBe(inspectionId);
  });

  it('converges when a device replays a create it never saw acknowledged', async () => {
    const inspectionId = await newInspection(inspector);
    const id = ulid();
    const patch = {
      inspectionId,
      sectionId: TEST_SECTION_ID,
      fieldId: TEST_FIELD_ID,
      value: { value: 'pass' },
    };

    await push(inspector, [operation(inspector, 'RESPONSE', 'CREATE', id, patch)]);
    // A different operation id, same answer: the device retried after losing the
    // response, so the unique key (inspection, field, repeat) must absorb it
    // rather than raising a duplicate-key 500.
    const retry = await push(inspector, [
      operation(inspector, 'RESPONSE', 'CREATE', ulid(), patch),
    ]);
    expect(retry.status).toBe(200);

    const rows = await prisma.inspectionResponse.count({
      where: { inspectionId, fieldId: TEST_FIELD_ID, repeatIndex: 0 },
    });
    expect(rows).toBe(1);
  });

  it('refuses an answer that names no field or section', async () => {
    const inspectionId = await newInspection(inspector);
    const op = operation(inspector, 'RESPONSE', 'CREATE', ulid(), { inspectionId });

    const res = await push(inspector, [op]);
    expect(res.status).toBe(200);
    expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
  });

  it('refuses an answer whose parent inspection does not exist', async () => {
    const op = operation(inspector, 'RESPONSE', 'CREATE', ulid(), {
      inspectionId: ulid(),
      sectionId: TEST_SECTION_ID,
      fieldId: TEST_FIELD_ID,
      value: { value: 'pass' },
    });

    const res = await push(inspector, [op]);
    expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
  });

  it('refuses an answer attached to another organisation’s inspection, and writes nothing', async () => {
    const other = await createTestOrg();
    try {
      const theirClient = await enrol(
        other.users.INSPECTOR!.email,
        other.users.INSPECTOR!.password,
      );
      const theirInspection = await newInspectionFor(other, theirClient);

      const id = ulid();
      const op = operation(inspector, 'RESPONSE', 'CREATE', id, {
        inspectionId: theirInspection,
        sectionId: TEST_SECTION_ID,
        fieldId: TEST_FIELD_ID,
        value: { value: 'fail' },
      });

      const res = await push(inspector, [op]);
      expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');

      // Cross-tenant injection needs no exploit, just a modified client — so
      // the absence of the row is the assertion that matters.
      expect(await prisma.inspectionResponse.findUnique({ where: { id } })).toBeNull();
    } finally {
      await other.cleanup();
    }
  });

  it('updates an existing answer', async () => {
    const inspectionId = await newInspection(inspector);
    const id = ulid();
    await push(inspector, [
      operation(inspector, 'RESPONSE', 'CREATE', id, {
        inspectionId,
        sectionId: TEST_SECTION_ID,
        fieldId: TEST_FIELD_ID,
        value: { value: 'pass' },
      }),
    ]);

    const before = await prisma.inspectionResponse.findUniqueOrThrow({ where: { id } });
    const res = await push(inspector, [
      operation(inspector, 'RESPONSE', 'UPDATE', id, { value: { value: 'fail' } }, before.version),
    ]);
    expect(res.status).toBe(200);

    const after = await prisma.inspectionResponse.findUniqueOrThrow({ where: { id } });
    expect(after.version).toBeGreaterThan(before.version);
  });
});

/** Create an inspection in a foreign fixture org, pushed by that org's device. */
async function newInspectionFor(target: TestOrg, client: Client) {
  const id = ulid();
  const op = operation(client, 'INSPECTION', 'CREATE', id, {
    templateId: target.templateId,
    templateVersionId: target.templateVersionId,
    projectId: target.projectId,
    siteId: target.siteId,
    assignedToId: client.userId,
    title: 'Foreign inspection',
    status: 'IN_PROGRESS',
    priority: 'NORMAL',
  });
  const res = await push(client, [op]);
  expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');
  return id;
}

describe('attachments', () => {
  const attachment = (inspectionId: string, over: Record<string, unknown> = {}) => ({
    inspectionId,
    kind: 'PHOTO',
    fileName: 'north-face.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    checksum: 'a'.repeat(64),
    ...over,
  });

  it('records the metadata a later upload will attach bytes to', async () => {
    const inspectionId = await newInspection(inspector);
    const id = ulid();

    const op = operation(inspector, 'ATTACHMENT', 'CREATE', id, attachment(inspectionId));
    const res = await push(inspector, [op]);

    expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');
    const stored = await prisma.attachment.findUnique({ where: { id } });
    expect(stored).not.toBeNull();
    expect(stored!.fileName).toBe('north-face.jpg');
  });

  it('refuses one that declares no checksum', async () => {
    const inspectionId = await newInspection(inspector);
    const op = operation(inspector, 'ATTACHMENT', 'CREATE', ulid(), {
      ...attachment(inspectionId),
      checksum: undefined,
    });

    const res = await push(inspector, [op]);
    // Without a checksum there is nothing to verify the uploaded bytes against,
    // and a corrupted photograph is evidence that silently says the wrong thing.
    expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
  });

  it('refuses one that declares no file name or type', async () => {
    const inspectionId = await newInspection(inspector);

    for (const missing of ['fileName', 'mimeType']) {
      const op = operation(inspector, 'ATTACHMENT', 'CREATE', ulid(), {
        ...attachment(inspectionId),
        [missing]: undefined,
      });
      const res = await push(inspector, [op]);
      expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
    }
  });

  it('refuses a viewer, who may look at inspections but not add evidence to them', async () => {
    const viewer = await enrol(org.users.VIEWER!.email, org.users.VIEWER!.password);
    const inspectionId = await newInspection(inspector);
    const id = ulid();

    const op = operation(viewer, 'ATTACHMENT', 'CREATE', id, attachment(inspectionId));
    const res = await push(viewer, [op]);

    // Refused wholesale at the route or individually by the handler — either is
    // correct; what must not happen is the row appearing.
    const applied = res.status === 200 && resultFor(res.body, op.id)?.status === 'APPLIED';
    expect(applied).toBe(false);
    expect(await prisma.attachment.findUnique({ where: { id } })).toBeNull();
  });
});

describe('signatures', () => {
  const signature = (inspectionId: string, over: Record<string, unknown> = {}) => ({
    inspectionId,
    role: 'INSPECTOR',
    signerName: 'A. Inspector',
    ...over,
  });

  it('records a signature against its inspection', async () => {
    const inspectionId = await newInspection(inspector);
    const id = ulid();

    const op = operation(inspector, 'SIGNATURE', 'CREATE', id, signature(inspectionId));
    const res = await push(inspector, [op]);

    expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');
    const stored = await prisma.signature.findUnique({ where: { id } });
    expect(stored).not.toBeNull();
    expect(stored!.signerName).toBe('A. Inspector');
    // Stamped server-side when the device does not supply one, so an unsigned
    // clock cannot backdate a sign-off.
    expect(stored!.signedAt).not.toBeNull();
  });

  it('refuses one that does not name the signatory', async () => {
    const inspectionId = await newInspection(inspector);
    const op = operation(inspector, 'SIGNATURE', 'CREATE', ulid(), {
      ...signature(inspectionId),
      signerName: undefined,
    });

    const res = await push(inspector, [op]);
    // An anonymous signature is not a signature.
    expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
  });

  it('refuses one whose inspection does not exist', async () => {
    const op = operation(inspector, 'SIGNATURE', 'CREATE', ulid(), signature(ulid()));
    const res = await push(inspector, [op]);
    expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
  });

  it('refuses signing another organisation’s inspection', async () => {
    const other = await createTestOrg();
    try {
      const theirClient = await enrol(
        other.users.INSPECTOR!.email,
        other.users.INSPECTOR!.password,
      );
      const theirInspection = await newInspectionFor(other, theirClient);

      const id = ulid();
      const op = operation(inspector, 'SIGNATURE', 'CREATE', id, signature(theirInspection));
      const res = await push(inspector, [op]);

      expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
      expect(await prisma.signature.findUnique({ where: { id } })).toBeNull();
    } finally {
      await other.cleanup();
    }
  });
});

describe('assets', () => {
  it('lets a permitted user create one from the field', async () => {
    const id = ulid();
    const op = operation(admin, 'ASSET', 'CREATE', id, {
      name: 'Roof hatch 4',
      tag: unique('TAG').slice(0, 30),
      siteId: org.siteId,
    });

    const res = await push(admin, [op]);
    expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');

    const stored = await prisma.asset.findUnique({ where: { id } });
    expect(stored?.name).toBe('Roof hatch 4');
  });

  it('refuses one with no name or tag', async () => {
    for (const patch of [{ name: 'Nameless' }, { tag: unique('T').slice(0, 20) }]) {
      const op = operation(admin, 'ASSET', 'CREATE', ulid(), patch);
      const res = await push(admin, [op]);
      expect(resultFor(res.body, op.id)?.status).not.toBe('APPLIED');
    }
  });

  it('lets an inspector add one, because unlisted plant is found on site', async () => {
    const id = ulid();
    const op = operation(inspector, 'ASSET', 'CREATE', id, {
      name: 'Extractor fan nobody recorded',
      tag: unique('TAG').slice(0, 30),
      siteId: org.siteId,
    });

    const res = await push(inspector, [op]);
    // INSPECTOR holds ASSET_WRITE deliberately: refusing would mean filing work
    // against equipment the office has not got round to entering.
    expect(resultFor(res.body, op.id)?.status).toBe('APPLIED');
    expect(await prisma.asset.findUnique({ where: { id } })).not.toBeNull();
  });

  it('refuses a viewer, who holds no write permission at all', async () => {
    const viewer = await enrol(org.users.VIEWER!.email, org.users.VIEWER!.password);
    const id = ulid();
    const op = operation(viewer, 'ASSET', 'CREATE', id, {
      name: 'Unauthorised asset',
      tag: unique('TAG').slice(0, 30),
    });

    const res = await push(viewer, [op]);
    const applied = res.status === 200 && resultFor(res.body, op.id)?.status === 'APPLIED';
    expect(applied).toBe(false);
    expect(await prisma.asset.findUnique({ where: { id } })).toBeNull();
  });

  it('updates an existing asset', async () => {
    const id = ulid();
    await push(admin, [
      operation(admin, 'ASSET', 'CREATE', id, {
        name: 'Before',
        tag: unique('TAG').slice(0, 30),
      }),
    ]);
    const before = await prisma.asset.findUniqueOrThrow({ where: { id } });

    const res = await push(admin, [
      operation(admin, 'ASSET', 'UPDATE', id, { name: 'After' }, before.version),
    ]);
    expect(res.status).toBe(200);

    const after = await prisma.asset.findUniqueOrThrow({ where: { id } });
    expect(after.name).toBe('After');
  });
});

describe('the batch contract', () => {
  it('applies the good operations in a batch that also contains a bad one', async () => {
    const inspectionId = await newInspection(inspector);

    const good = operation(inspector, 'RESPONSE', 'CREATE', ulid(), {
      inspectionId,
      sectionId: TEST_SECTION_ID,
      fieldId: TEST_FIELD_ID,
      value: { value: 'pass' },
    });
    const bad = operation(inspector, 'RESPONSE', 'CREATE', ulid(), { inspectionId });
    const alsoGood = operation(inspector, 'SIGNATURE', 'CREATE', ulid(), {
      inspectionId,
      role: 'INSPECTOR',
      signerName: 'A. Inspector',
    });

    const res = await push(inspector, [good, bad, alsoGood]);
    expect(res.status).toBe(200);

    // One malformed record must not cost an inspector the rest of a day's work.
    expect(resultFor(res.body, good.id)?.status).toBe('APPLIED');
    expect(resultFor(res.body, bad.id)?.status).not.toBe('APPLIED');
    expect(resultFor(res.body, alsoGood.id)?.status).toBe('APPLIED');
  });

  it('rejects an entity the server has no handler for', async () => {
    const op = operation(inspector, 'ORGANIZATION', 'UPDATE', org.orgId, { name: 'Renamed' });
    const res = await push(inspector, [op]);

    // A device must never be able to rewrite the organisation record.
    expect(res.status === 422 || resultFor(res.body, op.id)?.status !== 'APPLIED').toBe(true);
    const unchanged = await prisma.organization.findUniqueOrThrow({ where: { id: org.orgId } });
    expect(unchanged.name).not.toBe('Renamed');
  });

  it('rejects a protocol version it does not speak', async () => {
    const res = await request(server)
      .post(`${api}/sync/push`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ protocolVersion: 99, deviceId: inspector.deviceId, cursor: 0, operations: [] });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('accepts an empty batch without complaint', async () => {
    const res = await push(inspector, []);
    expect(res.status).toBe(200);
  });

  it('refuses a push naming a device the caller does not hold', async () => {
    const res = await request(server)
      .post(`${api}/sync/push`)
      .set('Authorization', `Bearer ${inspector.token}`)
      .send({ protocolVersion: 1, deviceId: admin.deviceId, cursor: 0, operations: [] });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('what a device receives back', () => {
  it('sees its own writes in a subsequent pull', async () => {
    const inspectionId = await newInspection(inspector, 'Visible in pull');

    const res = await request(server)
      .get(`${api}/sync/pull?protocolVersion=1&since=0&limit=500`)
      .set('Authorization', `Bearer ${inspector.token}`);

    expect(res.status).toBe(200);
    const ids = res.body.changes.map((c: { entityId: string }) => c.entityId);
    expect(ids).toContain(inspectionId);
  });

  it('never receives another organisation’s changes', async () => {
    const other = await createTestOrg();
    try {
      const theirClient = await enrol(
        other.users.INSPECTOR!.email,
        other.users.INSPECTOR!.password,
      );
      const theirInspection = await newInspectionFor(other, theirClient);

      const res = await request(server)
        .get(`${api}/sync/pull?protocolVersion=1&since=0&limit=500`)
        .set('Authorization', `Bearer ${inspector.token}`);

      const ids = res.body.changes.map((c: { entityId: string }) => c.entityId);
      expect(ids).not.toContain(theirInspection);
    } finally {
      await other.cleanup();
    }
  });
});
