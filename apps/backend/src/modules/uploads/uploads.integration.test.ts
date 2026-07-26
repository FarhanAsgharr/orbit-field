/**
 * Chunked upload, end to end.
 *
 * Attachments are the one payload path where a partial failure is invisible: a
 * dropped chunk produces a file that assembles to the wrong bytes, and nobody
 * notices until an auditor opens the photo. So the assertions here are about
 * integrity rather than status codes — checksums are verified at receipt, a
 * truncated session is refused, and a replayed chunk is idempotent because a
 * phone on a bad link will send one twice.
 */

import { createHash, randomBytes } from 'node:crypto';

import { ulid } from '@orbit/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';

const app = createApp();
const api = '/api/v1';

let org: TestOrg;
let token: string;
let deviceId: string;
let userId: string;
let inspectionId: string;
let lamport = 0;

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

beforeAll(async () => {
  org = await createTestOrg();
  const inspector = org.users.INSPECTOR!;
  const login = await request(app)
    .post(`${api}/auth/login`)
    .send({
      email: inspector.email,
      password: inspector.password,
      device: {
        installationId: unique('upload-dev'),
        name: 'Upload Device',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
      },
    });
  token = login.body.data.tokens.accessToken;
  deviceId = login.body.data.device.id;
  userId = login.body.data.user.id;
  inspectionId = await createInspection(org, userId);
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

/** Register the attachment row the upload session will attach bytes to. */
async function registerAttachment(payload: Buffer): Promise<string> {
  const attachmentId = ulid();
  lamport += 1;
  await request(app)
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
  return attachmentId;
}

const openSession = (attachmentId: string, payload: Buffer, chunkSize: number) =>
  request(app)
    .post(`${api}/uploads`)
    .set('Authorization', `Bearer ${token}`)
    .send({ attachmentId, sizeBytes: payload.length, checksum: sha(payload), chunkSize });

const sendChunk = (uploadId: string, index: number, slice: Buffer) =>
  request(app)
    .post(`${api}/uploads/${uploadId}/chunks/${index}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ data: slice.toString('base64'), checksum: sha(slice) });

describe('upload sessions', () => {
  it('requires authentication', async () => {
    const res = await request(app).post(`${api}/uploads`).send({});
    expect(res.status).toBe(401);
  });

  it('opens a session and computes the chunk count itself', async () => {
    const payload = randomBytes(300 * 1024);
    const attachmentId = await registerAttachment(payload);
    const chunkSize = 128 * 1024;

    const res = await openSession(attachmentId, payload, chunkSize);

    expect(res.status).toBe(201);
    expect(res.body.data.uploadId).toBeTruthy();
    expect(res.body.data.totalChunks).toBe(Math.ceil(payload.length / res.body.data.chunkSize));
  });

  it('transfers, assembles, and returns bytes identical to what was sent', async () => {
    const payload = randomBytes(260 * 1024);
    const attachmentId = await registerAttachment(payload);
    const session = await openSession(attachmentId, payload, 128 * 1024);
    const { uploadId, chunkSize, totalChunks } = session.body.data;

    for (let i = 0; i < totalChunks; i++) {
      const slice = payload.subarray(i * chunkSize, (i + 1) * chunkSize);
      expect((await sendChunk(uploadId, i, slice)).status).toBeLessThan(300);
    }

    const complete = await request(app)
      .post(`${api}/uploads/${uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checksum: sha(payload) });
    expect(complete.status).toBeLessThan(300);
    expect(complete.body.data.storageKey).toBeTruthy();

    const download = await request(app)
      .get(`${api}/uploads/attachments/${attachmentId}/content`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(download.status).toBe(200);
    // The whole point of the checksum plumbing: what comes back is byte-for-byte
    // what went in, not merely something of the right length.
    expect(sha(download.body as Buffer)).toBe(sha(payload));
  });

  it('is idempotent when a chunk is re-sent after a dropped connection', async () => {
    const payload = randomBytes(200 * 1024);
    const attachmentId = await registerAttachment(payload);
    const session = await openSession(attachmentId, payload, 128 * 1024);
    const { uploadId, chunkSize } = session.body.data;
    const first = payload.subarray(0, chunkSize);

    expect((await sendChunk(uploadId, 0, first)).status).toBeLessThan(300);
    expect((await sendChunk(uploadId, 0, first)).status).toBeLessThan(300);
  });

  it('rejects a chunk whose checksum does not match its bytes', async () => {
    const payload = randomBytes(200 * 1024);
    const attachmentId = await registerAttachment(payload);
    const session = await openSession(attachmentId, payload, 128 * 1024);
    const { uploadId } = session.body.data;

    const res = await request(app)
      .post(`${api}/uploads/${uploadId}/chunks/0`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        data: Buffer.from('these are not the bytes').toString('base64'),
        checksum: sha(Buffer.from('something else entirely')),
      });

    // Caught at receipt, not at assembly — otherwise the whole transfer is
    // wasted before the corruption is noticed.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to complete while a chunk is still missing', async () => {
    const payload = randomBytes(300 * 1024);
    const attachmentId = await registerAttachment(payload);
    const session = await openSession(attachmentId, payload, 128 * 1024);
    const { uploadId, chunkSize, totalChunks } = session.body.data;

    // Everything except the last chunk.
    for (let i = 0; i < totalChunks - 1; i++) {
      await sendChunk(uploadId, i, payload.subarray(i * chunkSize, (i + 1) * chunkSize));
    }

    const res = await request(app)
      .post(`${api}/uploads/${uploadId}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ checksum: sha(payload) });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses another user’s attachment content', async () => {
    const payload = randomBytes(1024);
    const attachmentId = await registerAttachment(payload);

    const outsider = await createTestOrg();
    try {
      const login = await request(app)
        .post(`${api}/auth/login`)
        .send({
          email: outsider.users.ADMIN!.email,
          password: outsider.users.ADMIN!.password,
          device: {
            installationId: unique('outsider'),
            name: 'Outsider',
            platform: 'web',
            osVersion: '1',
            appVersion: '1.0.0',
          },
        });

      const res = await request(app)
        .get(`${api}/uploads/attachments/${attachmentId}/content`)
        .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`);

      expect([403, 404]).toContain(res.status);
    } finally {
      await outsider.cleanup();
    }
  });
});
