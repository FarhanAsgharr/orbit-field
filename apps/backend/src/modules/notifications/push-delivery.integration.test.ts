/**
 * Push delivery: what happens when the push service answers badly.
 *
 * `notifications.integration.test.ts` covers preferences, suppression and the
 * inbox. This covers the network edge, which is the part that decides whether
 * a delivery problem stays a delivery problem.
 *
 * The rule is that **a failed push must never affect the database write that
 * triggered it**. Assigning an inspection is the real event; the notification
 * is how somebody finds out early. If Expo is down, or rate limiting, or
 * returning nonsense, the assignment must still stand and the inbox row must
 * still exist — otherwise a third-party outage silently becomes a data loss in
 * our system.
 *
 * The one thing a bad response *should* change is a permanently dead token.
 * `DeviceNotRegistered` means the app was uninstalled or the token rotated, and
 * retrying it forever burns quota until the whole project is throttled — which
 * would stop notifications for every user, not just the one who uninstalled.
 *
 * `fetch` is stubbed rather than reached, so these run offline and
 * deterministically. Everything else — database, preferences, devices — is real.
 */

import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';
import { notifyUsers } from './push.service.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

let org: TestOrg;
let recipientId: string;
let deviceId: string;

const PUSH_TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

beforeAll(async () => {
  org = await createTestOrg();
  const user = org.users.INSPECTOR!;
  recipientId = user.id;

  const login = await request(server)
    .post(`${api}/auth/login`)
    .send({
      email: user.email,
      password: user.password,
      device: {
        installationId: unique('push'),
        name: 'Push Device',
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
      },
    });
  expect(login.status).toBe(200);
  deviceId = login.body.data.device.id;
  await prisma.device.update({ where: { id: deviceId }, data: { pushToken: PUSH_TOKEN } });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // Restore the token so each case starts from a deliverable device.
  await prisma.device.update({ where: { id: deviceId }, data: { pushToken: PUSH_TOKEN } });
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

/** Replace `fetch` with a canned Expo response and record what was sent. */
function stubExpo(responder: () => { ok: boolean; status?: number; body?: unknown }) {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(init.body as string) as unknown,
      headers: init.headers as Record<string, string>,
    });
    const { ok, status = ok ? 200 : 500, body = {} } = responder();
    return {
      ok,
      status,
      json: async () => body,
    } as Response;
  });

  return calls;
}

const message = (title = 'New work') => ({
  topic: 'INSPECTION_ASSIGNED' as never,
  title,
  body: 'An inspection was assigned to you.',
});

describe('a successful delivery', () => {
  it('counts as delivered and posts the message to the push service', async () => {
    const calls = stubExpo(() => ({
      ok: true,
      body: { data: [{ status: 'ok', id: 'ticket-1' }] },
    }));

    const result = await notifyUsers(org.orgId, [recipientId], message());

    expect(result.created).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    expect(calls).toHaveLength(1);
    const sent = (calls[0]!.body as Array<{ to: string; title: string }>)[0]!;
    expect(sent.to).toBe(PUSH_TOKEN);
    expect(sent.title).toBe('New work');
  });

  it('sends one request for several recipients rather than one each', async () => {
    const second = org.users.MANAGER!.id;
    const login = await request(server)
      .post(`${api}/auth/login`)
      .send({
        email: org.users.MANAGER!.email,
        password: org.users.MANAGER!.password,
        device: {
          installationId: unique('push2'),
          name: 'Second Device',
          platform: 'android',
          osVersion: '14',
          appVersion: '1.0.0',
        },
      });
    await prisma.device.update({
      where: { id: login.body.data.device.id },
      data: { pushToken: 'ExponentPushToken[yyyyyyyyyyyyyyyyyyyyyy]' },
    });

    const calls = stubExpo(() => ({
      ok: true,
      body: { data: [{ status: 'ok' }, { status: 'ok' }] },
    }));

    const result = await notifyUsers(org.orgId, [recipientId, second], message());

    expect(result.created).toBe(2);
    // Batching is what keeps the project inside Expo's rate limits.
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as unknown[]).length).toBe(2);
  });
});

describe('when the push service misbehaves', () => {
  it('records the notification anyway when the service returns an error status', async () => {
    stubExpo(() => ({ ok: false, status: 503 }));

    const before = await prisma.notification.count({ where: { userId: recipientId } });
    const result = await notifyUsers(org.orgId, [recipientId], message('Service down'));

    // The inbox row is the durable part. A third-party outage must not become
    // a lost notification in our database.
    expect(result.created).toBe(1);
    expect(result.delivered).toBe(0);
    expect(await prisma.notification.count({ where: { userId: recipientId } })).toBe(before + 1);
  });

  it('does not throw when the network call fails outright', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(notifyUsers(org.orgId, [recipientId], message('Offline'))).resolves.toMatchObject({
      created: 1,
    });
  });

  it('does not throw when the service returns a body it did not promise', async () => {
    stubExpo(() => ({ ok: true, body: { unexpected: true } }));

    const result = await notifyUsers(org.orgId, [recipientId], message('Weird'));
    expect(result.created).toBe(1);
  });

  it('survives the service timing out', async () => {
    vi.stubGlobal('fetch', async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    await expect(notifyUsers(org.orgId, [recipientId], message('Slow'))).resolves.toMatchObject({
      created: 1,
    });
  });
});

describe('dead tokens', () => {
  it('clears a token the service says is permanently gone', async () => {
    stubExpo(() => ({
      ok: true,
      body: {
        data: [
          {
            status: 'error',
            message: 'The recipient device is not registered.',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      },
    }));

    await notifyUsers(org.orgId, [recipientId], message('Uninstalled'));

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    // Retrying a dead token forever burns quota until the whole project is
    // throttled — which would stop notifications for everybody, not just the
    // person who uninstalled the app.
    expect(device.pushToken).toBeNull();
  });

  it('keeps a token after a transient error', async () => {
    stubExpo(() => ({
      ok: true,
      body: {
        data: [
          {
            status: 'error',
            message: 'Rate limit exceeded',
            details: { error: 'MessageRateExceeded' },
          },
        ],
      },
    }));

    await notifyUsers(org.orgId, [recipientId], message('Throttled'));

    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    // Discarding a token because the service was briefly busy would silently
    // stop that handset receiving anything again.
    expect(device.pushToken).toBe(PUSH_TOKEN);
  });

  it('does not attempt delivery to a revoked device', async () => {
    await prisma.device.update({
      where: { id: deviceId },
      data: { revokedAt: new Date(), revokedReason: 'test' },
    });

    const calls = stubExpo(() => ({ ok: true, body: { data: [] } }));
    const result = await notifyUsers(org.orgId, [recipientId], message('Revoked'));

    expect(result.created).toBe(1);
    // A push to a revoked handset is a message delivered to a phone somebody
    // else is now holding.
    expect(calls).toHaveLength(0);

    await prisma.device.update({
      where: { id: deviceId },
      data: { revokedAt: null, revokedReason: null },
    });
  });
});
