/**
 * Process entry point.
 *
 * Graceful shutdown matters more than usual here: a SIGTERM mid-sync must let
 * the in-flight transaction finish, or a device sees a dropped connection and
 * retries operations it has no ack for. The idempotency ledger makes that safe,
 * but draining properly avoids the churn entirely.
 */

import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './db/prisma.js';
import { connectRedis, disconnectRedis } from './db/redis.js';
import { pruneSyncTables } from './modules/sync/sync.service.js';
import { pruneExpiredTokens } from './lib/tokens.js';
import { assertProductionSecrets } from './middleware/security.js';

const SHUTDOWN_TIMEOUT_MS = 30_000;

let server: Server | undefined;
let shuttingDown = false;
let maintenanceTimer: NodeJS.Timeout | undefined;

async function start(): Promise<void> {
  // Before anything binds a port: a production API signing tokens with a
  // published secret is worse than one that is down.
  assertProductionSecrets();

  await connectDatabase();
  await connectRedis();

  const app = createApp();

  server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      { port: env.PORT, host: env.HOST, env: env.NODE_ENV, prefix: env.API_PREFIX },
      'orbit-field api listening',
    );
  });

  // Keep-alive must exceed the load balancer's idle timeout, otherwise the LB
  // reuses a socket Node is simultaneously closing and clients see sporadic 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  // Housekeeping. In a multi-replica deployment this belongs in a single
  // scheduled worker; running it here keeps a single-node install self-maintaining.
  maintenanceTimer = setInterval(
    () => {
      void (async () => {
        try {
          const pruned = await pruneSyncTables();
          const tokens = await pruneExpiredTokens();
          if (pruned.changeLog + pruned.operations + tokens > 0) {
            logger.info({ ...pruned, tokens }, 'maintenance prune complete');
          }
        } catch (err) {
          logger.error({ err }, 'maintenance prune failed');
        }
      })();
    },
    6 * 60 * 60 * 1000,
  );
  maintenanceTimer.unref();
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  if (maintenanceTimer) clearInterval(maintenanceTimer);

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });
    await disconnectRedis();
    await disconnectDatabase();
    clearTimeout(forceExit);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  // The process state is now unknown; continuing risks corrupt writes.
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
