/**
 * Minimal environment for the unit run.
 *
 * Some pure units — the error taxonomy, the Sentry scrubber — sit in modules
 * that transitively import `apps/backend/src/config/env.ts`, which validates a
 * full configuration at first import and exits if anything is missing. Without
 * this the files fail to import, and vitest reports a file that fails to import
 * as *zero tests* rather than as a failure inside it: the summary line stays
 * green while the file never runs.
 *
 * These values are deliberately syntactic placeholders. Nothing in the unit run
 * opens a socket — no Postgres, no Redis, no SMTP — so they only have to
 * satisfy the schema. `npm test` stays runnable on a laptop with no services,
 * which is the whole point of keeping it separate from the integration run.
 */

const PLACEHOLDERS: Record<string, string> = {
  NODE_ENV: 'test',
  // Never connected to. A syntactically valid URL is all the schema asks for.
  DATABASE_URL: 'postgresql://unit:unit@127.0.0.1:5432/orbit_unit_placeholder?schema=public',
  DIRECT_URL: 'postgresql://unit:unit@127.0.0.1:5432/orbit_unit_placeholder?schema=public',
  REDIS_URL: 'redis://127.0.0.1:6379/15',
  // Distinct from each other, because the config refuses equal signing keys.
  JWT_ACCESS_SECRET: 'unit_access_secret_0123456789abcdef0123456789abcdef',
  JWT_REFRESH_SECRET: 'unit_refresh_secret_fedcba9876543210fedcba9876543210',
  OTP_SECRET: 'unit_otp_secret_a1b2c3d4e5f60718293a4b5c6d7e8f90',
  LOG_LEVEL: 'fatal',
};

for (const [key, value] of Object.entries(PLACEHOLDERS)) {
  process.env[key] ??= value;
}
