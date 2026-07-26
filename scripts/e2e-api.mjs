/**
 * End-to-end verification of the REST surface.
 *
 * Complements `e2e-sync.mjs`, which covers the sync protocol. This one covers
 * the endpoints the admin dashboard and the mobile account screens call:
 * devices, inspection search/duplicate/archive/history/bulk, and the chunked
 * upload server.
 *
 * Run: node scripts/e2e-api.mjs [baseUrl]
 */

import { createHash } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:4055/api/v1';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let seq = 0;
function ulid() {
  seq += 1;
  let time = '';
  let t = Date.now();
  for (let i = 9; i >= 0; i--) {
    time = ENC[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 15; i++) rand += ENC[Math.floor(Math.random() * 32)];
  return (time + rand + ENC[seq % 32]).slice(0, 26);
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: json };
}

async function login(email, installationId) {
  const result = await api('/auth/login', {
    method: 'POST',
    body: {
      email,
      password: 'OrbitField2026!',
      rememberMe: true,
      device: {
        installationId,
        name: `Harness ${installationId}`,
        platform: 'android',
        osVersion: '14',
        appVersion: '1.0.0',
      },
    },
  });
  if (result.status !== 200) {
    throw new Error(
      `login ${email} failed (${result.status}): ${JSON.stringify(result.body).slice(0, 300)}`,
    );
  }
  return {
    token: result.body.data.tokens.accessToken,
    deviceId: result.body.data.device.id,
    userId: result.body.data.user.id,
  };
}

async function main() {
  console.log('\x1b[1mOrbit Field — REST API verification\x1b[0m');
  console.log(`Target: ${BASE}\n`);

  // Reuse a stable installation id so repeated runs do not exhaust the
  // per-user device cap (which is itself a feature, verified below).
  const inspector = await login('inspector@northwind.test', 'harness-rest-inspector');
  const manager = await login('manager@northwind.test', 'harness-rest-manager');

  // --- devices -----------------------------------------------------------
  section('1. Devices API');
  const devices = await api('/devices', { token: inspector.token });
  check(
    'GET /devices returns 200 (previously 404)',
    devices.status === 200,
    `status=${devices.status}`,
  );
  check('device list is an array', Array.isArray(devices.body?.data));
  check(
    'current device appears in the list',
    (devices.body?.data ?? []).some((d) => d.id === inspector.deviceId),
  );
  check(
    'biometric public key is never exposed',
    (devices.body?.data ?? []).every((d) => !('biometricPublicKey' in d)),
  );

  const rename = await api(`/devices/${inspector.deviceId}`, {
    method: 'PATCH',
    token: inspector.token,
    body: { name: 'Renamed Harness Device' },
  });
  check(
    'PATCH /devices/:id renames',
    rename.status === 200 && rename.body?.data?.name === 'Renamed Harness Device',
    `status=${rename.status} name=${rename.body?.data?.name}`,
  );

  const pushToken = await api(`/devices/${inspector.deviceId}/push-token`, {
    method: 'POST',
    token: inspector.token,
    body: { pushToken: 'ExponentPushToken[harness-test-token-value]' },
  });
  check('push token registration accepted', pushToken.status === 204, `status=${pushToken.status}`);

  const sessions = await api(`/devices/${inspector.deviceId}/sessions`, { token: inspector.token });
  check(
    'device sessions listed',
    sessions.status === 200 && Array.isArray(sessions.body?.data),
    `status=${sessions.status}`,
  );
  check(
    'session listing never returns a token hash',
    (sessions.body?.data ?? []).every((s) => !('tokenHash' in s)),
  );

  const foreignDevice = await api(`/devices/${manager.deviceId}`, {
    method: 'PATCH',
    token: inspector.token,
    body: { name: 'Should not work' },
  });
  check(
    "inspector cannot rename another user's device",
    foreignDevice.status === 403,
    `status=${foreignDevice.status}`,
  );

  // --- inspections list ---------------------------------------------------
  section('2. Inspections API — search and filter');
  const list = await api('/inspections?pageSize=5', { token: inspector.token });
  check('GET /inspections returns 200', list.status === 200, `status=${list.status}`);
  check(
    'response is paginated',
    typeof list.body?.data?.total === 'number' && Array.isArray(list.body?.data?.items),
    JSON.stringify(list.body?.data ?? {}).slice(0, 150),
  );
  check('page size is honoured', (list.body?.data?.items ?? []).length <= 5);
  check(
    'rows include joined template and site names',
    (list.body?.data?.items ?? []).every((i) => 'template' in i && 'site' in i),
  );

  const searched = await api('/inspections?search=EICR&pageSize=50', { token: inspector.token });
  check(
    'search by title matches',
    searched.status === 200 && searched.body?.data?.total > 0,
    `total=${searched.body?.data?.total}`,
  );

  const filtered = await api('/inspections?status=SCHEDULED&pageSize=50', {
    token: inspector.token,
  });
  check(
    'status filter applied',
    filtered.status === 200 &&
      (filtered.body?.data?.items ?? []).every((i) => i.status === 'SCHEDULED'),
    `count=${filtered.body?.data?.items?.length}`,
  );

  const sorted = await api('/inspections?sortBy=number&sortDir=asc&pageSize=50', {
    token: inspector.token,
  });
  const numbers = (sorted.body?.data?.items ?? []).map((i) => i.number);
  check(
    'sorting is applied',
    numbers.length < 2 || numbers.every((n, i) => i === 0 || numbers[i - 1] <= n),
    numbers.slice(0, 3).join(','),
  );

  const injection = await api('/inspections?sortBy=id;DROP%20TABLE%20users&pageSize=1', {
    token: inspector.token,
  });
  check(
    'unknown sort column falls back safely rather than injecting',
    injection.status === 200,
    `status=${injection.status}`,
  );

  // --- detail, history, duplicate ----------------------------------------
  section('3. Inspections API — detail, history, duplicate');
  const anyId = list.body?.data?.items?.[0]?.id;
  check('a seeded inspection is available to test with', Boolean(anyId));

  const detail = await api(`/inspections/${anyId}`, { token: inspector.token });
  check(
    'GET /inspections/:id returns the full record',
    detail.status === 200,
    `status=${detail.status}`,
  );
  check(
    'detail includes responses and attachments',
    Array.isArray(detail.body?.data?.responses) && Array.isArray(detail.body?.data?.attachments),
  );
  check(
    'detail includes the pinned template definition',
    Boolean(detail.body?.data?.templateVersion?.definition),
  );

  const missing = await api(`/inspections/${ulid()}`, { token: inspector.token });
  check('unknown inspection returns 404', missing.status === 404, `status=${missing.status}`);

  const duplicate = await api(`/inspections/${anyId}/duplicate`, {
    method: 'POST',
    token: inspector.token,
    body: { title: 'Harness duplicate' },
  });
  check(
    'duplicate returns 201',
    duplicate.status === 201,
    JSON.stringify(duplicate.body).slice(0, 200),
  );
  check(
    'duplicate got its own server-allocated number',
    duplicate.body?.data?.number && duplicate.body.data.number !== detail.body?.data?.number,
    `${duplicate.body?.data?.number} vs ${detail.body?.data?.number}`,
  );
  check(
    'duplicate starts as a DRAFT',
    duplicate.body?.data?.status === 'DRAFT',
    `status=${duplicate.body?.data?.status}`,
  );
  check('duplicate records its source', duplicate.body?.data?.duplicatedFromId === anyId);

  const duplicateId = duplicate.body?.data?.id;
  const duplicateDetail = await api(`/inspections/${duplicateId}`, { token: inspector.token });
  check(
    'duplicate copied NO answers (evidence integrity)',
    (duplicateDetail.body?.data?.responses ?? []).length === 0,
    `responses=${duplicateDetail.body?.data?.responses?.length}`,
  );

  // The duplicate must be visible to offline devices, which means a change-log
  // entry must have been written — this is the easiest thing to get wrong.
  const pullAfterDuplicate = await api('/sync/pull?protocolVersion=1&since=0&limit=2000', {
    token: inspector.token,
  });
  check(
    'REST-created record appears in the sync delta',
    (pullAfterDuplicate.body?.changes ?? []).some((c) => c.entityId === duplicateId),
    'no change-log entry — offline devices would never see it',
  );

  const history = await api(`/inspections/${duplicateId}/history`, { token: inspector.token });
  check(
    'history endpoint returns entries',
    history.status === 200 && history.body?.data?.total > 0,
    `status=${history.status} total=${history.body?.data?.total}`,
  );
  check(
    'history entries carry an actor',
    (history.body?.data?.items ?? []).some((h) => h.actorName),
  );

  // --- archive ------------------------------------------------------------
  section('4. Inspections API — archive and review');
  const archive = await api(`/inspections/${duplicateId}/archive`, {
    method: 'POST',
    token: manager.token,
    body: { archived: true },
  });
  check('archive succeeds for a manager', archive.status === 200, `status=${archive.status}`);
  check('archived flag set', archive.body?.data?.isArchived === true);

  const archiveDenied = await api(`/inspections/${anyId}/archive`, {
    method: 'POST',
    token: inspector.token,
    body: { archived: true },
  });
  check(
    'inspector lacks archive permission',
    archiveDenied.status === 403,
    `status=${archiveDenied.status}`,
  );

  const rejectNoReason = await api(`/inspections/${anyId}/review`, {
    method: 'POST',
    token: manager.token,
    body: { decision: 'REJECT' },
  });
  check(
    'rejection without a reason is refused',
    rejectNoReason.status === 422,
    `status=${rejectNoReason.status}`,
  );

  // --- bulk ---------------------------------------------------------------
  section('5. Inspections API — bulk operations');
  const bulkTargets = [];
  for (let i = 0; i < 3; i++) {
    const created = await api(`/inspections/${anyId}/duplicate`, {
      method: 'POST',
      token: inspector.token,
      body: { title: `Bulk target ${i}` },
    });
    if (created.body?.data?.id) bulkTargets.push(created.body.data.id);
  }
  check('created bulk fixtures', bulkTargets.length === 3, `created=${bulkTargets.length}`);

  const bulk = await api('/inspections/bulk', {
    method: 'POST',
    token: manager.token,
    body: { ids: bulkTargets, action: 'SET_PRIORITY', priority: 'CRITICAL' },
  });
  check('bulk operation returns 200', bulk.status === 200, JSON.stringify(bulk.body).slice(0, 200));
  check(
    'all targets succeeded',
    bulk.body?.data?.succeeded === 3,
    `succeeded=${bulk.body?.data?.succeeded}`,
  );

  const verifyBulk = await api(`/inspections/${bulkTargets[0]}`, { token: manager.token });
  check(
    'bulk change actually applied',
    verifyBulk.body?.data?.priority === 'CRITICAL',
    `priority=${verifyBulk.body?.data?.priority}`,
  );

  const bulkTags = await api('/inspections/bulk', {
    method: 'POST',
    token: manager.token,
    body: { ids: bulkTargets, action: 'ADD_TAGS', tags: ['bulk-tagged'] },
  });
  check('bulk tagging succeeded', bulkTags.body?.data?.succeeded === 3);

  const bulkDenied = await api('/inspections/bulk', {
    method: 'POST',
    token: inspector.token,
    body: { ids: bulkTargets, action: 'ARCHIVE' },
  });
  check(
    'inspector denied bulk operations',
    bulkDenied.status === 403,
    `status=${bulkDenied.status}`,
  );

  const bulkTooMany = await api('/inspections/bulk', {
    method: 'POST',
    token: manager.token,
    body: { ids: Array.from({ length: 201 }, () => ulid()), action: 'ARCHIVE' },
  });
  check('bulk batch size is capped', bulkTooMany.status === 422, `status=${bulkTooMany.status}`);

  // --- uploads ------------------------------------------------------------
  section('6. Chunked upload server');

  // A real payload spanning three chunks, so resume and assembly are exercised
  // rather than a single-chunk happy path.
  // Unique per run: a deterministic payload would be deduplicated by the server
  // on the second run, short-circuiting the very transfer path under test.
  const runSalt = Date.now() % 251;
  const payload = Buffer.from(Array.from({ length: 300 * 1024 }, (_, i) => (i + runSalt) % 251));
  const fullChecksum = createHash('sha256').update(payload).digest('hex');
  const CHUNK = 128 * 1024;
  const totalChunks = Math.ceil(payload.length / CHUNK);

  // The attachment row must exist first — it arrives via sync in the real app.
  const attachmentId = ulid();
  const attachOp = {
    id: ulid(),
    entity: 'ATTACHMENT',
    operation: 'CREATE',
    entityId: attachmentId,
    patch: {
      inspectionId: anyId,
      kind: 'PHOTO',
      fileName: 'harness-upload.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: payload.length,
      checksum: fullChecksum,
      state: 'QUEUED',
    },
    baseVersion: null,
    dependsOn: [],
    clientTimestamp: new Date().toISOString(),
    lamport: 900000 + seq,
    deviceId: inspector.deviceId,
    userId: inspector.userId,
  };

  const attachPush = await api('/sync/push', {
    method: 'POST',
    token: inspector.token,
    body: { protocolVersion: 1, deviceId: inspector.deviceId, cursor: 0, operations: [attachOp] },
  });
  check(
    'attachment metadata synced',
    attachPush.body?.results?.[0]?.status === 'APPLIED',
    JSON.stringify(attachPush.body?.results?.[0]).slice(0, 200),
  );

  const session = await api('/uploads', {
    method: 'POST',
    token: inspector.token,
    body: { attachmentId, sizeBytes: payload.length, checksum: fullChecksum, chunkSize: CHUNK },
  });
  check(
    'upload session opened',
    session.status === 201,
    JSON.stringify(session.body).slice(0, 200),
  );
  check(
    'server computed the chunk count',
    session.body?.data?.totalChunks === totalChunks,
    `${session.body?.data?.totalChunks} vs ${totalChunks}`,
  );

  const uploadId = session.body?.data?.uploadId;

  // Send all but one chunk, then simulate a crash and resume.
  for (let i = 0; i < totalChunks - 1; i++) {
    const slice = payload.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, payload.length));
    const ack = await api(`/uploads/${uploadId}/chunks/${i}`, {
      method: 'POST',
      token: inspector.token,
      body: {
        data: slice.toString('base64'),
        checksum: createHash('sha256').update(slice).digest('hex'),
      },
    });
    if (ack.status !== 200) {
      check(`chunk ${i} accepted`, false, JSON.stringify(ack.body).slice(0, 200));
      break;
    }
  }
  check('partial chunks accepted', true);

  const resumed = await api(`/uploads/${uploadId}`, { token: inspector.token });
  check(
    'resume reports exactly what the server holds',
    (resumed.body?.data?.receivedChunks ?? []).length === totalChunks - 1,
    `received=${resumed.body?.data?.receivedChunks?.length} expected=${totalChunks - 1}`,
  );

  const premature = await api(`/uploads/${uploadId}/complete`, {
    method: 'POST',
    token: inspector.token,
    body: { checksum: fullChecksum },
  });
  check(
    'completing with a missing chunk is refused',
    premature.status === 400,
    `status=${premature.status}`,
  );

  // Re-send an already-received chunk: must be idempotent, not an error.
  const first = payload.subarray(0, CHUNK);
  const replayChunk = await api(`/uploads/${uploadId}/chunks/0`, {
    method: 'POST',
    token: inspector.token,
    body: { data: first.toString('base64') },
  });
  check(
    're-sending a received chunk is idempotent',
    replayChunk.status === 200,
    `status=${replayChunk.status}`,
  );

  // A corrupt chunk must be rejected at receipt, not at assembly.
  const lastIndex = totalChunks - 1;
  const corrupt = await api(`/uploads/${uploadId}/chunks/${lastIndex}`, {
    method: 'POST',
    token: inspector.token,
    body: {
      data: Buffer.from('not the real bytes').toString('base64'),
      checksum: createHash('sha256').update('something else').digest('hex'),
    },
  });
  check(
    'chunk checksum mismatch rejected on receipt',
    corrupt.status === 422,
    `status=${corrupt.status}`,
  );

  // Now send the real final chunk.
  const finalSlice = payload.subarray(lastIndex * CHUNK);
  const finalAck = await api(`/uploads/${uploadId}/chunks/${lastIndex}`, {
    method: 'POST',
    token: inspector.token,
    body: {
      data: finalSlice.toString('base64'),
      checksum: createHash('sha256').update(finalSlice).digest('hex'),
    },
  });
  check(
    'final chunk accepted',
    finalAck.status === 200,
    JSON.stringify(finalAck.body).slice(0, 200),
  );
  check('server reports the upload complete', finalAck.body?.data?.complete === true);

  const completed = await api(`/uploads/${uploadId}/complete`, {
    method: 'POST',
    token: inspector.token,
    body: { checksum: fullChecksum },
  });
  check(
    'finalise succeeded',
    completed.status === 200,
    JSON.stringify(completed.body).slice(0, 200),
  );
  check('server returned a storage key', Boolean(completed.body?.data?.storageKey));
  check(
    'assembled size matches the original',
    completed.body?.data?.sizeBytes === payload.length,
    `${completed.body?.data?.sizeBytes} vs ${payload.length}`,
  );
  check(
    'assembled checksum matches — bytes survived the round trip',
    completed.body?.data?.checksum === fullChecksum,
    `${completed.body?.data?.checksum} vs ${fullChecksum}`,
  );

  const download = await fetch(`${BASE}/uploads/attachments/${attachmentId}/content`, {
    headers: { Authorization: `Bearer ${inspector.token}` },
  });
  const downloaded = Buffer.from(await download.arrayBuffer());
  check(
    'stored file downloads back byte-identical',
    download.status === 200 && downloaded.equals(payload),
    `status=${download.status} size=${downloaded.length}`,
  );

  // --- dedupe -------------------------------------------------------------
  section('7. Upload deduplication');
  const dupAttachmentId = ulid();
  const dupOp = {
    ...attachOp,
    id: ulid(),
    entityId: dupAttachmentId,
    lamport: 900500 + seq,
    patch: { ...attachOp.patch, fileName: 'harness-duplicate.bin' },
  };
  await api('/sync/push', {
    method: 'POST',
    token: inspector.token,
    body: { protocolVersion: 1, deviceId: inspector.deviceId, cursor: 0, operations: [dupOp] },
  });

  const dedupe = await api('/uploads', {
    method: 'POST',
    token: inspector.token,
    body: { attachmentId: dupAttachmentId, sizeBytes: payload.length, checksum: fullChecksum },
  });
  check(
    'identical content is deduplicated rather than re-uploaded',
    dedupe.body?.data?.complete === true && Boolean(dedupe.body?.data?.storageKey),
    JSON.stringify(dedupe.body?.data ?? {}).slice(0, 200),
  );

  // --- summary ------------------------------------------------------------
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`\x1b[1mResult: ${passed} passed, ${failed} failed\x1b[0m`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  • ${f.name}${f.detail ? `\n      ${f.detail}` : ''}`);
  }
  console.log('');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n\x1b[31mHarness error:\x1b[0m', err.message);
  process.exit(2);
});
