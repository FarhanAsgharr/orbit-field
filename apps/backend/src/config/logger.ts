/**
 * Structured logging.
 *
 * Redaction is not optional here: audit payloads and sync operations routinely
 * carry inspection data, and auth requests carry credentials. Anything that
 * could end up in a log aggregator is stripped at the logger, not at each call
 * site, because call-site discipline always eventually fails.
 */

import pino from 'pino';

import { env, isProduction } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-refresh-token"]',
      'password',
      '*.password',
      'currentPassword',
      'newPassword',
      'passwordHash',
      '*.passwordHash',
      'passwordHistory',
      'refreshToken',
      '*.refreshToken',
      'accessToken',
      '*.accessToken',
      'tokenHash',
      'codeHash',
      'code',
      'signature',
      'biometricPublicKey',
      'res.headers["set-cookie"]',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: { service: 'orbit-backend', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pretty output locally; JSON in production for the log pipeline.
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
        },
      },
});

export type Logger = typeof logger;

/** Child logger bound to a request, so every line carries the correlation id. */
export function requestLogger(requestId: string, userId?: string, orgId?: string): Logger {
  return logger.child({ requestId, ...(userId ? { userId } : {}), ...(orgId ? { orgId } : {}) });
}
