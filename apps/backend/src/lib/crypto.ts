/**
 * Cryptographic primitives.
 *
 * Argon2id for passwords (memory-hard, resists GPU cracking in a way bcrypt no
 * longer really does), HMAC-SHA256 for OTP and token storage, and constant-time
 * comparison everywhere a secret is checked.
 */

import argon2 from 'argon2';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import type { PasswordPolicy } from '@orbit/types';

/**
 * OWASP's 2024 baseline for Argon2id: 19 MiB, 2 iterations, 1 degree of
 * parallelism. Raising memory is the meaningful lever; raising iterations costs
 * server CPU for less attacker pain.
 */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // A malformed stored hash must read as "wrong password", never as an error
    // that could be distinguished by an attacker probing for valid accounts.
    return false;
  }
}

/**
 * Constant-time-ish dummy verification.
 *
 * Called when the email does not exist, so a login attempt against an unknown
 * account takes the same wall-clock time as one against a real account. Without
 * it, response timing enumerates your entire user list.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$3g2Zb0nJZfPfV4KcQ0pQ6xN5r1nHqXG8kM2wYtLp0Zc';

export async function dummyVerify(plain: string): Promise<void> {
  await argon2.verify(DUMMY_HASH, plain).catch(() => false);
}

/** SHA-256 hex digest. Used for attachment checksums and token storage. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Keyed digest for OTP codes, so a database dump does not reveal live codes. */
export function hmac(input: string, secret: string = env.OTP_SECRET): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing digests of equal size sidesteps that.
  if (bufA.length !== bufB.length) {
    const digestA = createHash('sha256').update(bufA).digest();
    const digestB = createHash('sha256').update(bufB).digest();
    timingSafeEqual(digestA, digestB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** URL-safe random token, e.g. for refresh tokens and action tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Numeric OTP with uniform distribution — `Math.random()` is not acceptable here. */
export function generateOtp(length: number = env.OTP_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString();
  return code;
}

export interface PasswordStrengthResult {
  valid: boolean;
  errors: string[];
  /** 0..4, for the strength meter in the UI. */
  score: number;
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', '12345678', '123456789', 'qwerty123', 'letmein',
  'welcome1', 'admin123', 'iloveyou', 'sunshine', 'password123', 'abc12345',
  'inspector', 'orbitfield', 'changeme', 'p@ssw0rd',
]);

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
  historyDepth: 5,
  maxAgeDays: 0,
};

/** Policy check plus a coarse strength estimate. */
export function checkPasswordStrength(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  context: { email?: string; firstName?: string; lastName?: string } = {},
): PasswordStrengthResult {
  const errors: string[] = [];

  if (password.length < policy.minLength) {
    errors.push(`Password must be at least ${policy.minLength} characters.`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain an uppercase letter.');
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain a lowercase letter.');
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    errors.push('Password must contain a number.');
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    errors.push('Password must contain a symbol.');
  }

  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    errors.push('This password is too common.');
  }

  // Personal information in a password defeats the point of length rules.
  for (const [label, value] of Object.entries(context)) {
    if (!value || value.length < 3) continue;
    if (lower.includes(value.toLowerCase().split('@')[0]!)) {
      errors.push(`Password must not contain your ${label}.`);
      break;
    }
  }

  if (/^(.)\1+$/.test(password)) errors.push('Password must not be a single repeated character.');
  if (/^(?:0123|1234|2345|abcd|qwer)/i.test(password)) {
    errors.push('Password must not begin with a common sequence.');
  }

  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  return { valid: errors.length === 0, errors, score: Math.min(4, score) };
}

/** Check a candidate against stored history hashes. */
export async function isPasswordReused(
  candidate: string,
  history: string[],
  depth: number,
): Promise<boolean> {
  for (const hash of history.slice(0, depth)) {
    if (await verifyPassword(hash, candidate)) return true;
  }
  return false;
}
