/**
 * One HTTP server per test file.
 *
 * `request(app)` in supertest starts a fresh server on an ephemeral port for
 * *every* request and tears it down when the response ends. Across the whole
 * suite that is several thousand listen/close cycles, and the teardown races
 * the response often enough to matter: roughly one run in three failed with
 * `socket hang up`, in a different test each time, with nothing wrong in the
 * code under test.
 *
 * A flaky suite is worse than a slower one. It trains people to re-run until
 * green, which is the same habit that lets a real intermittent failure through.
 *
 * Handing supertest an already-listening server removes the cycle entirely:
 * one port per file, opened at collection and closed after the last test.
 *
 * Usage, at the top level of a test file:
 *
 *   const app = createApp();
 *   const server = testServer(app);
 *   // then request(server) everywhere instead of request(app)
 */

import type { Server } from 'node:http';

import type { Express } from 'express';
import { afterAll } from 'vitest';

export function testServer(app: Express): Server {
  const server = app.listen(0);
  // A listening handle must not be what keeps the process alive if a test file
  // throws before its hooks are registered.
  server.unref();

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  return server;
}
