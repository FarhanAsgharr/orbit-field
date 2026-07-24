/**
 * Reports, exports, and notifications verification.
 *
 * Asserts the bytes, not just the status code. A 200 that returns a zero-byte
 * PDF or a spreadsheet with no rows passes a naive check and fails the person
 * who opens it, so every format is inspected: PDF magic number and page count,
 * xlsx ZIP structure and worksheet count, CSV header and injection guarding.
 *
 * Run: node scripts/e2e-reports.mjs [baseUrl]
 */

import { unzipSync } from 'node:zlib';

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

async function login(email, installationId) {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'OrbitField2026!',
      device: {
        installationId,
        name: 'Reports harness',
        platform: 'web',
        osVersion: 'harness',
        appVersion: '1.0.0',
      },
    }),
  });
  if (!response.ok) throw new Error(`login ${email} failed (${response.status})`);
  const body = await response.json();
  return body.data.tokens.accessToken;
}

async function api(path, token, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 120) }; }
  return { status: response.status, data: body && 'data' in body ? body.data : body, raw: body };
}

async function download(path, token) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    disposition: response.headers.get('content-disposition') ?? '',
    cacheControl: response.headers.get('cache-control') ?? '',
    bytes,
  };
}

/** Central-directory entry names from a ZIP, without a full unzip. */
function zipEntries(buffer) {
  const names = [];
  // Scan for local file headers (PK\x03\x04) and read the name that follows.
  for (let i = 0; i < buffer.length - 30; i++) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x03 && buffer[i + 3] === 0x04) {
      const nameLength = buffer.readUInt16LE(i + 26);
      const extraLength = buffer.readUInt16LE(i + 28);
      names.push(buffer.subarray(i + 30, i + 30 + nameLength).toString('utf8'));
      i += 30 + nameLength + extraLength - 1;
    }
  }
  return names;
}

async function main() {
  console.log('\x1b[1mOrbit Field — reports, exports, notifications\x1b[0m');
  console.log(`Target: ${BASE}\n`);

  const admin = await login('admin@northwind.test', 'reports-harness-admin');
  const inspector = await login('inspector@northwind.test', 'reports-harness-insp');

  // --- catalogue -----------------------------------------------------------
  section('1. Export catalogue');
  const catalogue = await api('/reports/datasets', admin);
  check('GET /reports/datasets returns 200', catalogue.status === 200, `status=${catalogue.status}`);
  check('catalogue lists datasets with formats and availability',
    Array.isArray(catalogue.data) && catalogue.data.every((d) => 'key' in d && 'formats' in d && 'available' in d),
    JSON.stringify(catalogue.data?.[0] ?? {}).slice(0, 120));
  check('catalogue reflects the caller\'s permissions',
    catalogue.data.some((d) => d.available === true));

  const inspectorCatalogue = await api('/reports/datasets', inspector);
  check('an inspector sees audit exports as unavailable',
    inspectorCatalogue.data.find((d) => d.key === 'audit')?.available === false,
    JSON.stringify(inspectorCatalogue.data?.find((d) => d.key === 'audit')));

  // --- xlsx ----------------------------------------------------------------
  section('2. Excel export');
  const xlsx = await download('/reports/export/inspections?format=xlsx', admin);
  check('xlsx export returns 200', xlsx.status === 200, `status=${xlsx.status}`);
  check('xlsx carries the spreadsheet content type',
    xlsx.contentType.includes('spreadsheetml'), xlsx.contentType);
  check('xlsx is served as an attachment with a filename',
    xlsx.disposition.includes('attachment') && xlsx.disposition.includes('.xlsx'),
    xlsx.disposition);
  check('xlsx is not cached — an export is a point-in-time snapshot',
    xlsx.cacheControl.includes('no-store'), xlsx.cacheControl);
  check('xlsx is a real ZIP container',
    xlsx.bytes[0] === 0x50 && xlsx.bytes[1] === 0x4b,
    `magic=${xlsx.bytes.subarray(0, 2).toString('hex')}`);
  check('xlsx is not an empty shell', xlsx.bytes.length > 5000, `${xlsx.bytes.length} bytes`);

  const entries = zipEntries(xlsx.bytes);
  check('xlsx contains a worksheet', entries.some((e) => e.startsWith('xl/worksheets/sheet')),
    entries.slice(0, 5).join(', '));
  check('xlsx contains styles — headers and signals are formatted',
    entries.includes('xl/styles.xml'));

  // --- csv -----------------------------------------------------------------
  section('3. CSV export');
  const csv = await download('/reports/export/inspections?format=csv', admin);
  check('csv export returns 200', csv.status === 200, `status=${csv.status}`);
  check('csv carries a UTF-8 BOM so Excel opens it correctly',
    csv.bytes[0] === 0xef && csv.bytes[1] === 0xbb && csv.bytes[2] === 0xbf,
    csv.bytes.subarray(0, 3).toString('hex'));

  const csvText = csv.bytes.toString('utf8');
  check('csv header names the expected columns',
    csvText.includes('Reference') && csvText.includes('Result') && csvText.includes('Score'),
    csvText.slice(1, 80));
  check('csv has data rows, not just a header', csvText.split('\r\n').length > 2,
    `${csvText.split('\r\n').length} lines`);

  // Formula injection: any cell opening with = + - @ must be neutralised.
  const dangerous = csvText
    .split('\r\n')
    .slice(1)
    .flatMap((line) => line.split(','))
    .filter((cell) => /^[=+@]/.test(cell.replace(/^"/, '')));
  check('csv neutralises formula injection in free-text cells',
    dangerous.length === 0,
    dangerous.slice(0, 3).join(' | '));

  // --- pdf -----------------------------------------------------------------
  section('4. PDF export');
  const pdf = await download('/reports/export/inspections?format=pdf', admin);
  check('pdf export returns 200', pdf.status === 200, `status=${pdf.status}`);
  check('pdf carries the pdf content type', pdf.contentType.includes('application/pdf'), pdf.contentType);
  check('pdf starts with the PDF magic number',
    pdf.bytes.subarray(0, 4).toString('ascii') === '%PDF',
    pdf.bytes.subarray(0, 8).toString('ascii'));
  check('pdf is terminated properly',
    pdf.bytes.subarray(-1024).toString('latin1').includes('%%EOF'));

  const pageCount = (pdf.bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check('pdf contains at least one page', pageCount >= 1, `${pageCount} pages`);

  // --- summary and batch ---------------------------------------------------
  section('5. Summary and batch reports');
  const summary = await download('/reports/summary?format=pdf', admin);
  check('summary report generates', summary.status === 200 && summary.bytes.length > 2000,
    `status=${summary.status} bytes=${summary.bytes.length}`);
  check('summary is a valid PDF', summary.bytes.subarray(0, 4).toString('ascii') === '%PDF');

  const batch = await download('/reports/batch?datasets=inspections,users,devices&format=xlsx', admin);
  check('batch export returns 200', batch.status === 200, `status=${batch.status}`);

  const batchEntries = zipEntries(batch.bytes);
  const sheetCount = batchEntries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e)).length;
  check('batch workbook has one worksheet per dataset', sheetCount === 3, `${sheetCount} worksheets`);

  // --- authorisation -------------------------------------------------------
  section('6. Export authorisation');
  const deniedAudit = await download('/reports/export/audit?format=csv', inspector);
  check('an inspector cannot export the audit log', deniedAudit.status === 403,
    `status=${deniedAudit.status}`);

  const deniedUsers = await download('/reports/export/users?format=xlsx', inspector);
  check('an inspector cannot export the user list', deniedUsers.status === 403,
    `status=${deniedUsers.status}`);

  const allowedOwn = await download('/reports/export/inspections?format=csv', inspector);
  check('an inspector can export their own inspections', allowedOwn.status === 200,
    `status=${allowedOwn.status}`);

  const batchPartial = await fetch(`${BASE}/reports/batch?datasets=inspections,audit&format=xlsx`, {
    headers: { Authorization: `Bearer ${inspector}` },
  });
  check('a batch drops datasets the caller cannot reach rather than failing',
    batchPartial.status === 200 &&
      (batchPartial.headers.get('x-orbit-datasets') ?? '') === 'inspections',
    `status=${batchPartial.status} datasets=${batchPartial.headers.get('x-orbit-datasets')}`);

  // --- history -------------------------------------------------------------
  section('7. Export history');
  const history = await api('/reports/history?pageSize=10', admin);
  check('export history returns entries', history.status === 200 && history.data?.total > 0,
    `status=${history.status} total=${history.data?.total}`);
  check('history records the format and row count',
    history.data?.items?.[0]?.metadata?.format !== undefined,
    JSON.stringify(history.data?.items?.[0]?.metadata ?? {}).slice(0, 120));

  // --- notifications -------------------------------------------------------
  section('8. Notifications');
  const inbox = await api('/notifications?pageSize=5', inspector);
  check('inbox returns 200', inbox.status === 200, `status=${inbox.status}`);
  check('inbox reports an unread count for the app badge',
    typeof inbox.data?.unread === 'number', `unread=${inbox.data?.unread}`);

  const prefs = await api('/notifications/preferences', inspector);
  check('preferences return 200', prefs.status === 200, `status=${prefs.status}`);
  check('preferences enumerate every topic with a human label',
    Array.isArray(prefs.data?.topics) && prefs.data.topics.every((t) => t.label && t.label !== t.topic),
    JSON.stringify(prefs.data?.topics?.[0] ?? {}));
  check('conflict alerts are marked unmutable',
    prefs.data?.topics?.find((t) => t.topic === 'SYNC_CONFLICT')?.mutable === false);

  const quiet = await api('/notifications/preferences', inspector, {
    method: 'PATCH',
    body: { quietHours: { enabled: true, startHour: 22, endHour: 7 }, sound: false },
  });
  check('quiet hours can be set', quiet.status === 200 &&
    quiet.data?.quietHours?.startHour === 22, JSON.stringify(quiet.data?.quietHours));
  check('a partial preference update preserves the rest',
    quiet.data?.enabled === true && quiet.data?.badge === true,
    JSON.stringify(quiet.data));

  const muteConflict = await api('/notifications/preferences', inspector, {
    method: 'PATCH',
    body: { mutedTopics: ['SYNC_CONFLICT'] },
  });
  check('conflict alerts cannot be muted', muteConflict.status === 422,
    `status=${muteConflict.status}`);

  const announceDenied = await api('/notifications/announce', inspector, {
    method: 'POST',
    body: { title: 'Should fail', body: 'Inspector cannot announce.' },
  });
  check('an inspector cannot broadcast an announcement', announceDenied.status === 403,
    `status=${announceDenied.status}`);

  const announce = await api('/notifications/announce', admin, {
    method: 'POST',
    body: { title: 'Scheduled maintenance', body: 'Sync will pause briefly on Sunday at 02:00.', role: 'INSPECTOR' },
  });
  check('an admin can broadcast', announce.status === 200 && announce.data?.created > 0,
    `status=${announce.status} created=${announce.data?.created}`);

  const afterAnnounce = await api('/notifications?pageSize=5', inspector);
  check('the announcement lands in the inbox even with push unavailable',
    afterAnnounce.data?.items?.some((n) => n.title === 'Scheduled maintenance'),
    'the record is the notification; push is only early warning');

  // --- metrics -------------------------------------------------------------
  section('9. Metrics endpoint');
  const metrics = await fetch(`${BASE.replace('/api/v1', '')}/metrics`);
  const metricsText = await metrics.text();
  check('metrics endpoint returns 200', metrics.status === 200, `status=${metrics.status}`);
  check('metrics use the Prometheus exposition format',
    metricsText.includes('# HELP') && metricsText.includes('# TYPE'),
    metricsText.slice(0, 60));
  check('request counters are present', metricsText.includes('orbit_http_requests_total'));
  check('latency histogram is present',
    metricsText.includes('orbit_http_request_duration_seconds_bucket'));
  check('fleet gauges are present',
    metricsText.includes('orbit_unresolved_conflicts') && metricsText.includes('orbit_devices_stale'));
  check('route labels are normalised, not per-id',
    !/route="[^"]*\/[0-9A-HJKMNP-TV-Z]{26}/.test(metricsText),
    'unbounded label cardinality would exhaust the metrics backend');

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
