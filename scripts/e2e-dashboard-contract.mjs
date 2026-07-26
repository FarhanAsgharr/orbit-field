/**
 * Dashboard ↔ API contract verification.
 *
 * The dashboard destructures specific field names out of every response. A
 * rename on either side produces a screen that renders blank or shows "—"
 * everywhere, with no error anywhere — the failure mode that a build passing and
 * a typecheck passing will both happily miss, because the API's runtime shape is
 * not connected to the dashboard's TypeScript interfaces.
 *
 * This asserts the shapes the console actually reads.
 *
 * Run: node scripts/e2e-dashboard-contract.mjs [baseUrl]
 */

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

/** Assert every named key is present on an object. */
function hasKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return `not an object: ${JSON.stringify(obj)?.slice(0, 80)}`;
  const missing = keys.filter((k) => !(k in obj));
  return missing.length === 0 ? null : `missing: ${missing.join(', ')}`;
}

async function api(path, token, query) {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.append(k, String(v));
  }
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 120) };
  }
  // The console's client unwraps `{ data }` exactly like this.
  const unwrapped = body && typeof body === 'object' && 'data' in body ? body.data : body;
  return { status: response.status, data: unwrapped, raw: body };
}

async function login(email) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'OrbitField2026!',
      device: {
        installationId: `dash-contract-${email.split('@')[0]}`,
        name: 'Contract harness',
        platform: 'web',
        osVersion: 'harness',
        appVersion: '1.0.0',
      },
    }),
  });
  if (!response.ok) throw new Error(`login failed (${response.status})`);
  const body = await response.json();
  return body.data.tokens.accessToken;
}

async function main() {
  console.log('\x1b[1mOrbit Field — dashboard contract verification\x1b[0m');
  console.log(`Target: ${BASE}\n`);

  const admin = await login('admin@northwind.test');

  // --- session bootstrap --------------------------------------------------
  section('Session bootstrap (SessionProvider)');
  const me = await api('/auth/me', admin);
  check('GET /auth/me returns 200', me.status === 200, `status=${me.status}`);
  check(
    'identity carries the fields the console reads',
    hasKeys(me.data, ['userId', 'orgId', 'role', 'projectIds']) === null,
    hasKeys(me.data, ['userId', 'orgId', 'role', 'projectIds']),
  );

  // --- fleet status bar ---------------------------------------------------
  section('Fleet status bar + cursor lag rail (Shell)');
  const health = await api('/admin/sync-health', admin);
  check('GET /admin/sync-health returns 200', health.status === 200, `status=${health.status}`);
  check(
    'health carries serverCursor / conflicts / uploads / devices',
    hasKeys(health.data, ['serverCursor', 'unresolvedConflicts', 'pendingUploads', 'devices']) ===
      null,
    hasKeys(health.data, ['serverCursor', 'unresolvedConflicts', 'pendingUploads', 'devices']),
  );
  check(
    'serverCursor is a number the rail can position against',
    typeof health.data?.serverCursor === 'number',
    `type=${typeof health.data?.serverCursor}`,
  );

  const device = health.data?.devices?.[0];
  if (device) {
    check(
      'each device carries behind / stale / cursor for the lag rail',
      hasKeys(device, ['id', 'name', 'userName', 'behind', 'stale', 'cursor', 'lastSyncAt']) ===
        null,
      hasKeys(device, ['id', 'name', 'userName', 'behind', 'stale', 'cursor', 'lastSyncAt']),
    );
    check(
      'behind is numeric — the rail computes a position from it',
      typeof device.behind === 'number',
      `type=${typeof device.behind}`,
    );
  } else {
    check('at least one device exists to verify the rail against', false, 'no devices enrolled');
  }

  // --- overview -----------------------------------------------------------
  section('Overview');
  const summary = await api('/analytics/summary', admin);
  check('GET /analytics/summary returns 200', summary.status === 200, `status=${summary.status}`);
  check(
    'summary carries every metric the overview renders',
    hasKeys(summary.data, [
      'total',
      'statusCounts',
      'outcomeCounts',
      'completed',
      'failed',
      'overdue',
      'dueToday',
      'completionRate',
      'failureRate',
      'averageScore',
      'averageDurationMinutes',
    ]) === null,
    hasKeys(summary.data, [
      'total',
      'statusCounts',
      'outcomeCounts',
      'completionRate',
      'failureRate',
    ]),
  );
  check(
    'statusCounts is a keyed object the overview iterates',
    summary.data?.statusCounts &&
      typeof summary.data.statusCounts === 'object' &&
      !Array.isArray(summary.data.statusCounts),
  );

  // --- paginated lists ----------------------------------------------------
  section('DataTable pagination envelope');
  const paginated = [
    ['/inspections', 'Inspections'],
    ['/users', 'People'],
    ['/templates', 'Checklists'],
    ['/clients', 'Clients'],
    ['/projects', 'Projects'],
    ['/sites', 'Sites'],
    ['/admin/audit-logs', 'Audit log'],
  ];

  for (const [path, label] of paginated) {
    const result = await api(path, admin, { page: 1, pageSize: 5 });
    const shape = hasKeys(result.data, ['items', 'total', 'page', 'pageSize', 'hasMore']);
    check(
      `${label} (${path}) returns the pagination envelope`,
      result.status === 200 && shape === null,
      `status=${result.status} ${shape ?? ''}`,
    );
    check(`${label} items is an array`, Array.isArray(result.data?.items));
  }

  // --- column-level shapes -------------------------------------------------
  section('Column bindings');

  const inspections = await api('/inspections', admin, { pageSize: 3 });
  const inspection = inspections.data?.items?.[0];
  if (inspection) {
    check(
      'inspection row carries the columns the table renders',
      hasKeys(inspection, [
        'id',
        'number',
        'title',
        'status',
        'outcome',
        'priority',
        'score',
        'answeredFields',
        'totalFields',
        'dueAt',
        'updatedAt',
      ]) === null,
      hasKeys(inspection, [
        'id',
        'number',
        'title',
        'status',
        'outcome',
        'answeredFields',
        'totalFields',
      ]),
    );
    check(
      'inspection row includes joined template / site / client / assignee',
      'template' in inspection &&
        'site' in inspection &&
        'client' in inspection &&
        'assignedTo' in inspection,
      `keys: ${Object.keys(inspection)
        .filter((k) => ['template', 'site', 'client', 'assignedTo'].includes(k))
        .join(',')}`,
    );
    check(
      'inspection row includes _count for attachments',
      inspection._count && typeof inspection._count.attachments === 'number',
      JSON.stringify(inspection._count),
    );
  } else {
    check('at least one inspection exists', false, 'none returned');
  }

  const users = await api('/users', admin, { pageSize: 3 });
  const user = users.data?.items?.[0];
  if (user) {
    check(
      'user row carries the columns the People table renders',
      hasKeys(user, ['id', 'email', 'firstName', 'lastName', 'role', 'status', 'lastLoginAt']) ===
        null,
      hasKeys(user, ['id', 'email', 'firstName', 'lastName', 'role', 'status']),
    );
    check(
      'user row includes device and workload counts',
      user._count &&
        typeof user._count.devices === 'number' &&
        typeof user._count.assignedInspections === 'number',
      JSON.stringify(user._count),
    );
    check(
      'password material is never present',
      !('passwordHash' in user) && !('passwordHistory' in user),
    );
  }

  const templates = await api('/templates', admin, { pageSize: 3 });
  const template = templates.data?.items?.[0];
  if (template) {
    check(
      'template row carries activeVersionId and versions[] for the published badge',
      'activeVersionId' in template && Array.isArray(template.versions),
      `activeVersionId=${'activeVersionId' in template} versions=${Array.isArray(template.versions)}`,
    );
    check(
      'template row includes version and usage counts',
      template._count &&
        typeof template._count.versions === 'number' &&
        typeof template._count.inspections === 'number',
      JSON.stringify(template._count),
    );
  }

  const sites = await api('/sites', admin, { pageSize: 3 });
  const site = sites.data?.items?.[0];
  if (site) {
    check(
      'site row carries coordinates and geofence for the location column',
      'latitude' in site && 'longitude' in site && 'geofenceRadiusMeters' in site,
      Object.keys(site).slice(0, 12).join(','),
    );
  }

  // --- devices ------------------------------------------------------------
  section('Devices screen');
  const devices = await api('/devices', admin, { includeRevoked: true });
  check(
    'GET /devices returns a bare array (not paginated)',
    devices.status === 200 && Array.isArray(devices.data),
    `status=${devices.status} isArray=${Array.isArray(devices.data)}`,
  );
  if (Array.isArray(devices.data) && devices.data[0]) {
    check(
      'device row carries the columns the table renders',
      hasKeys(devices.data[0], [
        'id',
        'name',
        'platform',
        'osVersion',
        'appVersion',
        'lastSeenAt',
        'lastSyncAt',
        'revokedAt',
      ]) === null,
      hasKeys(devices.data[0], ['id', 'name', 'platform', 'lastSeenAt', 'lastSyncAt', 'revokedAt']),
    );
  }

  // --- sync monitoring ----------------------------------------------------
  section('Sync monitoring');
  const conflicts = await api('/admin/conflicts', admin, { resolved: false, pageSize: 10 });
  check(
    'GET /admin/conflicts returns the pagination envelope',
    conflicts.status === 200 && Array.isArray(conflicts.data?.items),
    `status=${conflicts.status}`,
  );

  const conflict = conflicts.data?.items?.[0];
  if (conflict) {
    check(
      'conflict carries diffs[] the resolution UI iterates',
      Array.isArray(conflict.diffs),
      `diffs=${typeof conflict.diffs}`,
    );
    check(
      'conflict carries operationId for the resolve call',
      typeof conflict.operationId === 'string',
    );
    const diff = conflict.diffs?.[0];
    if (diff) {
      check(
        'each diff carries path / label / isConflicting / both values',
        hasKeys(diff, [
          'path',
          'label',
          'localValue',
          'serverValue',
          'isConflicting',
          'autoResolution',
        ]) === null,
        hasKeys(diff, ['path', 'label', 'localValue', 'serverValue', 'isConflicting']),
      );
    }
  } else {
    console.log('  \x1b[2m·\x1b[0m no unresolved conflicts to inspect (not a failure)');
  }

  const sessions = await api('/admin/sync-sessions', admin, { pageSize: 5 });
  check(
    'GET /admin/sync-sessions returns the pagination envelope',
    sessions.status === 200 && Array.isArray(sessions.data?.items),
    `status=${sessions.status}`,
  );
  const sess = sessions.data?.items?.[0];
  if (sess) {
    check(
      'sync session carries counts and outcome the table renders',
      hasKeys(sess, [
        'id',
        'trigger',
        'pushedCount',
        'pulledCount',
        'conflictCount',
        'outcome',
        'startedAt',
      ]) === null,
      hasKeys(sess, ['trigger', 'pushedCount', 'pulledCount', 'conflictCount', 'outcome']),
    );
    check('sync session includes joined device and user', 'device' in sess && 'user' in sess);
  }

  // --- analytics ----------------------------------------------------------
  section('Analytics charts');
  const trend = await api('/analytics/trend', admin, { period: 'WEEKLY' });
  check(
    'GET /analytics/trend returns an array',
    Array.isArray(trend.data),
    `type=${typeof trend.data}`,
  );
  if (Array.isArray(trend.data) && trend.data[0]) {
    check(
      'trend point carries bucket + the three plotted series',
      hasKeys(trend.data[0], ['bucket', 'total', 'completed', 'failed']) === null,
      hasKeys(trend.data[0], ['bucket', 'total', 'completed', 'failed']),
    );
    check(
      'trend counts are numbers, not BigInt strings — Recharts cannot plot strings',
      typeof trend.data[0].total === 'number',
      `type=${typeof trend.data[0].total}`,
    );
  }

  const inspectorRows = await api('/analytics/inspectors', admin);
  check('GET /analytics/inspectors returns an array', Array.isArray(inspectorRows.data));
  if (Array.isArray(inspectorRows.data) && inspectorRows.data[0]) {
    check(
      'inspector row carries the columns the table renders',
      hasKeys(inspectorRows.data[0], [
        'userId',
        'name',
        'assigned',
        'completed',
        'averageScore',
        'onTimeRate',
      ]) === null,
      hasKeys(inspectorRows.data[0], [
        'userId',
        'name',
        'assigned',
        'completed',
        'averageScore',
        'onTimeRate',
      ]),
    );
  }

  const siteRows = await api('/analytics/sites', admin);
  check('GET /analytics/sites returns an array', Array.isArray(siteRows.data));
  if (Array.isArray(siteRows.data) && siteRows.data[0]) {
    check(
      'site analytics row carries failureRate for the bar chart',
      typeof siteRows.data[0].failureRate === 'number',
      `type=${typeof siteRows.data[0]?.failureRate}`,
    );
  }

  // --- settings -----------------------------------------------------------
  section('Settings');
  const org = await api('/admin/organization', admin);
  check('GET /admin/organization returns 200', org.status === 200, `status=${org.status}`);
  check(
    'organisation carries settings and counts the settings screen renders',
    hasKeys(org.data, ['id', 'name', 'settings', '_count']) === null,
    hasKeys(org.data, ['id', 'name', 'settings', '_count']),
  );
  check(
    'counts include users / devices / sites / inspections',
    hasKeys(org.data?._count, ['users', 'devices', 'sites', 'inspections']) === null,
    hasKeys(org.data?._count, ['users', 'devices', 'sites', 'inspections']),
  );

  // --- permission gating ---------------------------------------------------
  section('Permission gating (nav rail visibility)');
  const inspector = await login('inspector@northwind.test');
  const denied = await api('/admin/sync-health', inspector);
  check(
    'an inspector is denied fleet health, so the rail hides those links',
    denied.status === 403,
    `status=${denied.status}`,
  );

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
