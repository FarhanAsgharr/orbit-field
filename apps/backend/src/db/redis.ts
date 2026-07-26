/**
 * Redis connection.
 *
 * Used for rate limiting, OTP throttling, sync locks, and short-lived
 * challenges. Deliberately never the system of record — everything here can be
 * lost on a restart without data loss, which is what lets the API keep serving
 * (degraded) if Redis is down.
 */

import { Redis } from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  // Without this, a Redis blip stalls every request that touches a rate limiter
  // instead of failing fast and falling back to the in-memory limiter.
  connectTimeout: 5_000,
  retryStrategy: (times: number) => Math.min(times * 200, 5_000),
  lazyConnect: true,
});

redis.on('error', (err: unknown) => logger.error({ err }, 'redis error'));
redis.on('connect', () => logger.info('redis connected'));
redis.on('close', () => logger.warn('redis connection closed'));

export async function connectRedis(): Promise<void> {
  try {
    // ioredis auto-connects on the first command even under `lazyConnect`, so a
    // module that touches Redis during import can win the race and leave this
    // call throwing "already connecting" — which then logs as a startup failure
    // that did not happen. Only connect when genuinely idle.
    if (redis.status === 'connecting' || redis.status === 'connect' || redis.status === 'ready') {
      return;
    }
    await redis.connect();
  } catch (err) {
    // Non-fatal: the API degrades to in-memory rate limiting rather than
    // refusing to boot, because an inspector in the field losing sync is worse
    // than a briefly weaker rate limiter.
    logger.error({ err }, 'redis unavailable at startup; continuing degraded');
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit().catch(() => redis.disconnect());
}

export async function redisHealthy(): Promise<boolean> {
  try {
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Best-effort distributed lock.
 *
 * Guards a single device's sync run so two concurrent pushes from the same
 * installation cannot interleave and produce out-of-order Lamport application.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lockKey = `lock:${key}`;

  let acquired = false;
  try {
    acquired = (await redis.set(lockKey, token, 'PX', ttlMs, 'NX')) === 'OK';
  } catch {
    // Redis down: proceed without the lock rather than blocking sync entirely.
    // The database transaction and idempotency ledger remain the real guards.
    return fn();
  }

  if (!acquired) return null;

  try {
    return await fn();
  } finally {
    // Release only if we still own it — a lock that expired mid-run may now
    // belong to another worker, and deleting it would be a correctness bug.
    await redis
      .eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        lockKey,
        token,
      )
      .catch(() => undefined);
  }
}
