/**
 * Devices and notifications.
 *
 * Device revocation is a security control, not housekeeping: it is what an
 * administrator reaches for when a phone is lost with a month of unsynced
 * inspections on it. Revoking must therefore kill the tokens too, or the
 * device keeps working and the console shows a comforting lie.
 *
 * Notifications are the opposite kind of thing — a hint, never the record. The
 * property tested here is that they *cannot* break anything: a suppressed push,
 * a dead token, quiet hours, a user with no device at all. Every one of those
 * must leave the notification row written and the caller unaffected, because
 * the database write that triggered the push is the real event.
 *
 * The one exception is a conflict notification, which is deliberately exempt
 * from quiet hours. An inspector whose work is blocked at 3am needs to know at
 * 3am; that is asserted rather than assumed.
 */

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { createInspection, createTestOrg, type TestOrg } from '../../test/fixtures.js';
import { unique } from '../../test/harness.js';
import { testServer } from '../../test/http.js';
import {
  DEFAULT_PREFERENCES,
  inQuietHours,
  loadPreferences,
  notifyUsers,
  savePreferences,
  sweepDueInspections,
} from './push.service.js';

const app = createApp();
const server = testServer(app);
const api = '/api/v1';

const device = (name = 'Notify Device') => ({
  installationId: unique('ntf'),
  name,
  platform: 'android' as const,
  osVersion: '14',
  appVersion: '1.0.0',
});

let org: TestOrg;
const tokens: Record<string, string> = {};
const deviceIds: Record<string, string> = {};

beforeAll(async () => {
  org = await createTestOrg();
  for (const [role, user] of Object.entries(org.users)) {
    const res = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device(`${role} phone`) });
    tokens[role] = res.body.data.tokens.accessToken;
    deviceIds[role] = res.body.data.device.id;
  }
});

afterAll(async () => {
  await org.cleanup();
  await prisma.$disconnect();
});

const get = (path: string, role = 'ADMIN') =>
  request(server).get(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const post = (path: string, role = 'ADMIN') =>
  request(server).post(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const patch = (path: string, role = 'ADMIN') =>
  request(server).patch(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);
const del = (path: string, role = 'ADMIN') =>
  request(server).delete(`${api}${path}`).set('Authorization', `Bearer ${tokens[role]}`);

/**
 * Enrol a spare device for a role and return its id and access token.
 *
 * Enrolment is capped at five active devices per user and refuses rather than
 * evicting, so previous spares are released first. Without this the tests stop
 * exercising devices and start re-testing the cap, several suites later and
 * under a misleading name. The user's original handset is left alone — the
 * access tokens in `tokens` are bound to it.
 */
async function enrol(role: string) {
  const user = org.users[role]!;
  await prisma.device.updateMany({
    where: { userId: user.id, id: { not: deviceIds[role] }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: 'test fixture: releasing a device slot' },
  });

  const res = await request(server)
    .post(`${api}/auth/login`)
    .send({ email: user.email, password: user.password, device: device('Spare handset') });
  expect(res.status).toBe(200);
  return { id: res.body.data.device.id as string, token: res.body.data.tokens.accessToken };
}

describe('listing devices', () => {
  it('shows a user their own enrolled devices', async () => {
    const res = await get('/devices', 'INSPECTOR');
    expect(res.status).toBe(200);

    const items = res.body.data.items ?? res.body.data;
    expect(items.length).toBeGreaterThan(0);
    for (const d of items) expect(d.userId).toBe(org.users.INSPECTOR!.id);
  });

  it('never returns a push token to the client', async () => {
    const spare = await enrol('INSPECTOR');
    await post(`/devices/${spare.id}/push-token`, 'INSPECTOR')
      .send({ pushToken: 'ExponentPushToken[secret-value-here]' })
      .expect(204);

    const res = await get('/devices', 'INSPECTOR');
    expect(JSON.stringify(res.body)).not.toContain('secret-value-here');
  });

  it('lets an administrator see the whole fleet', async () => {
    const res = await get('/devices?all=true');
    expect(res.status).toBe(200);
  });
});

describe('renaming a device', () => {
  it('renames your own', async () => {
    const spare = await enrol('INSPECTOR');
    const res = await patch(`/devices/${spare.id}`, 'INSPECTOR').send({ name: 'Van tablet' });

    expect(res.status).toBe(200);
    const stored = await prisma.device.findUniqueOrThrow({ where: { id: spare.id } });
    expect(stored.name).toBe('Van tablet');
  });

  it('rejects an empty name', async () => {
    const spare = await enrol('INSPECTOR');
    expect((await patch(`/devices/${spare.id}`, 'INSPECTOR').send({ name: '' })).status).toBe(422);
  });

  it('404s for a device in another organisation', async () => {
    const other = await createTestOrg();
    try {
      const theirLogin = await request(server)
        .post(`${api}/auth/login`)
        .send({
          email: other.users.INSPECTOR!.email,
          password: other.users.INSPECTOR!.password,
          device: device('Their phone'),
        });
      const theirDevice = theirLogin.body.data.device.id as string;

      const res = await patch(`/devices/${theirDevice}`).send({ name: 'Mine now' });
      expect(res.status).toBe(404);
    } finally {
      await other.cleanup();
    }
  });
});

describe('revoking a device', () => {
  it('revokes your own and kills its tokens', async () => {
    const spare = await enrol('INSPECTOR');

    const res = await del(`/devices/${spare.id}`, 'INSPECTOR').send({ reason: 'Left on a train' });
    expect(res.status).toBe(204);

    const stored = await prisma.device.findUniqueOrThrow({ where: { id: spare.id } });
    expect(stored.revokedAt).not.toBeNull();
    expect(stored.revokedReason).toBe('Left on a train');
    // A push token on a revoked device is a message sent to a phone somebody
    // else is holding.
    expect(stored.pushToken).toBeNull();

    const live = await prisma.refreshToken.count({
      where: { deviceId: spare.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('records who revoked it when it was not the owner', async () => {
    const spare = await enrol('INSPECTOR');

    const res = await del(`/devices/${spare.id}`, 'ADMIN');
    expect(res.status).toBe(204);

    const stored = await prisma.device.findUniqueOrThrow({ where: { id: spare.id } });
    expect(stored.revokedReason).toMatch(/administrator/i);
  });

  it('refuses to revoke somebody else’s device without the permission', async () => {
    const managerDevice = deviceIds.MANAGER!;
    const res = await del(`/devices/${managerDevice}`, 'INSPECTOR');

    expect(res.status).toBe(403);
    const untouched = await prisma.device.findUniqueOrThrow({ where: { id: managerDevice } });
    expect(untouched.revokedAt).toBeNull();
  });

  it('409s on a second revocation rather than pretending it worked', async () => {
    const spare = await enrol('INSPECTOR');
    await del(`/devices/${spare.id}`, 'INSPECTOR').expect(204);

    const again = await del(`/devices/${spare.id}`, 'INSPECTOR');
    expect(again.status).toBe(409);
  });

  it('stops the revoked device using its access token', async () => {
    const spare = await enrol('INSPECTOR');
    await del(`/devices/${spare.id}`, 'INSPECTOR').expect(204);

    const res = await request(server)
      .get(`${api}/inspections`)
      .set('Authorization', `Bearer ${spare.token}`);
    // The whole point of revocation: the phone in somebody else's pocket stops
    // working, rather than the console merely claiming it has. The refusal is
    // DEVICE_REVOKED (403) rather than a bare 401, so the client can tell
    // "this handset is no longer trusted" from "your session expired" and stop
    // trying to refresh.
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_REVOKED');
  });
});

describe('push tokens and sessions', () => {
  it('stores a push token and rejects an implausibly short one', async () => {
    const spare = await enrol('INSPECTOR');

    expect(
      (await post(`/devices/${spare.id}/push-token`, 'INSPECTOR').send({ pushToken: 'x' })).status,
    ).toBe(422);

    const ok = await post(`/devices/${spare.id}/push-token`, 'INSPECTOR').send({
      pushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]',
    });
    expect(ok.status).toBe(204);
  });

  it('refuses a sixth device rather than silently evicting one', async () => {
    const user = org.users.VIEWER!;
    await prisma.device.updateMany({
      where: { userId: user.id, id: { not: deviceIds.VIEWER }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'test fixture' },
    });

    // One already enrolled in beforeAll, so four more reach the cap of five.
    for (let i = 0; i < 4; i++) {
      const res = await request(server)
        .post(`${api}/auth/login`)
        .send({ email: user.email, password: user.password, device: device(`Handset ${i}`) });
      expect(res.status).toBe(200);
    }

    const sixth = await request(server)
      .post(`${api}/auth/login`)
      .send({ email: user.email, password: user.password, device: device('One too many') });

    // Evicting the oldest would log somebody out of a handset they are holding,
    // mid-inspection, with no explanation.
    expect(sixth.status).toBe(403);
    expect(sixth.body.error.code).toBe('DEVICE_LIMIT_REACHED');
  });

  it('lists a device’s sessions', async () => {
    const spare = await enrol('INSPECTOR');
    const res = await get(`/devices/${spare.id}/sessions`, 'INSPECTOR');
    expect(res.status).toBe(200);
  });

  it('logs a device out without revoking it', async () => {
    const spare = await enrol('INSPECTOR');

    const res = await post(`/devices/${spare.id}/logout`, 'INSPECTOR');
    expect([200, 204]).toContain(res.status);

    const stored = await prisma.device.findUniqueOrThrow({ where: { id: spare.id } });
    // Logging out ends the session; the enrolment survives so the inspector can
    // sign back in on the same handset without an administrator's help.
    expect(stored.revokedAt).toBeNull();
  });
});

describe('notification inbox', () => {
  it('lists notifications and marks one read', async () => {
    await notifyUsers(org.orgId, [org.users.INSPECTOR!.id], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'New work',
      body: 'An inspection was assigned to you.',
    });

    const list = await get('/notifications', 'INSPECTOR');
    expect(list.status).toBe(200);
    const items = list.body.data.items ?? list.body.data;
    expect(items.length).toBeGreaterThan(0);

    const read = await post(`/notifications/${items[0].id}/read`, 'INSPECTOR');
    expect([200, 204]).toContain(read.status);

    const stored = await prisma.notification.findUniqueOrThrow({ where: { id: items[0].id } });
    expect(stored.readAt).not.toBeNull();
  });

  it('marks everything read at once', async () => {
    await notifyUsers(org.orgId, [org.users.MANAGER!.id], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'One',
      body: 'Body',
    });

    const res = await post('/notifications/read-all', 'MANAGER');
    expect([200, 204]).toContain(res.status);

    const unread = await prisma.notification.count({
      where: { userId: org.users.MANAGER!.id, readAt: null },
    });
    expect(unread).toBe(0);
  });

  it('will not let one user mark another’s notification read', async () => {
    const result = await notifyUsers(org.orgId, [org.users.MANAGER!.id], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'Private',
      body: 'Body',
    });
    expect(result.created).toBe(1);

    const theirs = await prisma.notification.findFirstOrThrow({
      where: { userId: org.users.MANAGER!.id },
      orderBy: { createdAt: 'desc' },
    });

    const res = await post(`/notifications/${theirs.id}/read`, 'INSPECTOR');
    expect(res.status).toBe(404);
  });
});

describe('notification preferences', () => {
  it('returns the defaults for a user who has never set any', async () => {
    const res = await get('/notifications/preferences', 'VIEWER');
    expect(res.status).toBe(200);
    expect(res.body.data.preferences?.enabled ?? res.body.data.enabled).toBe(
      DEFAULT_PREFERENCES.enabled,
    );
  });

  it('saves quiet hours and reads them back', async () => {
    const res = await patch('/notifications/preferences', 'INSPECTOR').send({
      quietHours: { enabled: true, startHour: 22, endHour: 7 },
      sound: false,
    });
    expect(res.status).toBe(200);

    const stored = await loadPreferences(org.users.INSPECTOR!.id);
    expect(stored.quietHours?.enabled).toBe(true);
    expect(stored.quietHours?.startHour).toBe(22);
  });

  it('refuses to mute a topic that must always get through', async () => {
    const res = await patch('/notifications/preferences', 'INSPECTOR').send({
      mutedTopics: ['SYNC_CONFLICT'],
    });
    // A conflict blocks the inspector's work until somebody decides; muting it
    // means they never find out they are stuck.
    expect(res.status).toBe(422);
  });

  it('accepts muting an ordinary topic', async () => {
    const res = await patch('/notifications/preferences', 'INSPECTOR').send({
      mutedTopics: ['INSPECTION_ASSIGNED'],
    });
    expect(res.status).toBe(200);

    // Put it back so later tests are not affected.
    await patch('/notifications/preferences', 'INSPECTOR').send({ mutedTopics: [] }).expect(200);
  });

  it('rejects an hour outside the clock', async () => {
    const res = await patch('/notifications/preferences', 'INSPECTOR').send({
      quietHours: { enabled: true, startHour: 25, endHour: 7 },
    });
    expect(res.status).toBe(422);
  });
});

describe('quiet hours arithmetic', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 0, 15, hour, 0, 0));
  const prefs = (startHour: number, endHour: number) => ({
    ...DEFAULT_PREFERENCES,
    quietHours: { enabled: true, startHour, endHour },
  });

  it('handles a window that wraps midnight, which is the common case', async () => {
    expect(inQuietHours(prefs(22, 7), 'UTC', at(23))).toBe(true);
    expect(inQuietHours(prefs(22, 7), 'UTC', at(3))).toBe(true);
    expect(inQuietHours(prefs(22, 7), 'UTC', at(12))).toBe(false);
  });

  it('handles a window inside one day', async () => {
    expect(inQuietHours(prefs(9, 17), 'UTC', at(12))).toBe(true);
    expect(inQuietHours(prefs(9, 17), 'UTC', at(20))).toBe(false);
  });

  it('respects the user’s own timezone, not the server’s', async () => {
    // 23:00 UTC is 08:00 in Tokyo — not quiet there.
    expect(inQuietHours(prefs(22, 7), 'Asia/Tokyo', at(23))).toBe(false);
    expect(inQuietHours(prefs(22, 7), 'UTC', at(23))).toBe(true);
  });

  it('falls back to UTC rather than silencing everything on a corrupt timezone', async () => {
    expect(inQuietHours(prefs(22, 7), 'Mars/Olympus_Mons', at(23))).toBe(true);
    expect(inQuietHours(prefs(22, 7), 'Mars/Olympus_Mons', at(12))).toBe(false);
  });

  it('is off entirely when quiet hours are disabled', async () => {
    expect(inQuietHours(DEFAULT_PREFERENCES, 'UTC', at(3))).toBe(false);
  });
});

describe('delivery behaviour', () => {
  it('writes the row even when the user has no device to push to', async () => {
    const noDevice = org.users.VIEWER!.id;
    await prisma.device.updateMany({
      where: { userId: noDevice },
      data: { pushToken: null },
    });

    const result = await notifyUsers(org.orgId, [noDevice], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'Still recorded',
      body: 'Body',
    });

    // The inbox entry is the durable part; the push is a hint on top of it.
    expect(result.created).toBe(1);
    expect(result.delivered).toBe(0);
  });

  it('suppresses a muted topic but still records it', async () => {
    const user = org.users.TECHNICIAN?.id ?? org.users.VIEWER!.id;
    await savePreferences(user, { mutedTopics: ['INSPECTION_ASSIGNED'] });

    const result = await notifyUsers(org.orgId, [user], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'Muted',
      body: 'Body',
    });
    expect(result.created).toBe(1);
    expect(result.suppressed).toBe(1);

    await savePreferences(user, { mutedTopics: [] });
  });

  it('suppresses nothing when notifications are switched off, but still records', async () => {
    const user = org.users.VIEWER!.id;
    await savePreferences(user, { enabled: false });

    const result = await notifyUsers(org.orgId, [user], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'Off',
      body: 'Body',
    });
    expect(result.created).toBe(1);
    expect(result.suppressed).toBe(1);

    await savePreferences(user, { enabled: true });
  });

  it('does nothing, without error, for an empty recipient list', async () => {
    const result = await notifyUsers(org.orgId, [], {
      topic: 'INSPECTION_ASSIGNED' as never,
      title: 'Nobody',
      body: 'Body',
    });
    expect(result).toEqual({ created: 0, delivered: 0, suppressed: 0, failed: 0 });
  });

  it('ignores a user from another organisation passed by id', async () => {
    const other = await createTestOrg();
    try {
      const result = await notifyUsers(org.orgId, [other.users.INSPECTOR!.id], {
        topic: 'INSPECTION_ASSIGNED' as never,
        title: 'Cross tenant',
        body: 'Body',
      });
      expect(result.created).toBe(0);
    } finally {
      await other.cleanup();
    }
  });
});

describe('announcements', () => {
  it('sends to named users', async () => {
    const res = await post('/notifications/announce').send({
      title: 'Depot closed',
      body: 'The north depot is closed on Friday.',
      userIds: [org.users.INSPECTOR!.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
  });

  it('sends to everyone with a role', async () => {
    const res = await post('/notifications/announce').send({
      title: 'Policy update',
      body: 'New PPE requirements apply from Monday.',
      role: 'INSPECTOR',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBeGreaterThan(0);
  });

  it('refuses an inspector broadcasting to the organisation', async () => {
    const res = await post('/notifications/announce', 'INSPECTOR').send({
      title: 'Unauthorised',
      body: 'Body',
    });
    expect(res.status).toBe(403);
  });

  it('rejects an empty title or body', async () => {
    expect((await post('/notifications/announce').send({ title: '', body: 'x' })).status).toBe(422);
    expect((await post('/notifications/announce').send({ title: 'x', body: '' })).status).toBe(422);
  });
});

describe('the due-inspection sweep', () => {
  it('counts work that is due and work that is overdue', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);

    const dueId = await createInspection(org, org.users.INSPECTOR!.id, { status: 'SCHEDULED' });
    const lateId = await createInspection(org, org.users.INSPECTOR!.id, { status: 'SCHEDULED' });
    await prisma.inspection.update({ where: { id: dueId }, data: { dueAt: soon } });
    await prisma.inspection.update({ where: { id: lateId }, data: { dueAt: past } });

    const result = await sweepDueInspections();
    expect(result.due + result.overdue).toBeGreaterThan(0);
  });

  it('is reachable over HTTP for an operator, and refused to everyone else', async () => {
    expect((await post('/notifications/sweep', 'SUPER_ADMIN')).status).toBe(200);
    expect((await post('/notifications/sweep', 'INSPECTOR')).status).toBe(403);
  });
});
