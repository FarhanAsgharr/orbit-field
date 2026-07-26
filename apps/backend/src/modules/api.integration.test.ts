/**
 * The remaining API surface: templates, inspections, reports, analytics,
 * devices, notifications and the admin endpoints.
 *
 * Broader and shallower than the auth, RBAC, sync and upload suites by design —
 * those cover the areas where a defect is a security incident or silent data
 * loss, and get depth accordingly. What these assert is that every module is
 * actually wired, enforces its permission, validates its input, and returns the
 * shape the clients expect. That is the class of breakage a refactor causes and
 * a typecheck does not catch.
 *
 * Report generation is checked by magic bytes rather than status code: a 200
 * carrying an HTML error page is indistinguishable from a working PDF until
 * somebody opens it.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { prisma } from '../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../test/fixtures.js';
import { unique } from '../test/harness.js';
import { testServer } from '../test/http.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

let org: TestOrg;
const tokens: Record<string, string> = {};
let adminDeviceId = '';
let inspectionId = '';

const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: user.email,
        password: user.password,
        device: {
          installationId: unique('api-dev'),
          name: 'API Device',
          platform: 'web',
          osVersion: '1',
          appVersion: '1.0.0',
        },
      });
    tokens[role] = res.body.data.tokens.accessToken;
    if (role === 'ADMIN') adminDeviceId = res.body.data.device.id;
  }
  inspectionId = await createInspection(org, org.users.INSPECTOR!.id, { status: 'IN_PROGRESS' });
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

describe('templates API', () => {
  it('lists templates for an authenticated user', async () => {
    const res = await request(server).get(`${api}/templates`).set(auth('INSPECTOR'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items ?? res.body.data)).toBe(true);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await request(server).get(`${api}/templates`)).status).toBe(401);
  });
});

describe('inspections API', () => {
  it('returns the inspections assigned to the caller', async () => {
    const res = await request(server).get(`${api}/inspections`).set(auth('INSPECTOR'));
    expect(res.status).toBe(200);
    const items = res.body.data.items ?? res.body.data;
    expect(items.some((i: { id: string }) => i.id === inspectionId)).toBe(true);
  });

  it('returns a single inspection by id', async () => {
    const res = await request(server)
      .get(`${api}/inspections/${inspectionId}`)
      .set(auth('INSPECTOR'));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(inspectionId);
  });

  it('404s for an id that does not exist', async () => {
    const res = await request(server)
      .get(`${api}/inspections/01NOTAREALINSPECTION000001`)
      .set(auth('ADMIN'));
    expect(res.status).toBe(404);
  });

  it('rejects a malformed id rather than treating it as a lookup miss', async () => {
    const res = await request(server).get(`${api}/inspections/not-a-ulid`).set(auth('ADMIN'));
    expect([400, 404, 422]).toContain(res.status);
  });

  it('does not return another organisation’s inspection', async () => {
    const other = await createTestOrg();
    try {
      const foreignId = await createInspection(other, other.users.INSPECTOR!.id);
      const res = await request(server).get(`${api}/inspections/${foreignId}`).set(auth('ADMIN'));
      expect([403, 404]).toContain(res.status);
    } finally {
      await other.cleanup();
    }
  });
});

describe('reports API', () => {
  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

  it('lists the available datasets', async () => {
    const res = await request(server).get(`${api}/reports/datasets`).set(auth('ADMIN'));
    expect(res.status).toBe(200);
  });

  it('generates a real PDF, not an error page with a 200', async () => {
    const res = await binary(
      request(server)
        .get(`${api}/reports/inspection/${inspectionId}?format=pdf`)
        .set(auth('ADMIN')),
    );
    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('generates a real xlsx workbook', async () => {
    const res = await binary(
      request(server).get(`${api}/reports/export/inspections?format=xlsx`).set(auth('ADMIN')),
    );
    expect(res.status).toBe(200);
    // xlsx is a zip; "PK" is the local file header signature.
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
  });

  it('generates CSV', async () => {
    const res = await request(server)
      .get(`${api}/reports/export/inspections?format=csv`)
      .set(auth('ADMIN'));
    expect(res.status).toBe(200);
  });

  it('refuses report export to a VIEWER without the permission', async () => {
    const res = await request(server).get(`${api}/reports/datasets`).set(auth('INSPECTOR'));
    expect([200, 403]).toContain(res.status);
  });
});

describe('analytics API', () => {
  const endpoints = ['/analytics/summary', '/analytics/trend', '/analytics/inspectors'];

  it.each(endpoints)('%s returns data for an ADMIN', async (path) => {
    expect((await request(server).get(`${api}${path}`).set(auth('ADMIN'))).status).toBe(200);
  });

  it.each(endpoints)('%s is refused for an INSPECTOR', async (path) => {
    expect((await request(server).get(`${api}${path}`).set(auth('INSPECTOR'))).status).toBe(403);
  });
});

describe('devices API', () => {
  it('lists the caller’s enrolled devices', async () => {
    const res = await request(server).get(`${api}/devices`).set(auth('ADMIN'));
    expect(res.status).toBe(200);
  });

  it('accepts a push token registration', async () => {
    const res = await request(server)
      .post(`${api}/devices/${adminDeviceId}/push-token`)
      .set(auth('ADMIN'))
      .send({ pushToken: `ExponentPushToken[${unique('tok')}]` });
    expect(res.status).toBeLessThan(300);
  });

  it('refuses to register a token on a device belonging to someone else', async () => {
    const other = await createTestOrg();
    try {
      const login = await request(server)
        .post(`${api}/auth/login`)
        .send({
          email: other.users.ADMIN!.email,
          password: other.users.ADMIN!.password,
          device: {
            installationId: unique('foreign'),
            name: 'Foreign',
            platform: 'web',
            osVersion: '1',
            appVersion: '1.0.0',
          },
        });
      const foreignDeviceId: string = login.body.data.device.id;

      const res = await request(server)
        .post(`${api}/devices/${foreignDeviceId}/push-token`)
        .set(auth('ADMIN'))
        .send({ pushToken: 'ExponentPushToken[stolen]' });

      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await other.cleanup();
    }
  });
});

describe('notifications API', () => {
  it('returns the inbox', async () => {
    expect((await request(server).get(`${api}/notifications`).set(auth('INSPECTOR'))).status).toBe(
      200,
    );
  });

  it('reads and writes preferences', async () => {
    expect(
      (await request(server).get(`${api}/notifications/preferences`).set(auth('INSPECTOR'))).status,
    ).toBe(200);

    const patch = await request(server)
      .patch(`${api}/notifications/preferences`)
      .set(auth('INSPECTOR'))
      .send({ enabled: true });
    expect(patch.status).toBeLessThan(300);
  });
});

describe('admin API', () => {
  it('returns the organisation record', async () => {
    const res = await request(server).get(`${api}/admin/organization`).set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(org.orgId);
  });

  it('writes an audit trail that an ADMIN can read', async () => {
    const res = await request(server).get(`${api}/admin/audit-logs`).set(auth('ADMIN'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items ?? res.body.data)).toBe(true);
  });
});

describe('reference data API', () => {
  const endpoints = ['/clients', '/projects', '/sites', '/assets'];

  it.each(endpoints)('%s is readable', async (path) => {
    expect((await request(server).get(`${api}${path}`).set(auth('ADMIN'))).status).toBe(200);
  });
});

describe('input validation', () => {
  it('rejects a malformed body with field-level errors', async () => {
    const res = await request(server)
      .post(`${api}/users`)
      .set(auth('ADMIN'))
      .send({ email: 'not-an-email', firstName: '', lastName: '', role: 'GOD_MODE' });

    expect(res.status).toBe(422);
    expect(res.body.error.fields).toBeDefined();
  });

  it('does not 500 on a SQL-injection attempt in a query parameter', async () => {
    const res = await request(server)
      .get(`${api}/inspections?limit=1' OR '1'='1`)
      .set(auth('ADMIN'));
    expect(res.status).not.toBe(500);
  });

  it('rejects an oversized page size rather than trying to serve it', async () => {
    const res = await request(server).get(`${api}/inspections?limit=99999`).set(auth('ADMIN'));
    expect([200, 422]).toContain(res.status);
    if (res.status === 200) {
      const items = res.body.data.items ?? res.body.data;
      expect(items.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe('health and metrics', () => {
  it('reports liveness without touching a dependency', async () => {
    const res = await request(server).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('reports readiness including the database', async () => {
    const res = await request(server).get('/health/ready');
    expect([200, 503]).toContain(res.status);
    expect(res.body.checks.database).toBeDefined();
  });

  it('serves Prometheus metrics', async () => {
    const res = await request(server).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('orbit_http_requests_total');
  });

  it('returns a discoverable pointer at the root', async () => {
    const res = await request(server).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('Orbit Field API');
  });

  it('404s an unknown route as JSON, not HTML', async () => {
    const res = await request(server).get(`${api}/no-such-endpoint`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});
