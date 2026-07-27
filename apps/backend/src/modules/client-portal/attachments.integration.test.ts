/**
 * Files a customer attaches to a request.
 *
 * These are the one place in Orbit Field where bytes arrive from outside the
 * organisation, and they are later opened by an inspector on a phone and by
 * staff on a desktop. So the tests are weighted towards what the server
 * refuses rather than what it accepts.
 *
 * There is no malware scanner in this deployment and these tests do not
 * pretend there is. What they establish is narrower and true: the server will
 * not store an executable whatever it claims to be, will not accept a type it
 * does not understand, will not serve anything back with a content-type a
 * browser will run, and will not let one customer reach another's files.
 *
 * The second theme is that a request attachment is an `Attachment` — the same
 * row an inspection photograph uses. That is what makes approval a foreign-key
 * update instead of a copy, and it is asserted directly: the id the customer
 * uploaded is the id the inspector receives.
 */

import { createHash, randomBytes } from 'node:crypto';

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
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const device = () => ({
  installationId: unique('att'),
  name: 'Attachment Device',
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

const post = (path: string, role = 'CLIENT') =>
  request(server).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const get = (path: string, role = 'CLIENT') =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const del = (path: string, role = 'CLIENT') =>
  request(server).delete(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

/** Bytes that genuinely start like the type they claim. */
const REAL = {
  pdf: () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(256)]),
  png: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(256)]),
  jpeg: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(256)]),
  docx: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(256)]),
  xlsx: () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(256)]),
  txt: () => Buffer.from('Site access notes.\n'),
};

const MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
};

async function raise(role = 'CLIENT'): Promise<string> {
  const res = await post('/inspection-requests', role).send({ title: 'With files' });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

/** Declare a file and push its bytes through the shared upload pipeline. */
async function attach(
  requestId: string,
  kind: keyof typeof REAL,
  role = 'CLIENT',
  over: Record<string, unknown> = {},
) {
  const bytes = REAL[kind]();
  const declared = await post(`/inspection-requests/${requestId}/attachments`, role).send({
    fileName: `evidence.${kind === 'jpeg' ? 'jpg' : kind}`,
    mimeType: MIME[kind],
    sizeBytes: bytes.length,
    checksum: sha(bytes),
    ...over,
  });
  return { declared, bytes, checksum: sha(bytes) };
}

async function upload(attachmentId: string, bytes: Buffer, role = 'CLIENT') {
  const session = await post('/uploads', role).send({
    attachmentId,
    sizeBytes: bytes.length,
    checksum: sha(bytes),
  });
  expect(session.status).toBe(201);
  const uploadId = session.body.data.uploadId as string;

  await post(`/uploads/${uploadId}/chunks/0`, role)
    .send({ data: bytes.toString('base64'), checksum: sha(bytes) })
    .expect(200);

  return post(`/uploads/${uploadId}/complete`, role).send({ checksum: sha(bytes) });
}

describe('the file types a customer may send', () => {
  it.each(['pdf', 'png', 'jpeg', 'docx', 'xlsx', 'txt'] as const)('accepts %s', async (kind) => {
    const id = await raise();
    const { declared } = await attach(id, kind);
    expect(declared.status).toBe(201);
  });

  it('refuses a type it does not understand', async () => {
    const id = await raise();
    const res = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: 'thing.dwg',
      mimeType: 'application/acad',
      sizeBytes: 100,
      checksum: sha(Buffer.from('x')),
    });
    expect(res.status).toBe(422);
  });

  it('refuses an executable by extension whatever it claims to be', async () => {
    const id = await raise();
    for (const fileName of ['payload.exe', 'run.sh', 'script.js', 'installer.msi']) {
      const res = await post(`/inspection-requests/${id}/attachments`).send({
        fileName,
        mimeType: 'application/pdf',
        sizeBytes: 100,
        checksum: sha(Buffer.from('x')),
      });
      expect(res.status, `${fileName} should be refused`).toBe(422);
    }
  });

  it('refuses a name whose extension disagrees with the declared type', async () => {
    const id = await raise();
    const res = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: 'actually-a-doc.png',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      checksum: sha(Buffer.from('x')),
    });
    expect(res.status).toBe(422);
  });

  it('refuses anything over 25 MB before a byte is sent', async () => {
    const id = await raise();
    const res = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: 'huge.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 26 * 1024 * 1024,
      checksum: sha(Buffer.from('x')),
    });
    // Rejecting at declaration means a doomed 26 MB upload never starts, which
    // matters on a site connection.
    expect(res.status).toBe(422);
    expect(res.body.error.fields?.sizeBytes).toBeTruthy();
  });

  it('refuses an empty file', async () => {
    const id = await raise();
    const res = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: 'nothing.txt',
      mimeType: 'text/plain',
      sizeBytes: 0,
      checksum: sha(Buffer.alloc(0)),
    });
    expect(res.status).toBe(422);
  });

  it('strips a path out of the file name', async () => {
    const id = await raise();
    const bytes = REAL.pdf();
    const res = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: '../../../etc/passwd.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      checksum: sha(bytes),
    });

    expect(res.status).toBe(201);
    // The name reaches a Content-Disposition header and a filesystem.
    expect(res.body.data.fileName).toBe('passwd.pdf');
    expect(res.body.data.fileName).not.toContain('/');
  });

  it('caps a request at twenty files', async () => {
    const id = await raise();
    for (let i = 0; i < 20; i++) {
      const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(String(i))]);
      const res = await post(`/inspection-requests/${id}/attachments`).send({
        fileName: `file-${i}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: bytes.length,
        checksum: sha(bytes),
      });
      expect(res.status).toBe(201);
    }

    const extra = await attach(id, 'pdf');
    expect(extra.declared.status).toBe(409);
  });

  it('treats the same bytes twice as one file', async () => {
    const id = await raise();
    const bytes = REAL.pdf();
    const body = {
      fileName: 'drawing.pdf',
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      checksum: sha(bytes),
    };

    const first = await post(`/inspection-requests/${id}/attachments`).send(body);
    const second = await post(`/inspection-requests/${id}/attachments`).send(body);

    // A retried submit must not leave two copies of the same drawing.
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
  });
});

describe('the bytes themselves', () => {
  it('stores a file and serves it back unchanged', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    const done = await upload(declared.body.data.id, bytes);
    expect(done.status).toBe(200);

    const back = await request(server)
      .get(`${api}/uploads/attachments/${declared.body.data.id}/content`)
      .set('Authorization', `Bearer ${tokens.CLIENT}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(back.status).toBe(200);
    expect((back.body as Buffer).equals(bytes)).toBe(true);
  });

  it('refuses a Windows executable renamed as a PDF', async () => {
    const id = await raise();
    // Declared as a PDF, named as a PDF, and an MZ binary inside. Every check
    // before this one reads only what the client said about the file.
    const evil = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), randomBytes(256)]);

    const declared = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: evil.length,
      checksum: sha(evil),
    });
    expect(declared.status).toBe(201);

    const done = await upload(declared.body.data.id, evil);
    expect(done.status).toBe(422);

    const stored = await prisma.attachment.findUniqueOrThrow({
      where: { id: declared.body.data.id },
    });
    // Nothing servable is left behind.
    expect(stored.storageKey).toBeNull();
    expect(stored.state).toBe('FAILED');
  });

  it('refuses content that is simply not the type it claims', async () => {
    const id = await raise();
    const notAPdf = Buffer.from('This is plain text pretending to be a PDF.');

    const declared = await post(`/inspection-requests/${id}/attachments`).send({
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: notAPdf.length,
      checksum: sha(notAPdf),
    });
    const done = await upload(declared.body.data.id, notAPdf);
    expect(done.status).toBe(422);
  });

  it('refuses a chunk whose checksum does not match its bytes', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');

    const session = await post('/uploads').send({
      attachmentId: declared.body.data.id,
      sizeBytes: bytes.length,
      checksum: sha(bytes),
    });

    const bad = await post(`/uploads/${session.body.data.uploadId}/chunks/0`).send({
      data: bytes.toString('base64'),
      checksum: sha(Buffer.from('something else')),
    });
    // Corruption on the wire must not become a stored file whose checksum lies.
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('resumes rather than restarting when a chunk is re-sent', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');

    const session = await post('/uploads').send({
      attachmentId: declared.body.data.id,
      sizeBytes: bytes.length,
      checksum: sha(bytes),
    });
    const uploadId = session.body.data.uploadId as string;

    const first = await post(`/uploads/${uploadId}/chunks/0`).send({
      data: bytes.toString('base64'),
      checksum: sha(bytes),
    });
    const again = await post(`/uploads/${uploadId}/chunks/0`).send({
      data: bytes.toString('base64'),
      checksum: sha(bytes),
    });

    // A device that dies mid-upload resends and continues.
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.data.receivedChunks).toEqual([0]);
  });

  it('serves an office document as a download rather than something to render', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'docx');
    await upload(declared.body.data.id, bytes);

    const back = await get(`/uploads/attachments/${declared.body.data.id}/content`);
    expect(back.headers['content-type']).toContain('application/octet-stream');
    expect(back.headers['content-disposition']).toContain('attachment');
    expect(back.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves a PDF inline, because that is the point of previewing one', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    await upload(declared.body.data.id, bytes);

    const back = await get(`/uploads/attachments/${declared.body.data.id}/content`);
    expect(back.headers['content-type']).toContain('application/pdf');
    expect(back.headers['content-disposition']).toContain('inline');
  });
});

describe('isolation', () => {
  it('one customer cannot list another’s files', async () => {
    const theirs = await raise('CLIENT_OTHER');
    await attach(theirs, 'pdf', 'CLIENT_OTHER');

    expect((await get(`/inspection-requests/${theirs}/attachments`)).status).toBe(404);
  });

  it('one customer cannot fetch another’s file by id', async () => {
    const theirs = await raise('CLIENT_OTHER');
    const { declared, bytes } = await attach(theirs, 'pdf', 'CLIENT_OTHER');
    await upload(declared.body.data.id, bytes, 'CLIENT_OTHER');

    const res = await get(`/uploads/attachments/${declared.body.data.id}/content`);
    // Without the client scope this endpoint returns any file in the
    // organisation to anybody who can guess an id.
    expect(res.status).toBe(404);
  });

  it('one customer cannot open an upload session against another’s attachment', async () => {
    const theirs = await raise('CLIENT_OTHER');
    const { declared, bytes } = await attach(theirs, 'pdf', 'CLIENT_OTHER');

    const res = await post('/uploads').send({
      attachmentId: declared.body.data.id,
      sizeBytes: bytes.length,
      checksum: sha(bytes),
    });
    // Otherwise a client could overwrite another company's evidence.
    expect(res.status).toBe(404);
  });

  it('one customer cannot attach to another’s request', async () => {
    const theirs = await raise('CLIENT_OTHER');
    const { declared } = await attach(theirs, 'pdf', 'CLIENT');
    expect(declared.status).toBe(404);
  });

  it('one customer cannot delete another’s file', async () => {
    const theirs = await raise('CLIENT_OTHER');
    const { declared } = await attach(theirs, 'pdf', 'CLIENT_OTHER');

    expect(
      (await del(`/inspection-requests/${theirs}/attachments/${declared.body.data.id}`)).status,
    ).toBe(404);
    expect(
      await prisma.attachment.count({ where: { id: declared.body.data.id, deletedAt: null } }),
    ).toBe(1);
  });

  it('another organisation cannot reach the file at all', async () => {
    const other = await createTestOrg();
    try {
      const mine = await raise();
      const { declared, bytes } = await attach(mine, 'pdf');
      await upload(declared.body.data.id, bytes);

      const theirLogin = await request(server)
        .post(`${api}/auth/login`)
        .send({
          email: other.users.ADMIN!.email,
          password: other.users.ADMIN!.password,
          device: device(),
        });

      const res = await request(server)
        .get(`${api}/uploads/attachments/${declared.body.data.id}/content`)
        .set('Authorization', `Bearer ${theirLogin.body.data.tokens.accessToken}`);
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('the lifecycle', () => {
  it('carries the files into the inspection without copying them', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    await upload(declared.body.data.id, bytes);

    const before = await prisma.attachment.findUniqueOrThrow({
      where: { id: declared.body.data.id },
    });

    const decided = await post(`/inspection-requests/${id}/decide`, 'ADMIN').send({
      decision: 'APPROVE',
      templateId: org.templateId,
      assignedToId: org.users.INSPECTOR!.id,
    });
    expect(decided.status).toBe(200);

    const after = await prisma.attachment.findUniqueOrThrow({
      where: { id: declared.body.data.id },
    });

    // Same row, same object in storage — the file was never transferred twice.
    expect(after.id).toBe(before.id);
    expect(after.storageKey).toBe(before.storageKey);
    expect(after.checksum).toBe(before.checksum);
    expect(after.inspectionId).toBe(decided.body.data.inspectionId);
    // Provenance survives: it is still the customer's file.
    expect(after.requestId).toBe(id);

    expect(await prisma.attachment.count({ where: { checksum: before.checksum } })).toBe(1);
  });

  it('puts them on the assigned inspector’s device', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    await upload(declared.body.data.id, bytes);

    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: org.users.INSPECTOR!.email,
        password: org.users.INSPECTOR!.password,
        device: device(),
      });
    const token = login.body.data.tokens.accessToken as string;
    const before = await request(server)
      .get(`${api}/sync/pull?protocolVersion=1&since=0&limit=500`)
      .set('Authorization', `Bearer ${token}`);

    await post(`/inspection-requests/${id}/decide`, 'ADMIN')
      .send({
        decision: 'APPROVE',
        templateId: org.templateId,
        assignedToId: org.users.INSPECTOR!.id,
      })
      .expect(200);

    const delta = await request(server)
      .get(`${api}/sync/pull?protocolVersion=1&since=${before.body.cursor}&limit=500`)
      .set('Authorization', `Bearer ${token}`);

    const entry = (delta.body.changes as Array<{ entity: string; entityId: string }>).find(
      (c) => c.entity === 'ATTACHMENT' && c.entityId === declared.body.data.id,
    );
    // Without this the inspector arrives on site without the customer's
    // drawing, and nothing about the inspection looks wrong.
    expect(entry).toBeTruthy();
  });

  it('lets the inspector download it, and the supervisor too', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    await upload(declared.body.data.id, bytes);
    await post(`/inspection-requests/${id}/decide`, 'ADMIN')
      .send({
        decision: 'APPROVE',
        templateId: org.templateId,
        assignedToId: org.users.INSPECTOR!.id,
      })
      .expect(200);

    for (const role of ['INSPECTOR', 'SUPERVISOR', 'ADMIN']) {
      const res = await get(`/uploads/attachments/${declared.body.data.id}/content`, role);
      expect(res.status, `${role} should be able to read it`).toBe(200);
    }
  });

  it('refuses new files once the request has been decided', async () => {
    const id = await raise();
    await post(`/inspection-requests/${id}/decide`, 'ADMIN')
      .send({ decision: 'REJECT', note: 'No.' })
      .expect(200);

    const { declared } = await attach(id, 'pdf');
    expect(declared.status).toBe(409);
  });

  it('refuses deletion once the request has been decided', async () => {
    const id = await raise();
    const { declared } = await attach(id, 'pdf');
    await post(`/inspection-requests/${id}/decide`, 'ADMIN')
      .send({
        decision: 'APPROVE',
        templateId: org.templateId,
      })
      .expect(200);

    const res = await del(`/inspection-requests/${id}/attachments/${declared.body.data.id}`);
    // By now it belongs to an inspection, and evidence is not the customer's
    // to remove.
    expect(res.status).toBe(409);
  });

  it('removes the file and its stored object while the request is open', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    await upload(declared.body.data.id, bytes);

    const stored = await prisma.attachment.findUniqueOrThrow({
      where: { id: declared.body.data.id },
    });

    expect(
      (await del(`/inspection-requests/${id}/attachments/${declared.body.data.id}`)).status,
    ).toBe(204);

    const after = await prisma.attachment.findUniqueOrThrow({
      where: { id: declared.body.data.id },
    });
    expect(after.deletedAt).not.toBeNull();

    // An unreferenced object is a bill with no purpose.
    const { storage } = await import('../uploads/storage.js');
    expect(await storage().exists(stored.storageKey!)).toBe(false);
  });

  it('404s against a request that no longer exists', async () => {
    const id = await raise();
    await prisma.inspectionRequest.update({ where: { id }, data: { deletedAt: new Date() } });

    const { declared } = await attach(id, 'pdf');
    expect(declared.status).toBe(404);
  });
});

describe('audit', () => {
  it('records the upload, the download and the deletion', async () => {
    const id = await raise();
    const { declared, bytes } = await attach(id, 'pdf');
    await upload(declared.body.data.id, bytes);
    await get(`/uploads/attachments/${declared.body.data.id}/content`);
    await del(`/inspection-requests/${id}/attachments/${declared.body.data.id}`);

    // The download is recorded on a best-effort path, so give it a moment.
    await new Promise((r) => setTimeout(r, 300));

    const actions = await prisma.auditLog.findMany({
      where: { orgId: org.orgId, entityId: declared.body.data.id },
      select: { action: true },
    });
    const seen = new Set(actions.map((a) => a.action));

    expect(seen.has('FILE_UPLOADED')).toBe(true);
    expect(seen.has('FILE_DOWNLOADED')).toBe(true);
    expect(seen.has('FILE_DELETED')).toBe(true);
  });
});
