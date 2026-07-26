/**
 * End-to-end verification of the admin surface.
 *
 * Covers templates (including the immutability guarantee), user administration
 * and privilege-escalation defences, reference data, and analytics.
 *
 * Run: node scripts/e2e-admin.mjs [baseUrl]
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

/**
 * Current server cursor, so a delta check can pull only what happened after a
 * specific action. Pulling from 0 hits the server's page cap once the change log
 * has grown, and the entry under test falls off the end — which looks like a
 * missing change-log write but is not.
 */
async function currentCursor(token) {
  const result = await api('/sync/pull?protocolVersion=1&since=0&limit=1', { token });
  return result.body?.cursor ?? 0;
}

/** Pull everything after `since`, following pagination to the end. */
async function pullSince(token, since) {
  const changes = [];
  let cursor = since;
  for (let page = 0; page < 20; page++) {
    const result = await api(`/sync/pull?protocolVersion=1&since=${cursor}&limit=1000`, { token });
    changes.push(...(result.body?.changes ?? []));
    cursor = result.body?.cursor ?? cursor;
    if (!result.body?.hasMore) break;
  }
  return changes;
}

async function login(email, installationId) {
  const result = await api('/auth/login', {
    method: 'POST',
    body: {
      email,
      password: 'OrbitField2026!',
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
  return { token: result.body.data.tokens.accessToken, userId: result.body.data.user.id };
}

/** A small but non-trivial checklist definition. */
function sampleDefinition(gateId, dependentId) {
  return {
    sections: [
      {
        title: 'Harness section',
        fields: [
          {
            id: gateId,
            key: 'gate',
            label: 'Is the equipment energised?',
            type: 'YES_NO',
            options: [
              { value: 'yes', label: 'Yes', score: 0, isFailure: true },
              { value: 'no', label: 'No', score: 1 },
            ],
            validation: { required: true },
            ui: {},
            logic: [],
            followUps: [],
          },
          {
            id: dependentId,
            key: 'isolation_note',
            label: 'Describe the isolation applied',
            type: 'TEXT_AREA',
            options: [],
            validation: { required: true, minLength: 10 },
            ui: {},
            logic: [
              {
                id: 'r1',
                when: {
                  kind: 'CONDITION',
                  condition: { fieldId: gateId, operator: 'EQUALS', value: 'no' },
                },
                effect: { type: 'HIDE' },
              },
            ],
            followUps: [],
          },
        ],
        logic: [],
      },
    ],
  };
}

async function main() {
  console.log('\x1b[1mOrbit Field — admin surface verification\x1b[0m');
  console.log(`Target: ${BASE}\n`);

  const admin = await login('admin@northwind.test', 'harness-admin');
  const manager = await login('manager@northwind.test', 'harness-admin-mgr');
  const inspector = await login('inspector@northwind.test', 'harness-admin-insp');

  // --- registration --------------------------------------------------------
  section('0. Self-service registration');

  const availability = await api('/auth/signup-available');
  check(
    'signup availability is public and unauthenticated',
    availability.status === 200 && typeof availability.body?.data?.available === 'boolean',
    `status=${availability.status}`,
  );

  const stamp = Date.now();
  const newAccount = await api('/auth/register', {
    method: 'POST',
    body: {
      email: `harness-founder-${stamp}@newco.test`,
      password: 'Quiet-Substation-7714',
      firstName: 'Harness',
      lastName: 'Founder',
      organizationName: `Harness Testing Co ${stamp}`,
      device: {
        installationId: `harness-signup-${stamp}`,
        name: 'Harness',
        platform: 'web',
        osVersion: '1',
        appVersion: '1.0.0',
      },
    },
  });

  check(
    'registration returns 201',
    newAccount.status === 201,
    JSON.stringify(newAccount.body).slice(0, 200),
  );
  check(
    'the creator becomes ADMIN, never SUPER_ADMIN',
    newAccount.body?.data?.user?.role === 'ADMIN',
    `role=${newAccount.body?.data?.user?.role}`,
  );
  check(
    'registration signs the user in atomically',
    typeof newAccount.body?.data?.tokens?.accessToken === 'string',
    'a second call could fail and strand an unreachable account',
  );
  check(
    'a slug is derived from the organisation name',
    /^harness-testing-co-\d+$/.test(newAccount.body?.data?.organization?.slug ?? ''),
    newAccount.body?.data?.organization?.slug,
  );
  check(
    'a starter checklist ships with the workspace',
    typeof newAccount.body?.data?.onboarding?.starterTemplateId === 'string',
    'without one the new admin has nothing to inspect',
  );

  const founderToken = newAccount.body?.data?.tokens?.accessToken;

  // Tenant isolation is the property that matters most here: a brand new
  // organisation must not see one byte of the seeded org's data.
  const founderInspections = await api('/inspections?pageSize=5', { token: founderToken });
  check(
    'a new organisation sees zero inspections from other tenants',
    founderInspections.body?.data?.total === 0,
    `total=${founderInspections.body?.data?.total}`,
  );

  const founderUsers = await api('/users?pageSize=10', { token: founderToken });
  check(
    'a new organisation sees only its own single user',
    founderUsers.body?.data?.total === 1,
    `total=${founderUsers.body?.data?.total}`,
  );

  const founderTemplates = await api('/templates?pageSize=10', { token: founderToken });
  check(
    'the starter checklist is published and immediately usable',
    founderTemplates.body?.data?.total === 1 &&
      founderTemplates.body?.data?.items?.[0]?.activeVersionId !== null,
    `total=${founderTemplates.body?.data?.total}`,
  );

  const duplicate = await api('/auth/register', {
    method: 'POST',
    body: {
      email: `harness-founder-${stamp}@newco.test`,
      password: 'Another-Substation-9921',
      firstName: 'Dup',
      lastName: 'Licate',
      organizationName: 'Duplicate Co',
      device: {
        installationId: `harness-dup-${stamp}`,
        name: 'H',
        platform: 'web',
        osVersion: '1',
        appVersion: '1.0.0',
      },
    },
  });
  check(
    'a duplicate email is refused with a pointer to sign in',
    duplicate.status === 409 && /sign in/i.test(duplicate.body?.error?.message ?? ''),
    `status=${duplicate.status} ${duplicate.body?.error?.message}`,
  );

  const weak = await api('/auth/register', {
    method: 'POST',
    body: {
      email: `harness-weak-${stamp}@newco.test`,
      password: 'password1234',
      firstName: 'Weak',
      lastName: 'Pass',
      organizationName: 'Weak Co',
      device: {
        installationId: `harness-weak-${stamp}`,
        name: 'H',
        platform: 'web',
        osVersion: '1',
        appVersion: '1.0.0',
      },
    },
  });
  check('a common password is refused', weak.status === 422, `status=${weak.status}`);

  // --- templates ----------------------------------------------------------
  section('1. Templates — create, validate, publish');

  const gateId = ulid();
  const dependentId = ulid();

  const created = await api('/templates', {
    method: 'POST',
    token: manager.token,
    body: {
      name: `Harness template ${Date.now()}`,
      category: 'Electrical',
      definition: sampleDefinition(gateId, dependentId),
      requiredSignatures: ['INSPECTOR'],
    },
  });
  check('template created', created.status === 201, JSON.stringify(created.body).slice(0, 250));
  check(
    'first version is a DRAFT, not auto-published',
    created.body?.data?.activeVersionId === null ||
      created.body?.data?.activeVersionId === undefined,
    `activeVersionId=${created.body?.data?.activeVersionId}`,
  );

  const templateId = created.body?.data?.id;
  const draftId = created.body?.data?.draftVersionId;

  // A definition whose logic points at a non-existent question is the failure
  // that silently produces a checklist where a question never appears.
  const danglingRef = await api('/templates', {
    method: 'POST',
    token: manager.token,
    body: {
      name: 'Broken logic template',
      definition: {
        sections: [
          {
            title: 'S',
            fields: [
              {
                key: 'a',
                label: 'A',
                type: 'TEXT',
                options: [],
                validation: {},
                ui: {},
                followUps: [],
                logic: [
                  {
                    id: 'r1',
                    when: {
                      kind: 'CONDITION',
                      condition: { fieldId: ulid(), operator: 'EQUALS', value: 'x' },
                    },
                    effect: { type: 'HIDE' },
                  },
                ],
              },
            ],
            logic: [],
          },
        ],
      },
    },
  });
  check(
    'definition with a dangling logic reference is rejected',
    danglingRef.status === 422,
    `status=${danglingRef.status}`,
  );

  const emptyDefinition = await api('/templates', {
    method: 'POST',
    token: manager.token,
    body: { name: 'Empty', definition: { sections: [] } },
  });
  check(
    'definition with no sections is rejected',
    emptyDefinition.status === 422,
    `status=${emptyDefinition.status}`,
  );

  const cursorBeforePublish = await currentCursor(inspector.token);
  const publish = await api(`/templates/${templateId}/versions/${draftId}/publish`, {
    method: 'POST',
    token: manager.token,
  });
  check('draft publishes', publish.status === 200, JSON.stringify(publish.body).slice(0, 200));
  check('published version carries a timestamp', Boolean(publish.body?.data?.publishedAt));

  const republish = await api(`/templates/${templateId}/versions/${draftId}/publish`, {
    method: 'POST',
    token: manager.token,
  });
  check('publishing twice is refused', republish.status === 409, `status=${republish.status}`);

  // The immutability guarantee — the whole reason versions exist.
  const editPublished = await api(`/templates/${templateId}/versions/${draftId}`, {
    method: 'PATCH',
    token: manager.token,
    body: { changeNote: 'sneaking in an edit' },
  });
  check(
    'a PUBLISHED version cannot be edited',
    editPublished.status === 409,
    `status=${editPublished.status}`,
  );

  // Published templates must reach devices, or inspectors never get the new form.
  const publishDelta = await pullSince(inspector.token, cursorBeforePublish);
  check(
    'published template appears in the sync delta',
    publishDelta.some((c) => c.entityId === draftId),
    'no change-log entry — devices would never receive this checklist',
  );

  section('2. Templates — versioning, clone, export/import');

  const newVersion = await api(`/templates/${templateId}/versions`, {
    method: 'POST',
    token: manager.token,
    body: { changeNote: 'Second revision' },
  });
  check(
    'a new draft version can be created from the published one',
    newVersion.status === 201 && newVersion.body?.data?.version === 2,
    `status=${newVersion.status} version=${newVersion.body?.data?.version}`,
  );

  const editDraft = await api(`/templates/${templateId}/versions/${newVersion.body?.data?.id}`, {
    method: 'PATCH',
    token: manager.token,
    body: { changeNote: 'Editing a draft is allowed' },
  });
  check('a DRAFT version can be edited', editDraft.status === 200, `status=${editDraft.status}`);

  const clone = await api(`/templates/${templateId}/clone`, {
    method: 'POST',
    token: manager.token,
  });
  check('template clones', clone.status === 201, `status=${clone.status}`);
  check('clone is independent of the source', clone.body?.data?.id !== templateId);

  const exported = await api(`/templates/${templateId}/export`, { token: manager.token });
  check('template exports', exported.status === 200, `status=${exported.status}`);
  check(
    'export omits internal ids at the top level',
    !('id' in (exported.body?.template ?? {})),
    JSON.stringify(exported.body?.template ?? {}).slice(0, 120),
  );

  const imported = await api('/templates/import', {
    method: 'POST',
    token: manager.token,
    body: {
      ...exported.body,
      template: { ...exported.body.template, name: 'Imported harness template' },
    },
  });
  check('template imports', imported.status === 201, JSON.stringify(imported.body).slice(0, 200));
  check(
    'import lands as an unpublished draft',
    !imported.body?.data?.activeVersionId,
    `activeVersionId=${imported.body?.data?.activeVersionId}`,
  );
  check(
    'import preserved the question count',
    imported.body?.data?.fieldCount === 2,
    `fieldCount=${imported.body?.data?.fieldCount}`,
  );

  const badFormat = await api('/templates/import', {
    method: 'POST',
    token: manager.token,
    body: { ...exported.body, formatVersion: 99 },
  });
  check(
    'unsupported export format is rejected',
    badFormat.status === 422,
    `status=${badFormat.status}`,
  );

  const inspectorWrite = await api('/templates', {
    method: 'POST',
    token: inspector.token,
    body: { name: 'Should fail', definition: sampleDefinition(ulid(), ulid()) },
  });
  check(
    'inspector cannot author templates',
    inspectorWrite.status === 403,
    `status=${inspectorWrite.status}`,
  );

  // --- users --------------------------------------------------------------
  section('3. Users — administration and privilege escalation defences');

  const usersList = await api('/users?pageSize=10', { token: admin.token });
  check('user list returns 200', usersList.status === 200, `status=${usersList.status}`);
  check(
    'password hash is never returned',
    (usersList.body?.data?.items ?? []).every(
      (u) => !('passwordHash' in u) && !('passwordHistory' in u),
    ),
  );

  const invited = await api('/users', {
    method: 'POST',
    token: admin.token,
    body: {
      email: `harness-${Date.now()}@northwind.test`,
      firstName: 'Harness',
      lastName: 'Invitee',
      role: 'INSPECTOR',
    },
  });
  check(
    'admin can invite a user',
    invited.status === 201,
    JSON.stringify(invited.body).slice(0, 200),
  );
  check(
    'invited user has no password and INVITED status',
    invited.body?.data?.status === 'INVITED',
    `status=${invited.body?.data?.status}`,
  );

  // A manager must not be able to mint an admin — that is self-escalation by
  // proxy, and it is the single most valuable thing to get right here.
  const escalate = await api('/users', {
    method: 'POST',
    token: manager.token,
    body: {
      email: `escalate-${Date.now()}@northwind.test`,
      firstName: 'Should',
      lastName: 'Fail',
      role: 'ADMIN',
    },
  });
  check('a MANAGER cannot create an ADMIN', escalate.status === 403, `status=${escalate.status}`);

  const escalateSuper = await api('/users', {
    method: 'POST',
    token: admin.token,
    body: {
      email: `super-${Date.now()}@northwind.test`,
      firstName: 'Should',
      lastName: 'Fail',
      role: 'SUPER_ADMIN',
    },
  });
  check(
    'an ADMIN cannot create a SUPER_ADMIN',
    escalateSuper.status === 403,
    `status=${escalateSuper.status}`,
  );

  // Queried by role rather than scanned from page one: earlier runs of this
  // harness invite users, and the seeded ADMIN eventually falls off the first
  // page of a createdAt-sorted list.
  const admins = await api('/users?role=ADMIN&pageSize=5', { token: admin.token });
  const adminUserId =
    admins.body?.data?.items?.find((u) => u.id !== admin.userId)?.id ??
    admins.body?.data?.items?.[0]?.id;
  if (adminUserId) {
    const managerTouchesAdmin = await api(`/users/${adminUserId}`, {
      method: 'PATCH',
      token: manager.token,
      body: { jobTitle: 'Demoted' },
    });
    check(
      'a MANAGER cannot modify an ADMIN',
      managerTouchesAdmin.status === 403,
      `status=${managerTouchesAdmin.status}`,
    );
  } else {
    check('an admin user exists to test against', false, 'no ADMIN found');
  }

  const selfEdit = await api(`/users/${admin.userId}`, {
    method: 'PATCH',
    token: admin.token,
    body: { role: 'SUPER_ADMIN' },
  });
  check('a user cannot promote themselves', selfEdit.status === 403, `status=${selfEdit.status}`);

  const badPermission = await api(`/users/${invited.body?.data?.id}`, {
    method: 'PATCH',
    token: admin.token,
    body: { extraPermissions: ['inspection:teleport'] },
  });
  check(
    'unknown permissions are rejected rather than silently stored',
    badPermission.status === 422,
    `status=${badPermission.status}`,
  );

  const roleMeta = await api('/users/meta/roles', { token: admin.token });
  check(
    'role matrix is exposed for the admin UI',
    roleMeta.status === 200 && Array.isArray(roleMeta.body?.data?.roles),
    `status=${roleMeta.status}`,
  );
  check(
    'role matrix marks which roles the caller may assign',
    (roleMeta.body?.data?.roles ?? []).some((r) => r.assignable === false),
  );

  // --- reference data -----------------------------------------------------
  section('4. Reference data');

  const cursorBeforeClient = await currentCursor(inspector.token);
  const client = await api('/clients', {
    method: 'POST',
    token: manager.token,
    body: { name: `Harness Client ${Date.now()}`, code: `HC-${Date.now()}-${seq}` },
  });
  check('client created', client.status === 201, JSON.stringify(client.body).slice(0, 200));

  // Reference data is replicated; without a change-log entry an inspector
  // cannot select the new client offline.
  const clientDelta = await pullSince(inspector.token, cursorBeforeClient);
  check(
    'new client reaches devices via the sync delta',
    clientDelta.some((c) => c.entityId === client.body?.data?.id),
    'no change-log entry',
  );

  const project = await api('/projects', {
    method: 'POST',
    token: manager.token,
    body: { name: 'Harness Project', code: `HP-${Date.now()}`, clientId: client.body?.data?.id },
  });
  check(
    'project created with a valid client reference',
    project.status === 201,
    JSON.stringify(project.body).slice(0, 200),
  );

  const crossTenant = await api('/projects', {
    method: 'POST',
    token: manager.token,
    body: { name: 'Bad ref', code: `BR-${Date.now()}`, clientId: ulid() },
  });
  check(
    'a non-existent client reference is rejected',
    crossTenant.status === 422,
    `status=${crossTenant.status}`,
  );

  const badDates = await api('/projects', {
    method: 'POST',
    token: manager.token,
    body: {
      name: 'Bad dates',
      code: `BD-${Date.now()}`,
      startDate: '2026-12-01T00:00:00.000Z',
      endDate: '2026-01-01T00:00:00.000Z',
    },
  });
  check(
    'an end date before the start date is rejected',
    badDates.status === 422,
    `status=${badDates.status}`,
  );

  const geofenceNoCoords = await api('/sites', {
    method: 'POST',
    token: manager.token,
    body: { name: 'No coords', geofenceRadiusMeters: 100 },
  });
  check(
    'a geofence without coordinates is rejected as meaningless',
    geofenceNoCoords.status === 422,
    `status=${geofenceNoCoords.status}`,
  );

  const site = await api('/sites', {
    method: 'POST',
    token: manager.token,
    body: { name: 'Harness Site', latitude: 51.5, longitude: -0.1, geofenceRadiusMeters: 150 },
  });
  check(
    'site created with coordinates and geofence',
    site.status === 201,
    JSON.stringify(site.body).slice(0, 200),
  );

  const cursorBeforeDelete = await currentCursor(inspector.token);
  const deleted = await api(`/sites/${site.body?.data?.id}`, {
    method: 'DELETE',
    token: admin.token,
  });
  check('site soft-deletes', deleted.status === 204, `status=${deleted.status}`);

  const tombstoneDelta = await pullSince(inspector.token, cursorBeforeDelete);
  check(
    'deletion propagates as a tombstone, not a silent disappearance',
    tombstoneDelta.some((c) => c.entityId === site.body?.data?.id && c.operation === 'DELETE'),
    'no DELETE entry — offline devices would keep showing a deleted site',
  );

  const inspectorWritesClient = await api('/clients', {
    method: 'POST',
    token: inspector.token,
    body: { name: 'Should fail' },
  });
  check(
    'inspector cannot create clients',
    inspectorWritesClient.status === 403,
    `status=${inspectorWritesClient.status}`,
  );

  // --- analytics ----------------------------------------------------------
  section('5. Analytics');

  const summary = await api('/analytics/summary', { token: admin.token });
  check('summary returns 200', summary.status === 200, `status=${summary.status}`);
  check('summary reports a total', typeof summary.body?.data?.total === 'number');
  check(
    'rates are bounded percentages',
    summary.body?.data?.completionRate >= 0 &&
      summary.body?.data?.completionRate <= 100 &&
      summary.body?.data?.failureRate >= 0 &&
      summary.body?.data?.failureRate <= 100,
    `completion=${summary.body?.data?.completionRate} failure=${summary.body?.data?.failureRate}`,
  );
  check('an empty period yields 0, never NaN', Number.isFinite(summary.body?.data?.completionRate));

  const trend = await api('/analytics/trend?period=MONTHLY', { token: admin.token });
  check(
    'trend returns buckets',
    trend.status === 200 && Array.isArray(trend.body?.data),
    `status=${trend.status}`,
  );
  check(
    'bucket counts are numbers, not BigInt strings',
    (trend.body?.data ?? []).every((b) => typeof b.total === 'number'),
  );

  const inspectors = await api('/analytics/inspectors', { token: admin.token });
  check(
    'inspector performance returns 200',
    inspectors.status === 200,
    `status=${inspectors.status}`,
  );

  const sites = await api('/analytics/sites', { token: admin.token });
  check('site statistics return 200', sites.status === 200, `status=${sites.status}`);

  const heatmap = await api('/analytics/heatmap', { token: admin.token });
  check('heat map returns 200', heatmap.status === 200, `status=${heatmap.status}`);

  const scoped = await api('/analytics/inspectors', { token: inspector.token });
  check('inspector denied org-wide analytics', scoped.status === 403, `status=${scoped.status}`);

  const badRange = await api(
    '/analytics/summary?from=2026-12-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
    {
      token: admin.token,
    },
  );
  check('an inverted date range is rejected', badRange.status === 422, `status=${badRange.status}`);

  const csv = await fetch(`${BASE}/analytics/export/inspections.csv`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  const csvBytes = new Uint8Array(await csv.arrayBuffer());
  const csvText = new TextDecoder('utf-8').decode(csvBytes);
  check('CSV export returns 200', csv.status === 200, `status=${csv.status}`);
  check(
    'CSV carries the expected header',
    csvText.includes('Number,Title,Template'),
    csvText.slice(0, 80),
  );
  // Checked on the raw bytes: TextDecoder strips a leading BOM during decode,
  // so a string-level assertion can never see it even when it is sent.
  check(
    'CSV is UTF-8 BOM prefixed for Excel',
    csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    `first bytes: ${Array.from(csvBytes.slice(0, 3))
      .map((b) => b.toString(16))
      .join(' ')}`,
  );

  // --- audit --------------------------------------------------------------
  section('6. Audit and monitoring');

  const audit = await api('/admin/audit-logs?pageSize=10', { token: admin.token });
  check(
    'audit log returns entries',
    audit.status === 200 && audit.body?.data?.total > 0,
    `status=${audit.status} total=${audit.body?.data?.total}`,
  );

  const auditDenied = await api('/admin/audit-logs', { token: inspector.token });
  check(
    'inspector denied audit access',
    auditDenied.status === 403,
    `status=${auditDenied.status}`,
  );

  const health = await api('/admin/sync-health', { token: admin.token });
  check(
    'sync health returns fleet state',
    health.status === 200 && typeof health.body?.data?.serverCursor === 'number',
    `status=${health.status}`,
  );
  check(
    'sync health reports how far each device is behind',
    (health.body?.data?.devices ?? []).every((d) => typeof d.behind === 'number'),
  );

  const org = await api('/admin/organization', { token: admin.token });
  check('organisation settings readable', org.status === 200, `status=${org.status}`);

  // A partial settings PATCH must merge, not replace — otherwise sending one
  // toggle silently wipes the password policy.
  const beforePolicy = org.body?.data?.settings?.passwordPolicy?.minLength;
  const patched = await api('/admin/organization', {
    method: 'PATCH',
    token: admin.token,
    body: { settings: { wifiOnlyMediaSync: false } },
  });
  check('settings patch succeeds', patched.status === 200, `status=${patched.status}`);
  check(
    'partial settings patch merges rather than replacing',
    patched.body?.data?.settings?.passwordPolicy?.minLength === beforePolicy,
    `before=${beforePolicy} after=${patched.body?.data?.settings?.passwordPolicy?.minLength}`,
  );
  check(
    'the patched value actually changed',
    patched.body?.data?.settings?.wifiOnlyMediaSync === false,
  );

  const settingsDenied = await api('/admin/organization', {
    method: 'PATCH',
    token: manager.token,
    body: { name: 'Should fail' },
  });
  check(
    'manager denied organisation settings',
    settingsDenied.status === 403,
    `status=${settingsDenied.status}`,
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
