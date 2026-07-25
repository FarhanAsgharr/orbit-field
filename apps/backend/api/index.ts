/**
 * Vercel Function entry point.
 *
 * The counterpart to `src/server.ts`, which binds a port and owns its process.
 * Here the platform owns the process, so this file does only what a serverless
 * invocation can honestly do: assert the configuration is sane, then hand the
 * request to the same Express app the long-running server uses.
 *
 * Nothing about the API surface changes. `createApp()` is shared verbatim, so a
 * route behaves identically whether it is served by a container or a function —
 * which is what makes the existing e2e suite a valid check on both.
 *
 * Deliberately absent, and why:
 *
 *   - No `app.listen`. Vercel invokes the exported handler directly.
 *   - No SIGTERM drain. A function instance is frozen between invocations and
 *     killed without a signal; there is no in-flight work to drain because the
 *     response has already been written.
 *   - No maintenance `setInterval`. A frozen instance runs no timers, so the
 *     prune work moved to `api/cron/maintenance.ts` on a Vercel Cron schedule.
 *   - No explicit `$connect`. Prisma connects on first query, and doing it at
 *     module scope would pay the handshake on every cold start even for a
 *     request that never touches the database (`/health`, CORS preflight).
 */

/*
 * Imports resolve to `dist/`, not `src/`.
 *
 * The source uses NodeNext specifiers (`./app.js` naming `./app.ts`), which the
 * bundler that packages this function does not resolve — it would fail on the
 * first transitive import. `npm run build` runs `tsc` before the function is
 * bundled, so `dist/` is real JavaScript with real `.js` files, and the emitted
 * `.d.ts` files keep this entry fully typed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../dist/app.js';
import { assertProductionSecrets } from '../dist/middleware/security.js';
import { logger } from '../dist/config/logger.js';

/**
 * Fail the cold start, not the request.
 *
 * A function signing tokens with a placeholder secret is worse than one that is
 * down: the outage is visible, the weak secret is not. Throwing at module scope
 * surfaces in the build/runtime log and returns 500 for every route, which is
 * the intended blast radius for a misconfigured deployment.
 */
assertProductionSecrets();

/**
 * Built once per instance and reused across invocations.
 *
 * Vercel keeps a warm instance alive between requests, so this module-scope app
 * is constructed on cold start only. Rebuilding it per request would re-run
 * every `Router` construction and re-read config on every call.
 */
const app = createApp();

logger.info(
  { region: process.env.VERCEL_REGION, deployment: process.env.VERCEL_DEPLOYMENT_ID },
  'orbit-field api function initialised',
);

/**
 * An Express app is already a `(req, res)` function, so it satisfies Vercel's
 * Node handler contract directly. The wrapper exists only to pin the types —
 * exporting `app` raw types the handler as `Express`, which hides a signature
 * mismatch if the contract ever changes.
 */
export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req as never, res as never);
}
