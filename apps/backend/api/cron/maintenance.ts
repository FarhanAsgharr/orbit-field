/**
 * Scheduled maintenance — the serverless replacement for the `setInterval` that
 * `src/server.ts` runs inside a long-lived process.
 *
 * Same three sweeps, same retention windows, same functions. Only the trigger
 * changes: a frozen function instance runs no timers, so Vercel Cron calls this
 * endpoint on the schedule declared in `vercel.json` instead.
 *
 * Two behavioural notes worth knowing:
 *
 *   - The container build fires this every 6 hours; the cron runs daily, which
 *     is the Hobby plan's minimum granularity. Retention is measured in days
 *     (90 for the change log, 30 for the idempotency ledger), so a sweep four
 *     times less often prunes the same rows — it just lets a few more of them
 *     sit for a few extra hours first.
 *
 *   - It also prunes expired upload sessions, which the interval version never
 *     did. `pruneExpiredUploads` was written for the maintenance timer and
 *     exported for it, but was never added to the callback — so abandoned
 *     sessions and their orphaned chunks accumulated in storage forever. On
 *     object storage you pay for those bytes, so the omission is fixed here.
 *
 * Sweeps run sequentially and each is isolated: one failing sweep must not stop
 * the others, or a single bad table wedges all housekeeping indefinitely.
 */

/* Resolves to `dist/` for the same reason as `api/index.ts`. */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { logger } from '../../dist/config/logger.js';
import { pruneExpiredTokens } from '../../dist/lib/tokens.js';
import { increment, setGauge } from '../../dist/modules/observability/metrics.js';
import { pruneSyncTables } from '../../dist/modules/sync/sync.service.js';
import { pruneExpiredUploads } from '../../dist/modules/uploads/uploads.routes.js';

/**
 * Vercel signs cron invocations with `Authorization: Bearer $CRON_SECRET`.
 *
 * The endpoint is publicly routable, so without this check anyone could drive
 * the prune loop and force database load at will. Absent secret means the
 * deployment is misconfigured: refuse rather than run unauthenticated, because
 * a maintenance endpoint open to the internet is worse than one that is silent.
 */
function authorised(req: IncomingMessage): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (provided.length !== expected.length) return false;

  // Constant-time: a length-equal comparison that short-circuits on the first
  // differing byte leaks the secret one character at a time under timing.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Run one sweep, converting a failure into a reported result rather than a throw. */
async function sweep<T>(
  name: string,
  run: () => Promise<T>,
): Promise<{ ok: boolean; result?: T; error?: string }> {
  try {
    return { ok: true, result: await run() };
  } catch (err) {
    logger.error({ err, sweep: name }, 'maintenance sweep failed');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorised(req)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'This endpoint is invoked by the scheduler.' },
      }),
    );
    return;
  }

  const startedAt = Date.now();

  const syncTables = await sweep('syncTables', pruneSyncTables);
  const tokens = await sweep('tokens', pruneExpiredTokens);
  const uploads = await sweep('uploads', pruneExpiredUploads);

  const durationMs = Date.now() - startedAt;
  const allOk = syncTables.ok && tokens.ok && uploads.ok;

  /*
   * Recorded as metrics as well as logged.
   *
   * A caveat that was measured rather than assumed: on Vercel these are
   * invisible to a Prometheus scrape. The invocation that runs this sweep and
   * the one that answers /metrics are different instances with separate memory,
   * so the gauge set here reads 0 to a scraper — confirmed against the live
   * deployment. They remain correct in the container deployment, where one
   * process does both; on serverless the cron must be watched externally
   * instead. See deployment/prometheus/alerts.yml.
   */
  increment('orbit_background_jobs_total', {
    job: 'maintenance',
    outcome: allOk ? 'success' : 'partial',
  });
  increment(
    'orbit_background_job_rows_pruned_total',
    { sweep: 'change_log' },
    syncTables.result?.changeLog ?? 0,
  );
  increment(
    'orbit_background_job_rows_pruned_total',
    { sweep: 'operations' },
    syncTables.result?.operations ?? 0,
  );
  increment('orbit_background_job_rows_pruned_total', { sweep: 'tokens' }, tokens.result ?? 0);
  increment('orbit_background_job_rows_pruned_total', { sweep: 'uploads' }, uploads.result ?? 0);
  if (allOk) {
    setGauge('orbit_background_job_last_success_timestamp', Math.floor(Date.now() / 1000), {
      job: 'maintenance',
    });
  }

  logger.info(
    {
      syncTables: syncTables.result,
      tokens: tokens.result,
      uploads: uploads.result,
      durationMs,
      allOk,
    },
    'maintenance prune complete',
  );

  // 500 on partial failure so a persistently failing sweep shows up in the
  // Vercel cron dashboard instead of reporting success forever.
  res.statusCode = allOk ? 200 : 500;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      data: {
        changeLog: syncTables.result?.changeLog ?? null,
        operations: syncTables.result?.operations ?? null,
        tokens: tokens.result ?? null,
        uploadSessions: uploads.result ?? null,
        durationMs,
        failures: [
          syncTables.ok ? null : { sweep: 'syncTables', error: syncTables.error },
          tokens.ok ? null : { sweep: 'tokens', error: tokens.error },
          uploads.ok ? null : { sweep: 'uploads', error: uploads.error },
        ].filter(Boolean),
      },
    }),
  );
}
