/**
 * Prisma client singleton.
 *
 * `globalThis` caching exists because `tsx watch` reloads the module graph on
 * every save; without it a long dev session exhausts the Postgres connection
 * limit within minutes.
 */

import { PrismaClient } from '@prisma/client';

import { env, isProduction } from '../config/env.js';
import { logger } from '../config/logger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction
      ? [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ]
      : [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
    datasources: { db: { url: env.DATABASE_URL } },

    /*
     * Transaction budgets sized for a cold serverless function, not a warm server.
     *
     * Prisma's defaults are `maxWait: 2s` and `timeout: 5s`. Those are generous
     * on a long-lived process holding an open pool, and much too tight here:
     * this runs on Vercel functions against Supabase's transaction pooler with
     * `connection_limit=1`, so the first write after an idle period has to cold
     * start the runtime, open a TLS connection through pgbouncer and *then*
     * begin the transaction — all inside two seconds, or Prisma throws P2028
     * before the first statement runs.
     *
     * That failure is what a person sees as "I filled in the form, pressed
     * save, and got an unexpected error" — intermittent, unreproducible, and
     * always on the first attempt after a quiet spell. Raising the budget does
     * not paper over a slow query: nothing here legitimately takes fifteen
     * seconds, so a transaction that hits the new ceiling is a genuine defect
     * rather than a cold start, which is exactly the distinction the old
     * numbers could not make.
     */
    transactionOptions: {
      /** How long to wait for a free connection before giving up. */
      maxWait: 15_000,
      /** How long the transaction body itself may take once started. */
      timeout: 20_000,
    },
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;

  prisma.$on('query' as never, (e: { query: string; params: string; duration: number }) => {
    // Only slow queries — logging every statement drowns the useful signal.
    if (e.duration >= 100) {
      logger.debug({ durationMs: e.duration, query: e.query }, 'slow query');
    }
  });
}

prisma.$on('error' as never, (e: { message: string }) => {
  logger.error({ err: e.message }, 'prisma error');
});

export type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/** Anything that can execute queries — the real client or a transaction handle. */
export type DbClient = PrismaClient | Tx;

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('database disconnected');
}

export async function databaseHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.error({ err }, 'database health check failed');
    return false;
  }
}
