/**
 * Security middleware beyond what Helmet covers.
 *
 * A note on CSRF: this API takes bearer tokens from an `Authorization` header
 * and sets no auth cookies. Browsers do not attach an `Authorization` header
 * cross-origin, so classic CSRF is structurally impossible — there is no
 * ambient credential to ride. Adding a synchroniser token would be cargo cult.
 *
 * What *is* possible is a cross-origin form or `fetch` reaching a state-changing
 * endpoint and relying on a permissive CORS policy, so the defence here is
 * origin validation on unsafe methods plus content-type enforcement, which is
 * the actual threat this shape of API faces.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import type { NextFunction, Request, Response } from 'express';

import { corsOrigins, env, isProduction, originAllowed } from '../config/env.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Reject state-changing requests from an unexpected origin.
 *
 * Only enforced when an allowlist is configured — with `CORS_ORIGINS=*` there is
 * nothing to compare against, and production refuses to start with that value
 * anyway (see `config/env.ts`).
 */
export function originGuard(req: Request, _res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  if (corsOrigins === true) return next();

  const origin = req.header('origin');

  // No Origin header at all means a non-browser client: a mobile app, curl, or
  // a server-to-server call. Those carry a bearer token and are not subject to
  // the confused-deputy problem this guard addresses.
  if (!origin) return next();

  if (!originAllowed(origin)) {
    throw new AppError(
      ErrorCode.PERMISSION_DENIED,
      'This request came from an origin that is not permitted.',
    );
  }

  next();
}

/**
 * Require JSON on requests that carry a body.
 *
 * `application/x-www-form-urlencoded` and `multipart/form-data` are the two
 * content types an HTML form can send cross-origin without a preflight. Refusing
 * them on the API means a hidden form on an attacker's page cannot reach a
 * state-changing endpoint even if an origin check were somehow bypassed.
 */
export function requireJsonBody(req: Request, _res: Response, next: NextFunction): void {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const length = req.header('content-length');
  if (!length || length === '0') return next();

  const contentType = req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new AppError(
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      'This endpoint accepts application/json only.',
    );
  }

  next();
}

/**
 * Headers Helmet does not set, or sets differently than this API wants.
 */
export function extraSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  // No browser feature this API serves needs any of these.
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );

  // API responses are never a document; this stops a downloaded JSON body being
  // rendered as HTML in an old browser.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

  // Nothing the API returns should ever be cached by an intermediary: responses
  // are per-user and frequently carry inspection data.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');

  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}

/**
 * Reject absurdly long URLs and header sets.
 *
 * Express has no default ceiling on query-string length, and a multi-megabyte
 * URL is never legitimate here — it is either a scanner or an attempt to blow
 * up a log pipeline downstream.
 */
export function requestSanity(req: Request, _res: Response, next: NextFunction): void {
  if (req.originalUrl.length > 4096) {
    throw new AppError(ErrorCode.MALFORMED_REQUEST, 'The request URL is too long.');
  }

  // A null byte in a path or query is never valid and is a classic bypass
  // attempt against downstream string handling.
  if (req.originalUrl.includes('\0')) {
    throw new AppError(ErrorCode.MALFORMED_REQUEST, 'The request contains an invalid character.');
  }

  next();
}

/**
 * Startup secret validation.
 *
 * `config/env.ts` already enforces length and distinctness. This catches the
 * remaining case: a real deployment running with a value copied from
 * `.env.example`, which passes every length check and is published in the
 * repository.
 */
const KNOWN_PLACEHOLDERS = [
  'replace-me',
  'change-me',
  'dev_access_secret',
  'dev_refresh_secret',
  'dev_otp_secret',
  'ci_access_secret',
  'ci_refresh_secret',
  'ci_otp_secret',
  'orbit_dev_password',
];

export function assertProductionSecrets(): void {
  if (!isProduction) return;

  const secrets: Array<[string, string]> = [
    ['JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET],
    ['JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET],
    ['OTP_SECRET', env.OTP_SECRET],
  ];

  const offenders: string[] = [];

  for (const [name, value] of secrets) {
    const lower = value.toLowerCase();
    if (KNOWN_PLACEHOLDERS.some((placeholder) => lower.includes(placeholder))) {
      offenders.push(`${name} still contains a placeholder value`);
    }
    // Roughly: a secret built from a handful of repeated characters has far
    // less entropy than its length suggests.
    if (new Set(value).size < 12) {
      offenders.push(`${name} has too little variety to be a real secret`);
    }
  }

  if (env.DATABASE_URL.includes('orbit_dev_password')) {
    offenders.push('DATABASE_URL still uses the development password');
  }

  if (offenders.length > 0) {
    // Refusing to boot is correct: a production API signing tokens with a
    // published secret is worse than a production API that is down.
    console.error('Refusing to start with insecure configuration:');
    for (const offender of offenders) console.error(`  - ${offender}`);
    process.exit(1);
  }
}
