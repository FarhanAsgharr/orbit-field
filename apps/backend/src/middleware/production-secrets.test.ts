/**
 * The startup guard against shipping with a published secret.
 *
 * `config/env.ts` already enforces length and distinctness, and a value copied
 * out of `.env.example` passes both — it is long, and the three secrets differ
 * from each other. It is also in the repository, so anyone can mint an
 * administrator token for that deployment.
 *
 * The guard's only correct response is to refuse to boot. A production API that
 * is down gets noticed in minutes; a production API signing tokens with a
 * published secret does not get noticed at all.
 *
 * `config/env.ts` freezes its values at first import and `isProduction` is
 * derived from them, so the module is mocked and the subject re-imported per
 * case. That is the only way to exercise a branch that exists solely for a
 * production process.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const REAL_SECRET_A = 'f3a91c07be24d5810f6e2b47ac93d05e18cf7b62a940e3d5c81b7f2604ae9d13';
const REAL_SECRET_B = '7b25ef09d4a1c6837f0e5b92da48c17036be9f5a2d81c40739af6be215d0c8a4';
const REAL_SECRET_C = '9c40ad72e1b5f3806da29c47fb18e6503a7d2f9b8c614e0572ad3fb190e6c852';

/** Load `assertProductionSecrets` against a mocked environment. */
async function withEnv(overrides: Record<string, unknown>, isProduction = true) {
  vi.resetModules();
  vi.doMock('../config/env.js', () => ({
    isProduction,
    corsOrigins: true,
    originAllowed: () => true,
    env: {
      JWT_ACCESS_SECRET: REAL_SECRET_A,
      JWT_REFRESH_SECRET: REAL_SECRET_B,
      OTP_SECRET: REAL_SECRET_C,
      DATABASE_URL: 'postgresql://orbit:s3cure@db.example.com:5432/orbit',
      ...overrides,
    },
  }));

  const module = await import('./security.js');
  return module.assertProductionSecrets;
}

/** Run the guard, capturing whether it tried to exit and what it complained about. */
function run(assert: () => void) {
  const messages: string[] = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);

  let exited = false;
  try {
    assert();
  } catch (err) {
    if ((err as Error).message !== 'process.exit') throw err;
    exited = true;
  } finally {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exited, output: messages.join('\n') };
}

afterEach(() => {
  vi.doUnmock('../config/env.js');
  vi.resetModules();
});

describe('outside production', () => {
  it('does nothing at all, so a development machine is never blocked', async () => {
    const assert = await withEnv({ JWT_ACCESS_SECRET: 'dev_access_secret' }, false);
    expect(run(assert).exited).toBe(false);
  });
});

describe('in production', () => {
  it('starts normally with real secrets', async () => {
    const assert = await withEnv({});
    const { exited } = run(assert);
    expect(exited).toBe(false);
  });

  it.each([
    ['JWT_ACCESS_SECRET', 'dev_access_secret'],
    ['JWT_REFRESH_SECRET', 'dev_refresh_secret'],
    ['OTP_SECRET', 'dev_otp_secret'],
  ])('refuses to boot when %s is the example value', async (name, value) => {
    const assert = await withEnv({ [name]: value });
    const { exited, output } = run(assert);

    expect(exited).toBe(true);
    expect(output).toContain(name);
    expect(output).toMatch(/placeholder/i);
  });

  it('catches a placeholder embedded in a longer string', async () => {
    // Padding a published value to look like a real secret does not make it one.
    const assert = await withEnv({
      JWT_ACCESS_SECRET: `prefix-replace-me-${REAL_SECRET_A}`,
    });
    expect(run(assert).exited).toBe(true);
  });

  it('is case-insensitive about it', async () => {
    const assert = await withEnv({ OTP_SECRET: `CHANGE-ME-${REAL_SECRET_C}` });
    expect(run(assert).exited).toBe(true);
  });

  it('refuses a long secret built from a handful of repeated characters', async () => {
    // Length is not entropy: this passes every length check and has 2 distinct
    // characters.
    const assert = await withEnv({ JWT_ACCESS_SECRET: 'abababababababababababababababababab' });
    const { exited, output } = run(assert);

    expect(exited).toBe(true);
    expect(output).toMatch(/variety/i);
  });

  it('refuses a database URL still using the development password', async () => {
    const assert = await withEnv({
      DATABASE_URL: 'postgresql://orbit:orbit_dev_password@db:5432/orbit',
    });
    const { exited, output } = run(assert);

    expect(exited).toBe(true);
    expect(output).toMatch(/development password/i);
  });

  it('reports every problem at once rather than one per restart', async () => {
    const assert = await withEnv({
      JWT_ACCESS_SECRET: 'dev_access_secret',
      JWT_REFRESH_SECRET: 'change-me',
      DATABASE_URL: 'postgresql://orbit:orbit_dev_password@db:5432/orbit',
    });
    const { exited, output } = run(assert);

    expect(exited).toBe(true);
    // Fixing one and restarting only to be told about the next is how a
    // deployment ends up half-corrected.
    expect(output).toContain('JWT_ACCESS_SECRET');
    expect(output).toContain('JWT_REFRESH_SECRET');
    expect(output).toMatch(/development password/i);
  });
});
