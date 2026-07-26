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
