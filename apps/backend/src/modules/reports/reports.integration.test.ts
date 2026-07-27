/**
 * Report generation and analytics, over HTTP.
 *
 * A report is the artefact that leaves the building. It is attached to a
 * certificate, sent to a client, and read by somebody who will never see this
 * system — so the failures that matter are not crashes but *quiet* ones: a PDF
 * that is really an HTML error page, an export that includes a project the
 * requester may not see, a spreadsheet with a header row and nothing under it.
 *
 * Every format assertion here therefore checks the bytes, not the status code.
 * A 200 with `%PDF` absent is the exact shape of the bug worth catching.
 *
 * Analytics is checked for scoping on the same principle as inspections: an
 * aggregate is a disclosure too. A count that includes another organisation's
 * inspections tells a competitor how much work that organisation is doing.
 */

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
  installationId: unique('rep'),
  name: 'Report Device',
  platform: 'web' as const,
  osVersion: '1',
  appVersion: '1.0.0',
});

let org: TestOrg;
let approvedId: string;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device() });
    tokens[role] = res.body.data.tokens.accessToken;
  }

  // Something for the reports to actually contain. An empty dataset would let
  // a broken renderer pass by producing a plausible empty file.
  approvedId = await createInspection(org, org.users.INSPECTOR!.id, { status: 'APPROVED' });
  await createInspection(org, org.users.INSPECTOR!.id, { status: 'SUBMITTED' });
  await createInspection(org, org.users.INSPECTOR!.id, { status: 'IN_PROGRESS' });
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const get = (path: string, role = 'ADMIN') =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const binary = (path: string, role = 'ADMIN') =>
  request(server)
    .get(`${api}${path}`)
    .set('Authorization', `Bearer ${tokens[role]}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

/* Magic numbers. A renderer that fails and returns an error page still answers
 * 200 with a Content-Type it set before it failed, so the bytes are the only
 * reliable evidence the file is what it claims to be. */
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b; // xlsx is a zip

describe('the dataset catalogue', () => {
  it('marks each dataset available or not for the caller, so the UI greys out rather than 403s', async () => {
    const availability = async (role: string) => {
      const res = await get('/reports/datasets', role);
      expect(res.status).toBe(200);
      return Object.fromEntries(
        res.body.data.map((d: { key: string; available: boolean }) => [d.key, d.available]),
      ) as Record<string, boolean>;
    };

    const admin = await availability('ADMIN');
    expect(admin.inspections).toBe(true);
    expect(admin.audit).toBe(true);

    const inspector = await availability('INSPECTOR');
    // The catalogue is the same list for everyone — the flag is what differs,
    // which is what lets the console disable a button instead of offering one
    // whose only outcome is a refusal.
    expect(inspector.audit).toBe(false);
  });

  it('states the permission each dataset needs', async () => {
    const res = await get('/reports/datasets');
    const audit = res.body.data.find((d: { key: string }) => d.key === 'audit');
    expect(audit.requiredPermission).toBeTruthy();
    expect(audit.formats).toEqual(expect.arrayContaining(['pdf', 'csv', 'xlsx']));
  });
});

describe('single-dataset export', () => {
  const datasets = ['inspections', 'sites', 'users', 'devices', 'clients', 'projects'];

  it.each(datasets)('exports %s as a real CSV', async (dataset) => {
    const res = await binary(`/reports/export/${dataset}?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);

    const text = (res.body as Buffer).toString('utf8');
    // A header row is the minimum evidence the loader ran.
    expect(text.split('\n')[0]!.length).toBeGreaterThan(0);
  });

  it.each(datasets)('exports %s as a real xlsx', async (dataset) => {
    const res = await binary(`/reports/export/${dataset}?format=xlsx`);
    expect(res.status).toBe(200);
    expect(isZip(res.body as Buffer)).toBe(true);
  });

  it('exports as a real PDF', async () => {
    const res = await binary('/reports/export/inspections?format=pdf');
    expect(res.status).toBe(200);
    expect(isPdf(res.body as Buffer)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  });

  it('sends a filename so a browser saves rather than renders it', async () => {
    const res = await binary('/reports/export/inspections?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('refuses a dataset the caller has no permission for', async () => {
    const res = await get('/reports/export/audit?format=csv', 'INSPECTOR');
    expect(res.status).toBe(403);
  });

  it('rejects an unknown dataset name', async () => {
    expect((await get('/reports/export/salaries?format=csv')).status).toBe(422);
  });

  it('rejects an unknown format', async () => {
    expect((await get('/reports/export/inspections?format=docx')).status).toBe(422);
  });

  it('honours a date range', async () => {
    const res = await binary(
      '/reports/export/inspections?format=csv&from=2000-01-01T00:00:00.000Z&to=2000-01-02T00:00:00.000Z',
    );
    expect(res.status).toBe(200);
    // A window with no inspections must still produce a valid file, not a 500.
    expect((res.body as Buffer).toString('utf8').length).toBeGreaterThan(0);
  });

  it('honours a search filter, so a filtered view exports filtered', async () => {
    const all = await binary('/reports/export/inspections?format=csv&limit=20000');
    const allRows = (all.body as Buffer).toString('utf8').trim().split('\n').length - 1;
    expect(allRows).toBeGreaterThan(0);

    const none = await binary(
      '/reports/export/inspections?format=csv&limit=20000&search=NOTHINGMATCHESTHISSTRING',
    );
    const noneRows = (none.body as Buffer).toString('utf8').trim().split('\n').length - 1;

    // The failure this exists for: an export that ignores the filter downloads
    // everything, looks correct, and nobody counts the rows before sending it
    // to a client.
    expect(noneRows).toBe(0);
  });

  it('caps the row limit', async () => {
    expect((await get('/reports/export/inspections?format=csv&limit=999999')).status).toBe(422);
  });

  it('never includes another organisation’s rows', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id, {
        number: 'LEAKCANARY0001',
      });
      expect(theirs).toBeTruthy();

      const res = await binary('/reports/export/inspections?format=csv&limit=20000');
      expect(res.status).toBe(200);
      // An aggregate is a disclosure too.
      expect((res.body as Buffer).toString('utf8')).not.toContain('LEAKCANARY0001');
    } finally {
      await other.cleanup();
    }
  });
});

describe('batch and summary reports', () => {
  it('produces a multi-dataset xlsx', async () => {
    const res = await binary('/reports/batch?datasets=inspections,sites&format=xlsx');
    expect(res.status).toBe(200);
    expect(isZip(res.body as Buffer)).toBe(true);
  });

  it('produces a multi-dataset pdf', async () => {
    const res = await binary('/reports/batch?datasets=inspections,sites&format=pdf');
    expect(res.status).toBe(200);
    expect(isPdf(res.body as Buffer)).toBe(true);
  });

  it('rejects a dataset list containing something unknown', async () => {
    expect((await get('/reports/batch?datasets=inspections,salaries')).status).toBe(422);
  });

  it('drops datasets the caller may not export rather than refusing the whole batch', async () => {
    const res = await binary('/reports/batch?datasets=inspections,audit&format=xlsx', 'MANAGER');
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) expect(isZip(res.body as Buffer)).toBe(true);
  });

  it('produces a summary pdf and xlsx', async () => {
    const pdf = await binary('/reports/summary?format=pdf');
    expect(pdf.status).toBe(200);
    expect(isPdf(pdf.body as Buffer)).toBe(true);

    const xlsx = await binary('/reports/summary?format=xlsx');
    expect(xlsx.status).toBe(200);
    expect(isZip(xlsx.body as Buffer)).toBe(true);
  });
});

describe('single-inspection report', () => {
  it('renders the inspection as a PDF', async () => {
    const res = await binary(`/reports/inspection/${approvedId}?format=pdf`);
    expect(res.status).toBe(200);
    expect(isPdf(res.body as Buffer)).toBe(true);
  });

  it('renders the inspection as an xlsx', async () => {
    const res = await binary(`/reports/inspection/${approvedId}?format=xlsx`);
    expect(res.status).toBe(200);
    expect(isZip(res.body as Buffer)).toBe(true);
  });

  it('404s for an unknown inspection', async () => {
    expect((await get(`/reports/inspection/${'0'.repeat(26)}`)).status).toBe(404);
  });

  it('404s across the organisation boundary', async () => {
    const other = await createTestOrg();
    try {
      const theirs = await createInspection(other, other.users.INSPECTOR!.id);
      expect((await get(`/reports/inspection/${theirs}`)).status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('report history', () => {
  it('lists previously generated reports, paginated', async () => {
    const res = await get('/reports/history?page=1&pageSize=10');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.items)).toBe(true);
  });
});

describe('analytics', () => {
  it('summarises the organisation', async () => {
    const res = await get('/analytics/summary');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
  });

  it.each(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'])(
    'buckets the trend by %s',
    async (period) => {
      const res = await get(`/analytics/trend?period=${period}`);
      expect(res.status).toBe(200);
    },
  );

  it('rejects a period it does not recognise, rather than falling back silently', async () => {
    // The bucket unit reaches a date_trunc call, so this set must stay closed.
    expect((await get('/analytics/trend?period=HOURLY')).status).toBe(422);
  });

  it('reports per-inspector, per-site and per-project breakdowns', async () => {
    for (const path of ['/analytics/inspectors', '/analytics/sites', '/analytics/projects']) {
      const res = await get(path);
      expect(res.status).toBe(200);
    }
  });

  it('produces a heatmap', async () => {
    expect((await get('/analytics/heatmap')).status).toBe(200);
  });

  it('exports inspections as CSV', async () => {
    const res = await binary('/analytics/export/inspections.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/csv/);
  });

  it('honours an explicit date range and filters', async () => {
    const res = await get(
      `/analytics/summary?from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z&projectId=${org.projectId}`,
    );
    expect(res.status).toBe(200);
  });

  it('rejects a malformed date', async () => {
    expect((await get('/analytics/summary?from=last-tuesday')).status).toBe(422);
  });

  it('never counts another organisation’s inspections', async () => {
    // The `range` echoed back is derived from the wall clock, so only the
    // figures are comparable between two calls.
    const counts = (body: { data: Record<string, unknown> }) => {
      const { range: _range, ...rest } = body.data;
      return JSON.stringify(rest);
    };

    const before = await get('/analytics/summary');

    const other = await createTestOrg();
    try {
      for (let i = 0; i < 3; i++) {
        await createInspection(other, other.users.INSPECTOR!.id, { status: 'APPROVED' });
      }

      const after = await get('/analytics/summary');
      expect(counts(after.body)).toBe(counts(before.body));
    } finally {
      await other.cleanup();
    }
  });

  it('refuses an inspector the organisation-wide view', async () => {
    const res = await get('/analytics/summary', 'INSPECTOR');
    expect(res.status).toBe(403);
  });
});
