/**
 * Security audit of a running deployment.
 *
 * Everything here is checked against the live service rather than the source,
 * because the failures that matter are configuration failures. This project has
 * already shipped one: `ALLOW_SELF_SERVICE_SIGNUP=false` was set correctly and
 * parsed as `true`, leaving public registration open on an install explicitly
 * configured to refuse it. Reading the code would not have caught it; a request
 * did.
 *
 * Read-only apart from one deliberate registration attempt, which is refused on
 * a correctly configured install. If it succeeds, the audit reports it as a
 * critical finding and tells you what to delete.
 *
 *   ORBIT_API_URL=https://…/api/v1 ORBIT_CONSOLE_URL=https://… \
 *   node scripts/security-audit.mjs
 *
 * Exit codes: 0 clean, 1 findings, 2 bad invocation.
 */

const API = process.env.ORBIT_API_URL ?? process.argv[2];
const CONSOLE_URL = process.env.ORBIT_CONSOLE_URL ?? process.argv[3];

if (!API) {
  console.error('ORBIT_API_URL is required, e.g. https://orbit-field-api.vercel.app/api/v1');
  process.exit(2);
}

const ORIGIN = API.replace(/\/api\/v1$/, '');
const findings = [];
let checks = 0;

function ok(name) {
  checks += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
}

function finding(severity, name, detail) {
  checks += 1;
  findings.push({ severity, name, detail });
  const colour =
    severity === 'critical' ? '\x1b[31m' : severity === 'high' ? '\x1b[33m' : '\x1b[36m';
  console.log(`  ${colour}✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function request(path, options = {}) {
  const response = await fetch((options.absolute ? ORIGIN : API) + path, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body, headers: response.headers };
}

async function main() {
  console.log('\x1b[1mOrbit Field — security audit\x1b[0m');
  console.log(`Target: ${API}\n`);

  /*
   * --- registration ---------------------------------------------------------
   *
   * Open registration is a posture, not automatically a defect: some
   * installations want anyone to be able to start a workspace. So the audit
   * takes the intended posture as input and reports a *mismatch*, rather than
   * insisting on one answer. An audit that is permanently red on a deliberate
   * choice is an audit people stop reading.
   *
   * The probe that follows only runs when signup is supposed to be closed. It
   * creates a real organisation when it succeeds, so running it against an
   * install with signup open would litter production with a tenant on every
   * audit — the check would become the thing that needed cleaning up.
   */
  section('Public registration');
  const expectOpen = /^(1|true|yes|on)$/i.test(process.env.ORBIT_EXPECT_OPEN_SIGNUP ?? '');
  const available = await request('/auth/signup-available');
  const isOpen = available.body?.data?.available;

  if (isOpen === expectOpen) {
    ok(`self-service signup is ${isOpen ? 'open, as configured' : 'disabled'}`);
    if (isOpen) {
      console.log(
        '      anyone who reaches this URL can create an organisation and sign in.\n' +
          '      Set ALLOW_SELF_SERVICE_SIGNUP=false to close it.',
      );
    }
  } else if (isOpen) {
    finding('high', 'self-service signup is enabled', 'anyone can create a tenant');
  } else {
    finding('medium', 'self-service signup is disabled', 'this deployment expected it to be open');
  }

  if (!isOpen) {
    // Only safe to attempt when the answer should be "no": a success here means
    // a tenant now exists.
    const probeEmail = `audit-probe-${Date.now()}@invalid.test`;
    const registered = await request('/auth/register', {
      method: 'POST',
      body: {
        email: probeEmail,
        password: `Aud${Date.now().toString(36)}Xy1`,
        firstName: 'Audit',
        lastName: 'Probe',
        organizationName: `Audit Probe ${Date.now()}`,
        device: {
          installationId: `audit-${Date.now()}`,
          name: 'Audit',
          platform: 'web',
          osVersion: '1',
          appVersion: '1.0.0',
        },
      },
    });
    if (registered.status === 403) {
      ok('registration endpoint refuses (403)');
    } else if (registered.status === 201) {
      // The endpoint contradicted `/auth/signup-available`, which is worse than
      // either posture: the console decides whether to show its "Create
      // account" tab from that endpoint.
      finding(
        'critical',
        'registration SUCCEEDED while reporting itself closed',
        `a tenant was created for ${probeEmail} — delete it now`,
      );
    } else {
      ok(`registration refused (${registered.status})`);
    }
  }

  // --- authentication -------------------------------------------------------
  section('Authentication');
  const noToken = await request('/users');
  if (noToken.status === 401) {
    ok('unauthenticated request refused');
  } else {
    finding('critical', 'unauthenticated request not refused', `got ${noToken.status}`);
  }

  const badToken = await request('/users', { headers: { Authorization: 'Bearer nonsense' } });
  if (badToken.status === 401) {
    ok('malformed token refused');
  } else {
    finding('critical', 'malformed token accepted', `got ${badToken.status}`);
  }

  // A token with alg=none is the classic JWT bypass; the library must reject it.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: 'x', role: 'SUPER_ADMIN', exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const forged = await request('/users', {
    headers: { Authorization: `Bearer ${header}.${payload}.` },
  });
  if (forged.status === 401) {
    ok('alg=none forgery refused');
  } else {
    finding('critical', 'alg=none forgery accepted', `got ${forged.status}`);
  }

  // --- transport and headers ------------------------------------------------
  section('Transport and headers');
  const health = await request('/health', { absolute: true });
  const root = await fetch(`${ORIGIN}/health`);

  const hsts = root.headers.get('strict-transport-security');
  if (hsts?.includes('max-age')) {
    ok('HSTS present');
  } else {
    finding('high', 'HSTS missing', String(hsts));
  }

  if (root.headers.get('x-content-type-options') === 'nosniff') {
    ok('X-Content-Type-Options: nosniff');
  } else {
    finding('medium', 'X-Content-Type-Options missing');
  }

  const poweredBy = root.headers.get('x-powered-by');
  if (poweredBy) {
    finding('low', 'x-powered-by leaks the framework', poweredBy);
  } else {
    ok('no x-powered-by header');
  }

  if (health.status !== 200) {
    finding('high', 'health endpoint not returning 200', `got ${health.status}`);
  }

  // --- CORS -----------------------------------------------------------------
  section('CORS');
  if (CONSOLE_URL) {
    const good = await fetch(`${API}/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: CONSOLE_URL, 'Access-Control-Request-Method': 'POST' },
    });
    if (good.headers.get('access-control-allow-origin') === CONSOLE_URL) {
      ok('console origin allowed');
    } else {
      finding('high', 'console origin not allowed', 'the browser app cannot call the API');
    }
  }

  const evil = await fetch(`${API}/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'POST' },
  });
  const echoed = evil.headers.get('access-control-allow-origin');
  if (!echoed || echoed === 'null') {
    ok('unknown origin not echoed');
  } else {
    finding('critical', 'CORS echoes any origin', `echoed ${echoed}`);
  }

  // --- rate limiting --------------------------------------------------------
  section('Rate limiting');
  const limited = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (limited.headers.get('ratelimit')) {
    ok(`rate limiting active (${limited.headers.get('ratelimit')})`);
  } else {
    finding('high', 'no rate-limit headers', 'auth endpoints may be unthrottled');
  }

  // --- storage --------------------------------------------------------------
  section('Storage');
  const anonymous = await request('/uploads/attachments/01AUDITPROBE00000000000001/content');
  if (anonymous.status === 401) {
    ok('attachment content requires authentication');
  } else {
    finding('critical', 'attachment content reachable without auth', `got ${anonymous.status}`);
  }

  // --- console --------------------------------------------------------------
  if (CONSOLE_URL) {
    section('Console');
    const page = await fetch(CONSOLE_URL);
    const csp = page.headers.get('content-security-policy') ?? '';

    if (csp.includes("default-src 'self'")) {
      ok("CSP default-src 'self'");
    } else {
      finding('high', 'CSP missing or permissive default-src');
    }
    if (csp.includes('unsafe-eval')) {
      finding('high', "CSP allows 'unsafe-eval'");
    } else {
      ok("CSP does not allow 'unsafe-eval'");
    }
    if (csp.includes("frame-ancestors 'none'")) {
      ok('CSP forbids framing');
    } else {
      finding('medium', 'CSP allows framing', 'clickjacking risk');
    }
    if (csp.includes(ORIGIN)) {
      ok('CSP connect-src pins the API origin');
    } else {
      finding('high', 'CSP connect-src does not include the API', 'calls will be blocked');
    }
  }

  // --- summary --------------------------------------------------------------
  const bySeverity = (s) => findings.filter((f) => f.severity === s).length;
  console.log(`\n\x1b[1m${checks - findings.length}/${checks} checks passed\x1b[0m`);

  if (findings.length === 0) {
    console.log('\x1b[32mNo findings.\x1b[0m');
    return;
  }

  console.log(
    `\ncritical ${bySeverity('critical')}  high ${bySeverity('high')}  ` +
      `medium ${bySeverity('medium')}  low ${bySeverity('low')}`,
  );
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n\x1b[31mAudit error:\x1b[0m ${err.message}`);
  process.exit(1);
});
