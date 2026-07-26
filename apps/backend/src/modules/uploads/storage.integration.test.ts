/**
 * The storage layer and the parts of the upload lifecycle the happy path skips.
 *
 * `uploads.integration.test.ts` proves a photograph taken in a basement arrives
 * intact. This file covers what happens when it does not: an abandoned session,
 * a cancelled one, a session whose attachment belongs to somebody else, a key
 * crafted to escape the storage root.
 *
 * Two of these matter more than the rest.
 *
 * `safeKey` is the boundary between a storage key and the filesystem. The
 * filename travels from a phone, through sync, into a path — so a key
 * containing `..` is a request to write outside the storage root, and the only
 * safe outcome is a throw. It is tested directly rather than through the API
 * because the API is not the only caller.
 *
 * Abandoned sessions are the quiet one. Chunks for an upload nobody finishes
 * stay on disk forever; on object storage that is a bill that grows and never
 * shrinks, and nothing surfaces it. The prune is the only thing that removes
 * them, so it is asserted to actually remove them rather than merely to run.
 */

import { createHash, randomBytes } from 'node:crypto';

import { ulid } from '@orbit/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';
import { attachmentKey, storage } from './storage.js';
import { pruneExpiredUploads } from './uploads.routes.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

let org: TestOrg;
let token: string;
let deviceId: string;
let userId: string;
let inspectionId: string;
let lamport = 0;

beforeAll(async () => {
  org = await createTestOrg();
  const inspector = org.users.INSPECTOR!;
  const login = await request(server)
    .post(`${api}/auth/login`)
    .send({
      email: inspector.email,
      password: inspector.password,
      device: {
        installationId: unique('store-dev'),
        name: 'Storage Device',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
      },
    });
  expect(login.status).toBe(200);
  token = login.body.data.tokens.accessToken;
  deviceId = login.body.data.device.id;
  userId = login.body.data.user.id;
  inspectionId = await createInspection(org, userId);
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

async function registerAttachment(payload: Buffer): Promise<string> {
  const attachmentId = ulid();
  lamport += 1;
  const res = await request(server)
    .post(`${api}/sync/push`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      protocolVersion: 1,
      deviceId,
      cursor: 0,
      operations: [
        {
          id: ulid(),
          entity: 'ATTACHMENT',
          operation: 'CREATE',
          entityId: attachmentId,
          patch: {
            inspectionId,
            kind: 'PHOTO',
            fileName: 'evidence.bin',
            mimeType: 'application/octet-stream',
            sizeBytes: payload.length,
            checksum: sha(payload),
            state: 'QUEUED',
          },
          baseVersion: null,
          dependsOn: [],
          clientTimestamp: new Date().toISOString(),
          lamport,
          deviceId,
          userId,
        },
      ],
    });
  expect(res.status).toBe(200);
  return attachmentId;
}

const openSession = (attachmentId: string, payload: Buffer, chunkSize: number) =>
  request(server)
    .post(`${api}/uploads`)
    .set('Authorization', `Bearer ${token}`)
    .send({ attachmentId, sizeBytes: payload.length, checksum: sha(payload), chunkSize });

const sendChunk = (uploadId: string, index: number, slice: Buffer) =>
  request(server)
    .post(`${api}/uploads/${uploadId}/chunks/${index}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ data: slice.toString('base64'), checksum: sha(slice) });

describe('storage keys', () => {
  it('lays attachments out by organisation and month, keeping the extension', async () => {
    const key = attachmentKey(
      '01ORGANISATION000000000000',
      '01ATTACHMENT00000000000000',
      'roof.jpg',
    );

    expect(key).toMatch(/^attachments\/01ORGANISATION000000000000\/\d{4}\/\d{2}\//);
    // The extension survives so a downloaded file opens in the right viewer.
    expect(key.endsWith('.jpg')).toBe(true);
  });

  it('copes with a filename that has no extension', async () => {
    const key = attachmentKey('01ORG00000000000000000000A', '01ATT00000000000000000000A', 'noext');
    expect(key.endsWith('01ATT00000000000000000000A')).toBe(true);
  });

  it('refuses to read a key that would escape the storage root', async () => {
    const driver = storage();
    // The filename arrives from a phone via sync, so this is reachable input,
    // not a hypothetical.
    await expect(driver.read('../../etc/passwd')).rejects.toThrow(/unsafe/i);
    await expect(driver.read('/etc/passwd')).rejects.toThrow(/unsafe/i);
    await expect(driver.read('attachments/\0/evil')).rejects.toThrow(/unsafe/i);
  });

  it('refuses to delete through an unsafe key', async () => {
    // The guard runs while building the path, before the `catch` that would
    // otherwise swallow it — so an unsafe delete is refused outright rather
    // than quietly doing nothing.
    await expect(storage().delete('../../etc/passwd')).rejects.toThrow(/unsafe/i);
  });

  it('answers "no" to an existence check on an unsafe key', async () => {
    // `exists` catches everything and reports absence. Nothing is read and
    // nothing escapes the root, so a negative answer is the right outcome; it
    // is asserted so the difference from `read` and `delete` stays deliberate.
    expect(await storage().exists('../../etc/passwd')).toBe(false);
  });

  it('reports a missing object as absent rather than throwing', async () => {
    const driver = storage();
    expect(await driver.exists(`attachments/${ulid()}/nothing-here.bin`)).toBe(false);
  });
});

describe('session lifecycle', () => {
  it('reports progress while chunks are still outstanding', async () => {
    const payload = randomBytes(300);
    const attachmentId = await registerAttachment(payload);
    const opened = await openSession(attachmentId, payload, 100);
    expect(opened.status).toBe(201);

    const uploadId = opened.body.data.uploadId as string;
    await sendChunk(uploadId, 0, payload.subarray(0, 100)).expect(200);

    const status = await request(server)
      .get(`${api}/uploads/${uploadId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(status.status).toBe(200);
    // A resuming client needs to know which chunks to re-send, not just that
    // the session exists.
    expect(status.body.data.receivedChunks ?? status.body.data.received).toBeDefined();
  });

  it('cancels a session and removes its chunks', async () => {
    const payload = randomBytes(200);
    const attachmentId = await registerAttachment(payload);
    const opened = await openSession(attachmentId, payload, 100);
    const uploadId = opened.body.data.uploadId as string;

    await sendChunk(uploadId, 0, payload.subarray(0, 100)).expect(200);

    const cancelled = await request(server)
      .delete(`${api}/uploads/${uploadId}`)
      .set('Authorization', `Bearer ${token}`);
    expect([200, 204]).toContain(cancelled.status);

    const driver = storage();
    expect(await driver.hasChunk(uploadId, 0)).toBe(false);

    // And the session must not still be usable afterwards.
    const afterwards = await sendChunk(uploadId, 1, payload.subarray(100));
    expect(afterwards.status).toBeGreaterThanOrEqual(400);
  });

  it('404s for an upload id that was never opened', async () => {
    const res = await request(server)
      .get(`${api}/uploads/${ulid()}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('rejects a chunk index beyond the declared count', async () => {
    const payload = randomBytes(100);
    const attachmentId = await registerAttachment(payload);
    const opened = await openSession(attachmentId, payload, 100);
    const uploadId = opened.body.data.uploadId as string;

    const res = await sendChunk(uploadId, 99, payload);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a session for an attachment that does not exist', async () => {
    const payload = randomBytes(50);
    const res = await request(server)
      .post(`${api}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ attachmentId: ulid(), sizeBytes: payload.length, checksum: sha(payload) });

    expect(res.status).toBe(404);
  });

  it('refuses a session for another organisation’s attachment', async () => {
    const other = await createTestOrg();
    try {
      const theirAttachment = await prisma.attachment.create({
        data: {
          id: ulid(),
          orgId: other.orgId,
          kind: 'PHOTO',
          fileName: 'theirs.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: BigInt(10),
          checksum: 'b'.repeat(64),
        },
      });

      const payload = randomBytes(10);
      const res = await request(server)
        .post(`${api}/uploads`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          attachmentId: theirAttachment.id,
          sizeBytes: payload.length,
          checksum: sha(payload),
        });

      // Otherwise an upload session is a way to overwrite another tenant's
      // evidence with your own bytes.
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });

  it('rejects a checksum that is not a SHA-256 digest', async () => {
    const payload = randomBytes(20);
    const attachmentId = await registerAttachment(payload);

    const res = await request(server)
      .post(`${api}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ attachmentId, sizeBytes: payload.length, checksum: 'not-a-digest' });

    expect(res.status).toBe(422);
  });

  it('rejects a declared size of zero', async () => {
    const attachmentId = await registerAttachment(Buffer.alloc(0));
    const res = await request(server)
      .post(`${api}/uploads`)
      .set('Authorization', `Bearer ${token}`)
      .send({ attachmentId, sizeBytes: 0, checksum: sha(Buffer.alloc(0)) });

    expect(res.status).toBe(422);
  });
});

describe('pruning abandoned sessions', () => {
  it('removes an expired session and the chunks it left behind', async () => {
    const payload = randomBytes(200);
    const attachmentId = await registerAttachment(payload);
    const opened = await openSession(attachmentId, payload, 100);
    const uploadId = opened.body.data.uploadId as string;

    await sendChunk(uploadId, 0, payload.subarray(0, 100)).expect(200);
    const driver = storage();
    expect(await driver.hasChunk(uploadId, 0)).toBe(true);

    // Backdate it rather than waiting out the real expiry.
    await prisma.uploadSession.update({
      where: { id: uploadId },
      data: { expiresAt: new Date(Date.now() - 86_400_000) },
    });

    const pruned = await pruneExpiredUploads();
    expect(pruned).toBeGreaterThan(0);

    expect(await prisma.uploadSession.findUnique({ where: { id: uploadId } })).toBeNull();
    // The row going away while the bytes stay is the failure that costs money
    // quietly, so the chunk is what is actually asserted.
    expect(await driver.hasChunk(uploadId, 0)).toBe(false);
  });

  it('leaves a live session alone', async () => {
    const payload = randomBytes(100);
    const attachmentId = await registerAttachment(payload);
    const opened = await openSession(attachmentId, payload, 100);
    const uploadId = opened.body.data.uploadId as string;

    await pruneExpiredUploads();

    expect(await prisma.uploadSession.findUnique({ where: { id: uploadId } })).not.toBeNull();
  });
});

describe('serving attachment content', () => {
  it('404s for an attachment with no bytes uploaded yet', async () => {
    const payload = randomBytes(64);
    const attachmentId = await registerAttachment(payload);

    const res = await request(server)
      .get(`${api}/uploads/attachments/${attachmentId}/content`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('404s for an attachment that does not exist at all', async () => {
    const res = await request(server)
      .get(`${api}/uploads/attachments/${ulid()}/content`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await request(server).get(`${api}/uploads/attachments/${ulid()}/content`);
    expect(res.status).toBe(401);
  });
});
