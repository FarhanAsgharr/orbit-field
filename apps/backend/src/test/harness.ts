/**
 * Integration test harness.
 *
 * These tests drive the real Express app through supertest against a real
 * Postgres and a real Redis. Nothing is mocked below the HTTP boundary: the
 * router, the validation middleware, the RBAC checks, Prisma and the rate-limit
 * store all run exactly as they do in production. That is the point — the
 * defects this project has actually shipped (a boolean env parsed as its
 * opposite, an unhandled rejection in a route, a NOT NULL constraint nobody hit
 * until a real device synced) all live below the unit-test line and above the
 * end-to-end one.
 *
 * Three rules make the suite trustworthy:
 *
 *  1. **A separate database.** `orbit_test`, never the development or
 *     production one. The harness refuses to run if the URL does not name it.
 *  2. **Fresh data per test file.** Every fixture is created under a unique
 *     organisation and torn down afterwards, so files can run in any order and
 *     a failure never leaves state behind that breaks the next run.
 *  3. **Real credentials, generated per run.** Passwords are random, so no test
 *     can accidentally depend on a value that also exists in production.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '../..');

/**
 * The test database URL.
 *
 * Read from `TEST_DATABASE_URL` so CI can point elsewhere, but always checked:
 * these tests truncate tables, and pointing them at a database with real data
 * would destroy it. The name check is crude and deliberate — a mistake here is
 * unrecoverable, so it fails closed.
 */
export function testDatabaseUrl(): string {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://orbit:orbit_dev_password@localhost:55432/orbit_test?schema=public';

  if (!/\/orbit_test(\?|$)/.test(url)) {
    throw new Error(
      `Refusing to run integration tests against "${url}". The database must be named ` +
        'orbit_test — this suite truncates tables and would destroy anything else.',
    );
  }
  return url;
}

export function testRedisUrl(): string {
  return process.env.TEST_REDIS_URL ?? 'redis://localhost:56379';
}

/**
 * Configure the environment before anything imports `config/env`.
 *
 * `env.ts` validates and freezes at first import, so every variable has to be
 * in place before the app module graph is touched. Vitest's `setupFiles` runs
 * before the test module is imported, which is the only window where this
 * works.
 */
export function configureTestEnvironment(): void {
  const secret = (label: string) => `test-${label}-${'x'.repeat(40)}`;

  process.env.NODE_ENV = 'test';
  // The app logs every request at info; across hundreds of integration requests
  // that buries the actual assertion failures in the output.
  process.env.LOG_LEVEL = 'fatal';
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.DIRECT_URL = testDatabaseUrl();
  process.env.REDIS_URL = testRedisUrl();
  process.env.JWT_ACCESS_SECRET = secret('access');
  process.env.JWT_REFRESH_SECRET = secret('refresh');
  process.env.OTP_SECRET = secret('otp');
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_PATH = path.join(backendRoot, '.test-storage');
  process.env.CORS_ORIGINS = '*';
  process.env.TRUST_PROXY = 'false';
  process.env.ALLOW_SELF_SERVICE_SIGNUP = 'true';
  // High enough that a test suite issuing dozens of logins in a second is not
  // throttled by the limiter it is not trying to test. The limiter has its own
  // dedicated test that sets this down deliberately.
  process.env.RATE_LIMIT_MAX_REQUESTS = '100000';
  process.env.AUTH_RATE_LIMIT_MAX = '100000';
}

/** Apply migrations to the test database. Idempotent; safe to call per run. */
export function migrateTestDatabase(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl(), DIRECT_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}

/** A value no other test will collide with, safe inside an email local part. */
export function unique(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}

/**
 * A password that satisfies the production policy.
 *
 * Random per call so a test can never depend on a literal that also exists in
 * a real deployment, and long enough to clear the 12-character minimum with the
 * required character classes.
 */
export function strongPassword(): string {
  return `Tst${randomBytes(9).toString('hex')}A1`;
}
