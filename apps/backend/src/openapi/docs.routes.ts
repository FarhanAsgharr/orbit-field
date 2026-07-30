/**
 * The rendered API documentation.
 *
 * Three things are served: the document itself at `/openapi.json`, Swagger UI
 * at `/docs`, and ReDoc at `/redoc`. The two renderers exist because they are
 * good at different jobs — Swagger UI will send a request, which is what you
 * want while integrating; ReDoc reads better, which is what you want while
 * understanding.
 *
 * **Everything is served from this origin, deliberately.** The API sets
 * `script-src 'self'` and the obvious way to add these pages — a `<script>`
 * pointing at a CDN — would be blocked by it. The alternatives were to relax
 * the policy for two routes or to ship the bundles; shipping them is the one
 * that leaves the security headers exactly as they were, and it also means the
 * documentation keeps working for somebody running this offline or behind a
 * network that cannot reach a CDN.
 *
 * For the same reason there is no inline script anywhere here: `'unsafe-inline'`
 * is not in the policy and is not being added, so the few lines that boot each
 * renderer are served as their own files.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { Router } from 'express';
import type { Express } from 'express';

import { generateOpenApiDocument } from './generate.js';

const require = createRequire(import.meta.url);

/**
 * Where the vendored bundles live.
 *
 * Resolved through the module system rather than assumed, because the layout
 * of `node_modules` differs between a local install, a workspace hoist and the
 * bundle Vercel builds.
 */
function assetDirectory(packageName: string, marker: string): string | null {
  try {
    return path.dirname(require.resolve(`${packageName}/${marker}`));
  } catch {
    // Missing assets must not take the API down. The endpoints below degrade
    // to a plain message; the specification itself still serves.
    return null;
  }
}

const SWAGGER_ASSETS = assetDirectory('swagger-ui-dist', 'swagger-ui-bundle.js');
const REDOC_ASSETS = assetDirectory('redoc', 'bundles/redoc.standalone.js');

/**
 * The Swagger bootstrap, which lives in the repository rather than a package.
 *
 * The same file is copied into the static output at build time, so the bytes
 * Express serves in development and the bytes Vercel's CDN serves in
 * production are identical — there is no second copy to drift.
 */
const OWN_ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets');

const SWAGGER_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orbit Field API — reference</title>
    <link rel="stylesheet" href="/docs/assets/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/assets/swagger-ui-bundle.js"></script>
    <script src="/docs/assets/swagger-ui-standalone-preset.js"></script>
    <script src="/docs/assets/initialise.js"></script>
  </body>
</html>
`;

const REDOC_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Orbit Field API — reference</title>
    <style>body { margin: 0; padding: 0; }</style>
  </head>
  <body>
    <redoc spec-url="/openapi.json"></redoc>
    <script src="/redoc/assets/redoc.standalone.js"></script>
  </body>
</html>
`;

const MISSING = (name: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Orbit Field API</title></head>
<body style="font-family: system-ui; padding: 3rem; max-width: 40rem;">
<h1>${name} is not available in this build</h1>
<p>Its assets were not bundled. The specification itself is served at
<a href="/openapi.json">/openapi.json</a> and can be opened in any OpenAPI viewer.</p>
</body></html>
`;

/**
 * Mount the documentation.
 *
 * Takes the application so the document can be generated from the routes that
 * are actually mounted. Called last in `createApp`, after every router, or it
 * would describe a partially-built server.
 */
export function mountDocumentation(app: Express): void {
  /*
   * Generated once per process, not per request.
   *
   * The routing table cannot change after start-up, so the document cannot
   * either — and on a serverless function this is the difference between
   * paying for the walk on a cold start only and paying for it every time
   * somebody opens the page.
   */
  let cached: unknown = null;
  const document = (): unknown => (cached ??= generateOpenApiDocument(app));

  app.get('/openapi.json', (_req, res) => {
    res.type('application/json').json(document());
  });

  // Kept because plenty of tooling looks for this name specifically.
  app.get('/openapi.yaml', (_req, res) => {
    res.redirect(308, '/openapi.json');
  });

  const swagger = Router();
  if (SWAGGER_ASSETS) {
    swagger.use(
      '/assets',
      express.static(OWN_ASSETS, {
        index: false,
        // Served before the package directory below, so `initialise.js`
        // resolves to the repository's copy.
        extensions: false,
      }),
    );
    swagger.use(
      '/assets',
      express.static(SWAGGER_ASSETS, {
        // The bundles are versioned with the dependency, so they may be held
        // for a long time; the page itself must not be.
        maxAge: '7d',
        index: false,
      }),
    );
  }
  swagger.get('/', (_req, res) => {
    res.type('html').send(SWAGGER_ASSETS ? SWAGGER_PAGE : MISSING('Swagger UI'));
  });
  app.use('/docs', swagger);

  const redoc = Router();
  if (REDOC_ASSETS) {
    redoc.use('/assets', express.static(REDOC_ASSETS, { maxAge: '7d', index: false }));
  }
  redoc.get('/', (_req, res) => {
    res.type('html').send(REDOC_ASSETS ? REDOC_PAGE : MISSING('ReDoc'));
  });
  app.use('/redoc', redoc);
}
