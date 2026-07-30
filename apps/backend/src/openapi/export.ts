/**
 * Write the OpenAPI document to disk.
 *
 * Runs as part of the backend build, so `openapi.json` in the repository is
 * always the document the code in the repository produces. A specification
 * committed by hand drifts the first time somebody is in a hurry; one written
 * by the build cannot.
 *
 * Two details make it work anywhere a build runs.
 *
 * **Placeholder configuration.** Building the document means constructing the
 * application, and `config/env.ts` refuses to load without a database URL and
 * signing secrets. A build machine has none of those — Vercel builds with the
 * runtime environment absent — so stand-ins are supplied for anything missing.
 * Nothing is connected to and nothing is signed: the routing table is assembled
 * in memory and read. The values are obvious rubbish so that if one ever leaked
 * into something real it would fail loudly rather than quietly work.
 *
 * **An explicit exit.** Constructing the application opens a Redis client and a
 * database pool, handles that keep the event loop alive indefinitely. Nothing
 * here needs them, so the process says its piece and leaves rather than hanging
 * the build for a minute.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fill in whatever configuration is missing, before anything imports it.
 *
 * Set here rather than in a wrapper script so the command is the same whether
 * it runs locally, in CI or on a build server — and so nobody has to remember
 * a list of variables to pass.
 */
function supplyPlaceholders(): void {
  const placeholders: Record<string, string> = {
    DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi?schema=public',
    DIRECT_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi?schema=public',
    REDIS_URL: 'redis://127.0.0.1:1',
    // Long enough to satisfy the length checks, and plainly not a secret.
    JWT_ACCESS_SECRET: 'openapi-generation-placeholder-not-a-secret-0000',
    JWT_REFRESH_SECRET: 'openapi-generation-placeholder-not-a-secret-1111',
    OTP_SECRET: 'openapi-generation-placeholder-not-a-secret-2222',
  };

  for (const [key, value] of Object.entries(placeholders)) {
    process.env[key] ??= value;
  }

  /*
   * Never in production mode.
   *
   * `config/env.ts` applies extra checks when NODE_ENV is production — it
   * refuses placeholder secrets, which is exactly the protection that should
   * stay — and a build machine legitimately has NODE_ENV=production set.
   * Generating a document is not running a server, so it declares itself.
   */
  process.env.NODE_ENV = 'test';
}

async function main(): Promise<void> {
  supplyPlaceholders();

  // Imported after the placeholders are in place: a static import would be
  // hoisted above them and fail validation.
  const { createApp } = await import('../app.js');
  const { generateOpenApiDocument } = await import('./generate.js');

  const document = generateOpenApiDocument(createApp());
  const operations = Object.values(document.paths).reduce(
    (total, methods) => total + Object.keys(methods).length,
    0,
  );

  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const target = path.join(backendRoot, 'openapi.json');

  // Two-space indent and a trailing newline, so a diff of this file is
  // readable when an endpoint changes — which is the point of committing it.
  writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

  process.stdout.write(
    `openapi: ${Object.keys(document.paths).length} paths, ${operations} operations → ${path.relative(process.cwd(), target)}\n`,
  );
}

await main();
process.exit(0);
