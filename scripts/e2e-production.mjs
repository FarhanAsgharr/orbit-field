/**
 * End-to-end verification against a live deployment.
 *
 * The older `e2e-*.mjs` scripts cannot do this. They are pinned to seeded
 * identifiers (`01JSEEDTPL...`) and to `inspector@northwind.test`, which exist
 * only in a development database — run them at production and every one fails
 * on the first login. That made them useless for the thing you most want to
 * check: whether the deployment you just shipped actually works.
 *
 * This script creates everything it needs at run time, verifies the full
 * inspector and administrator journeys, and deletes what it made. Nothing is
 * hardcoded: no ids, no emails, no passwords.
 *
 * It needs one existing administrator to bootstrap from, because a hardened
 * install has self-service signup disabled by design — there is no way to
 * create the first account over HTTP, and there should not be.
 *
 *   ORBIT_API_URL=https://orbit-field-api.vercel.app/api/v1 \
 *   ORBIT_ADMIN_EMAIL=admin@example.com \
 *   ORBIT_ADMIN_PASSWORD=... \
 *   node scripts/e2e-production.mjs
 *
 * Everything it creates is prefixed `e2e-` and removed in a `finally` block, so
 * a failure part-way through still cleans up.
 */

import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.ORBIT_API_URL ?? process.argv[2];
const ADMIN_EMAIL = process.env.ORBIT_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ORBIT_ADMIN_PASSWORD;

if (!BASE || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error(
    'Missing configuration. Required:\n' +
      '  ORBIT_API_URL       e.g. https://orbit-field-api.vercel.app/api/v1\n' +
      '  ORBIT_ADMIN_EMAIL   an existing administrator\n' +
      '  ORBIT_ADMIN_PASSWORD',
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** Unique per run, so concurrent runs against the same deployment cannot collide. */
const RUN = randomBytes(5).toString('hex');
const unique = (prefix) => `e2e-${prefix}-${RUN}-${randomBytes(3).toString('hex')}`;
/**
 * Meets the production policy without containing any name or email fragment.
 *
 * The prefix deliberately avoids "e2e": the policy refuses a password that
 * contains the user's own first or last name, and the accounts created here are
 * named after this harness.
 */
const password = () => `Zq${randomBytes(9).toString('hex')}A1`;

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.raw ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.raw) {
    return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
}

const device = (name) => ({
  installationId: unique('install'),
  name,
  platform: 'android',
  osVersion: '14',
  appVersion: '1.0.0',
});

async function login(email, pw, deviceName) {
  const res = await api('/auth/login', {
    method: 'POST',
    body: { email, password: pw, device: device(deviceName) },
  });
  if (res.status !== 200) {
    throw new Error(
      `login ${email} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`,
    );
  }
  return {
    token: res.body.data.tokens.accessToken,
    refreshToken: res.body.data.tokens.refreshToken,
    deviceId: res.body.data.device.id,
    userId: res.body.data.user.id,
    orgId: res.body.data.organization.id,
  };
}

/* Crockford base32 ULID, matching the mobile client. */
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let counter = 0;
function ulid() {
  const now = Date.now();
  if (now === lastTime) counter += 1;
  else {
    lastTime = now;
    counter = 0;
  }
  let time = '';
  let t = now;
  for (let i = 9; i >= 0; i--) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENC[Math.floor(Math.random() * 32)];
  return (time + rand).slice(0, 25) + ENC[counter % 32];
}

let lamport = 0;
const operation = (client, entity, op, entityId, patch, baseVersion = null) => {
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
};

const push = (client, operations) =>
  api('/sync/push', {
    method: 'POST',
    token: client.token,
    body: { protocolVersion: 1, deviceId: client.deviceId, cursor: 0, operations },
  });

const pull = (client, since = 0, limit = 500) =>
  api(`/sync/pull?protocolVersion=1&since=${since}&limit=${limit}`, { token: client.token });

async function main() {
  console.log('\x1b[1mOrbit Field — production end-to-end verification\x1b[0m');
  console.log(`Target: ${BASE}`);
  console.log(`Run id: ${RUN}\n`);

  const created = { userEmails: [], inspectionIds: [] };
  let admin;

  try {
    section('1. Administrator bootstrap');
    admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD, 'E2E Admin');
    check('administrator signs in', Boolean(admin.token));

    section('2. Deployment health');
    const origin = BASE.replace(/\/api\/v1$/, '');
    const health = await fetch(`${origin}/health`).then((r) => r.json());
    check('/health reports ok', health.status === 'ok', JSON.stringify(health));
    const signup = await api('/auth/signup-available');
    check(
      'self-service signup is disabled on this deployment',
      signup.body?.data?.available === false,
      `available=${signup.body?.data?.available}`,
    );

    section('3. Provision a temporary inspector');
    const inspectorEmail = `${unique('inspector')}@e2e.invalid`;
    const inspectorPassword = password();
    const createUser = await api('/users', {
      method: 'POST',
      token: admin.token,
      body: {
        email: inspectorEmail,
        firstName: 'Verification',
        lastName: 'Account',
        role: 'INSPECTOR',
        password: inspectorPassword,
      },
    });
    if (
      !check(
        'inspector created',
        createUser.status === 201,
        JSON.stringify(createUser.body).slice(0, 200),
      )
    ) {
      throw new Error('cannot continue without a test inspector');
    }
    created.userEmails.push(inspectorEmail);
    check(
      'created active, not stranded awaiting an email',
      createUser.body.data.status === 'ACTIVE',
    );
    check('no password hash in the response', !JSON.stringify(createUser.body).includes('argon2'));

    section('4. Inspector authentication');
    const alpha = await login(inspectorEmail, inspectorPassword, 'E2E Phone A');
    const bravo = await login(inspectorEmail, inspectorPassword, 'E2E Phone B');
    check('inspector signs in', Boolean(alpha.token));
    check('two installations enrol as distinct devices', alpha.deviceId !== bravo.deviceId);
    const wrong = await api('/auth/login', {
      method: 'POST',
      body: { email: inspectorEmail, password: password(), device: device('E2E Bad') },
    });
    check('wrong password refused', wrong.status === 401, `${wrong.status}`);

    section('5. Offline bootstrap');
    const boot = await pull(alpha, 0);
    check('delta pull succeeds', boot.status === 200);
    check('cursor is a JSON number', typeof boot.body?.cursor === 'number');
    const templateVersion = (boot.body?.changes ?? []).find((c) => c.entity === 'TEMPLATE_VERSION');
    check('a published template reaches the device', Boolean(templateVersion));
    check(
      'template carries its definition and name',
      Boolean(templateVersion?.data?.definition) && Boolean(templateVersion?.data?.name),
    );
    const project = (boot.body?.changes ?? []).find((c) => c.entity === 'PROJECT');
    const site = (boot.body?.changes ?? []).find((c) => c.entity === 'SITE');

    if (!templateVersion || !project) {
      throw new Error(
        'The bootstrapping organisation has no published template or project, so the ' +
          'inspector journey cannot be exercised. Provision reference data first.',
      );
    }

    section('6. Offline creation and replay');
    const inspectionId = ulid();
    const createOp = operation(alpha, 'INSPECTION', 'CREATE', inspectionId, {
      templateId: templateVersion.data.templateId,
      templateVersionId: templateVersion.entityId,
      projectId: project.entityId,
      siteId: site?.entityId ?? null,
      assignedToId: alpha.userId,
      title: `${unique('inspection')} — created offline`,
      status: 'IN_PROGRESS',
      priority: 'NORMAL',
    });
    const createRes = await push(alpha, [createOp]);
    check(
      'device-created inspection accepted',
      createRes.body?.results?.[0]?.status === 'APPLIED',
      JSON.stringify(createRes.body?.results?.[0]).slice(0, 200),
    );
    check(
      'server honoured the device-minted id',
      createRes.body?.results?.[0]?.entityId === inspectionId,
    );
    created.inspectionIds.push(inspectionId);

    const replay = await push(alpha, [createOp]);
    check(
      'replayed operation reported DUPLICATE',
      replay.body?.results?.[0]?.status === 'DUPLICATE',
    );

    section('7. Three-way merge and conflict');
    await push(alpha, [
      operation(alpha, 'INSPECTION', 'UPDATE', inspectionId, { notes: 'Alpha note' }, 1),
    ]);
    const disjoint = await push(bravo, [
      operation(bravo, 'INSPECTION', 'UPDATE', inspectionId, { priority: 'CRITICAL' }, 1),
    ]);
    check(
      'stale-but-disjoint edit auto-merged',
      disjoint.body?.results?.[0]?.status === 'APPLIED',
      disjoint.body?.results?.[0]?.status,
    );

    const current = await api(`/inspections/${inspectionId}`, { token: alpha.token });
    const version = current.body?.data?.version;
    await push(alpha, [
      operation(alpha, 'INSPECTION', 'UPDATE', inspectionId, { title: 'Alpha title' }, version),
    ]);
    const clashOp = operation(
      bravo,
      'INSPECTION',
      'UPDATE',
      inspectionId,
      { title: 'Bravo title' },
      version,
    );
    const clash = await push(bravo, [clashOp]);
    const conflict = clash.body?.results?.[0];
    check('clashing edit reported CONFLICT', conflict?.status === 'CONFLICT', conflict?.status);
    check('conflict carries a three-way diff', Array.isArray(conflict?.conflict?.diffs));
    const titleDiff = (conflict?.conflict?.diffs ?? []).find((d) => d.path === 'title');
    check('the clashing field is flagged', titleDiff?.isConflicting === true);
    check(
      'diff carries both sides',
      titleDiff?.localValue === 'Bravo title' && titleDiff?.serverValue === 'Alpha title',
    );

    const resolve = await api('/sync/conflicts/resolve', {
      method: 'POST',
      token: bravo.token,
      body: { operationId: clashOp.id, strategy: 'MERGE', fieldChoices: { title: 'LOCAL' } },
    });
    check(
      'conflict resolves to the chosen value',
      resolve.body?.data?.merged?.title === 'Bravo title',
      `${resolve.status}`,
    );

    section('8. Attachment upload');
    const payload = Buffer.from(
      Array.from({ length: 200 * 1024 }, (_, i) => (i + Date.now()) % 251),
    );
    const checksum = createHash('sha256').update(payload).digest('hex');
    const attachmentId = ulid();
    await push(alpha, [
      operation(alpha, 'ATTACHMENT', 'CREATE', attachmentId, {
        inspectionId,
        kind: 'PHOTO',
        fileName: 'e2e-evidence.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: payload.length,
        checksum,
        state: 'QUEUED',
      }),
    ]);
    const session = await api('/uploads', {
      method: 'POST',
      token: alpha.token,
      body: { attachmentId, sizeBytes: payload.length, checksum, chunkSize: 128 * 1024 },
    });
    check('upload session opened', session.status === 201, `${session.status}`);
    const { uploadId, chunkSize, totalChunks } = session.body?.data ?? {};
    let accepted = 0;
    for (let i = 0; i < totalChunks; i++) {
      const slice = payload.subarray(i * chunkSize, (i + 1) * chunkSize);
      const res = await api(`/uploads/${uploadId}/chunks/${i}`, {
        method: 'POST',
        token: alpha.token,
        body: {
          data: slice.toString('base64'),
          checksum: createHash('sha256').update(slice).digest('hex'),
        },
      });
      if (res.status < 300) accepted += 1;
    }
    check(
      `all ${totalChunks} chunks accepted`,
      accepted === totalChunks,
      `${accepted}/${totalChunks}`,
    );
    const complete = await api(`/uploads/${uploadId}/complete`, {
      method: 'POST',
      token: alpha.token,
      body: { checksum },
    });
    check('upload assembled and stored', complete.status < 300, `${complete.status}`);
    const download = await api(`/uploads/attachments/${attachmentId}/content`, {
      token: alpha.token,
      raw: true,
    });
    check(
      'stored bytes match what was sent',
      createHash('sha256').update(download.buffer).digest('hex') === checksum,
    );

    section('9. Reports');
    const pdf = await api(`/reports/inspection/${inspectionId}?format=pdf`, {
      token: admin.token,
      raw: true,
    });
    check('PDF generated', pdf.status === 200 && pdf.buffer.subarray(0, 4).toString() === '%PDF');
    const xlsx = await api('/reports/export/inspections?format=xlsx', {
      token: admin.token,
      raw: true,
    });
    check('xlsx generated', xlsx.status === 200 && xlsx.buffer.subarray(0, 2).toString() === 'PK');
    const csv = await api('/reports/export/inspections?format=csv', {
      token: admin.token,
      raw: true,
    });
    check('CSV generated', csv.status === 200);

    section('10. Administrator visibility');
    check(
      'analytics available',
      (await api('/analytics/summary', { token: admin.token })).status === 200,
    );
    check(
      'audit log available',
      (await api('/admin/audit-logs', { token: admin.token })).status === 200,
    );
    check(
      'inspector refused admin endpoints',
      (await api('/users', { token: alpha.token })).status === 403,
    );

    section('11. Session lifecycle');
    const logout = await api('/auth/logout', {
      method: 'POST',
      token: bravo.token,
      body: { refreshToken: bravo.refreshToken, deviceId: bravo.deviceId },
    });
    check('logout accepted', logout.status < 300, `${logout.status}`);
    const reuse = await api('/auth/refresh', {
      method: 'POST',
      body: { refreshToken: bravo.refreshToken, deviceId: bravo.deviceId },
    });
    check('revoked refresh token cannot be reused', reuse.status !== 200, `${reuse.status}`);
  } finally {
    section('Cleanup');
    // Best effort, and reported: a run that leaves rows behind on a production
    // database must say so rather than exiting quietly.
    // Archived, not deleted: the API has no DELETE for an inspection, and that
    // is deliberate — a compliance record is never hard-removed, only
    // tombstoned, so an offline device learns about it on its next pull.
    let removed = 0;
    for (const id of created.inspectionIds) {
      const res = await api(`/inspections/${id}/archive`, {
        method: 'POST',
        token: admin?.token,
        body: {},
      });
      if (res.status < 300) removed += 1;
    }
    console.log(`  inspections archived: ${removed}/${created.inspectionIds.length}`);

    let deactivated = 0;
    for (const email of created.userEmails) {
      const list = await api(`/users?search=${encodeURIComponent(email)}`, { token: admin?.token });
      const user = (list.body?.data?.items ?? []).find((u) => u.email === email);
      if (user) {
        const res = await api(`/users/${user.id}`, { method: 'DELETE', token: admin?.token });
        if (res.status < 300) deactivated += 1;
      }
    }
    console.log(`  users removed: ${deactivated}/${created.userEmails.length}`);
    if (removed < created.inspectionIds.length || deactivated < created.userEmails.length) {
      console.log(
        `  \x1b[33mnote\x1b[0m: some test data remains. Everything this run created is ` +
          `prefixed "e2e-" and tagged ${RUN}.`,
      );
    }
  }

  console.log(`\n\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
  if (failed) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31mHarness error:\x1b[0m ${err.message}`);
  process.exit(1);
});
