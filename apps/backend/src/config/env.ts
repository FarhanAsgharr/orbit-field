/**
 * Environment configuration.
 *
 * Validated once at boot and then frozen. A misconfigured secret should crash
 * the process on startup, not surface as a 500 three hours later when the first
 * token needs signing.
 */

import { z } from 'zod';

/**
 * A boolean that actually reads "false" as false.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and environment variables are
 * always strings — so every non-empty value becomes `true`, "false" and "0"
 * included. That is not a cosmetic wart: `ALLOW_SELF_SERVICE_SIGNUP=false`
 * parsed as `true` and left public registration open on an installation
 * explicitly configured to refuse it, which is how a stranger creates a tenant
 * inside someone's compliance system.
 *
 * Unrecognised values are rejected rather than guessed. A typo in a security
 * toggle must fail the boot, not pick a default.
 */
const boolish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') return value;
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalised)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a boolean (true/false/1/0/yes/no/on/off), received "${value}"`,
      });
      return z.NEVER;
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  API_PREFIX: z.string().default('/api/v1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // 32+ bytes of entropy. Short secrets make HS256 brute-forceable offline.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('orbit-field'),
  JWT_AUDIENCE: z.string().default('orbit-field-clients'),
  // Short-lived by design: a leaked access token expires before it is useful,
  // and offline devices rely on the refresh token, not this one.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  REMEMBER_ME_TTL_DAYS: z.coerce.number().int().positive().default(180),

  OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters'),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),

  // Object storage for attachments and generated reports.
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: boolish(false),

  UPLOAD_CHUNK_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  UPLOAD_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(500 * 1024 * 1024),

  // Sync tuning.
  SYNC_PUSH_MAX_OPERATIONS: z.coerce.number().int().positive().default(500),
  SYNC_PULL_MAX_CHANGES: z.coerce.number().int().positive().default(1000),
  // Devices offline longer than this must re-bootstrap, because the change log
  // has been pruned past their cursor.
  SYNC_CHANGELOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SYNC_IDEMPOTENCY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // The sync and upload limiters were hardcoded, so an operator whose fleet
  // legitimately exceeded them had no way to raise them short of a code change
  // and a redeploy. Defaults are the values they previously had.
  SYNC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  MAX_FAILED_LOGINS: z.coerce.number().int().positive().default(5),
  ACCOUNT_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  /**
   * Whether anyone may create an organisation from the sign-in screen.
   *
   * Enabled by default for development and evaluation. A production deployment
   * for a single customer usually wants this off, so accounts are only created
   * by invitation from an existing administrator — an open signup on a
   * compliance system lets a stranger create a tenant inside your install.
   */
  ALLOW_SELF_SERVICE_SIGNUP: boolish(true),

  CORS_ORIGINS: z.string().default('*'),
  TRUST_PROXY: boolish(false),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Orbit Field <no-reply@orbitfield.app>'),

  EXPO_ACCESS_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Deliberately not using the logger: it is not configured yet, and a
    // config failure must be readable in a bare container log.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }

  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      console.error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ in production.');
      process.exit(1);
    }
    if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID)) {
      console.error('S3 storage selected but S3_BUCKET / S3_ACCESS_KEY_ID are missing.');
      process.exit(1);
    }
    if (env.CORS_ORIGINS === '*') {
      console.error('CORS_ORIGINS must be an explicit allowlist in production.');
      process.exit(1);
    }
  }

  return Object.freeze(env);
}

export const env: Env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins: string[] | true =
  env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim());
