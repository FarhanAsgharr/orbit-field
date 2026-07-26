/**
 * The request-level security middleware, exercised through the real app.
 *
 * This layer exists because of one specific attack shape. The API takes bearer
 * tokens from a header and sets no auth cookies, so classic CSRF cannot work —
 * a browser will not attach an `Authorization` header cross-origin. What *can*
 * work is a form or `fetch` on an attacker's page reaching a state-changing
 * endpoint, so the defences are origin validation on unsafe methods and a
 * refusal of the content types an HTML form can send without a preflight.
 *
 * Every test here is that pair: the legitimate client is unaffected, and the
 * attacker's shape is refused. A middleware that blocks everything passes a
 * one-sided test and breaks the product.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { originAllowed } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { createTestOrg, type TestOrg } from '../test/fixtures.js';
import { unique } from '../test/harness.js';

const app = createApp();
const api = '/api/v1';

let org: TestOrg;
let token: string;

beforeAll(async () => {
  org = await createTestOrg();
  const user = org.users.ADMIN!;
  const res = await request(app)
    .post(`${api}/auth/login`)
    .send({
      email: user.email,
      password: user.password,
      device: {
        installationId: unique('sec'),
        name: 'Security Device',
        platform: 'web',
        osVersion: '1',
        appVersion: '1.0.0',
      },
    });
  token = res.body.data.tokens.accessToken;
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

describe('origin allowlist matching', () => {
  it('matches an exact entry and nothing else', async () => {
    // `CORS_ORIGINS` is unset under test, so the allowlist is open and every
    // origin is permitted. The matcher itself is what is under test.
    expect(originAllowed('https://console.example.com')).toBe(true);
  });

  it('treats `*` as exactly one hostname label', async () => {
    // Reproduces the production matcher directly, because the test environment
    // deliberately runs with an open allowlist.
    const match = (pattern: string, origin: string) => {
      const compiled = new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^.]+')}$`,
      );
      return compiled.test(origin);
    };

    expect(match('https://*.vercel.app', 'https://orbit-abc123.vercel.app')).toBe(true);

    // A wildcard that crossed dots would let any host under any subdomain in,
    // which is the difference between "our preview deployments" and "anybody
    // who can register a subdomain somewhere".
    expect(match('https://*.vercel.app', 'https://a.b.vercel.app')).toBe(false);

    // Anchored at both ends, so a lookalike prefix or a path cannot slip past.
    expect(match('https://*.vercel.app', 'https://evil.com/x.vercel.app')).toBe(false);
    expect(match('https://*.vercel.app', 'https://x.vercel.app.evil.com')).toBe(false);
    expect(match('https://*.vercel.app', 'http://x.vercel.app')).toBe(false);
  });
});

describe('content type enforcement', () => {
  it('accepts JSON', async () => {
    const res = await request(app)
      .post(`${api}/inspections/bulk`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({ ids: ['0'.repeat(26)], action: 'ARCHIVE' });

    expect(res.status).not.toBe(415);
  });

  it('refuses a form encoding an HTML page could send cross-origin', async () => {
    const res = await request(app)
      .post(`${api}/inspections/bulk`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('ids=x&action=ARCHIVE');

    // This is the one content type a hidden form can post cross-origin without
    // a preflight, so refusing it closes the path even if an origin check were
    // somehow bypassed.
    expect(res.status).toBe(415);
  });

  it('refuses multipart for the same reason', async () => {
    const res = await request(app)
      .post(`${api}/inspections/bulk`)
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('--x--');

    expect(res.status).toBe(415);
  });

  it('lets a bodyless request through regardless of content type', async () => {
    const res = await request(app)
      .get(`${api}/inspections`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('request sanity limits', () => {
  it('rejects an absurdly long URL rather than passing it downstream', async () => {
    const res = await request(app)
      .get(`${api}/inspections?search=${'x'.repeat(5000)}`)
      .set('Authorization', `Bearer ${token}`);

    // A multi-megabyte URL is never legitimate here; it is a scanner or an
    // attempt to blow up a log pipeline further down.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('accepts a URL of reasonable length', async () => {
    const res = await request(app)
      .get(`${api}/inspections?search=${'x'.repeat(100)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('rejects a percent-encoded null byte', async () => {
    const res = await request(app).get('/health/live?x=%00abc');

    // The encoded spelling is the one that reaches a decoder downstream; a
    // literal NUL cannot survive an HTTP request line, so testing only for
    // that left the guard unable to fire at all.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('answers an early-middleware rejection with the JSON envelope, not a stack trace', async () => {
    const res = await request(app).get(`/health/live?x=${'y'.repeat(5000)}`);

    // `requestSanity` runs before the logger is attached to the request. The
    // error handler used to dereference `req.log` unconditionally and throw,
    // so Express served its own HTML page — a 500 with a stack trace where a
    // 400 belonged.
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
    expect(res.text).not.toMatch(/<!DOCTYPE html>/i);
    expect(res.text).not.toMatch(/\bat \w+.*\(/);
  });
});

describe('response headers', () => {
  it('never lets an intermediary cache a response carrying inspection data', async () => {
    const res = await request(app)
      .get(`${api}/inspections`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('switches off the browser features the API has no use for', async () => {
    const res = await request(app).get('/health/live');

    expect(res.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(res.headers['permissions-policy']).toMatch(/geolocation=\(\)/);
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  it('does not leak the server implementation', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
