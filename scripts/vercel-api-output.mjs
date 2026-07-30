/**
 * Creates the static output directory Vercel insists on.
 *
 * The API project produces functions, not a site, so it has nothing static to
 * emit. Vercel still fails the deploy with "No Output Directory" — and then
 * with "Output Directory is empty" — unless one exists with at least one file
 * in it. This writes that file.
 *
 * The filename matters. Vercel matches static files BEFORE it applies rewrites,
 * so a file called `index.html` would answer `/` itself and shadow the
 * `/(.*)` -> `/api/index` rewrite — the API root would serve this placeholder
 * instead of the Express app's service pointer. Anything that is not an index
 * document leaves `/` unmatched, so the rewrite runs and Express answers.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'apps', 'backend', 'public');

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'placeholder.txt'),
  'Orbit Field API. Every route is served by the Express function; this file\n' +
    'exists only because Vercel requires a non-empty output directory, and is\n' +
    'deliberately not named index.html so that it does not shadow "/".\n',
);

console.log(`vercel output directory ready: ${outDir}`);

/*
 * The documentation UI bundles.
 *
 * Copied into the static output rather than left in `node_modules` for the
 * function to serve. Two reasons, and the first is decisive: Vercel traces a
 * function's imports to decide what to bundle, and these are resolved at
 * runtime by path — so nothing traced them and they were simply absent in
 * production, leaving /docs and /redoc rendering their "not available" page.
 *
 * The second is that static files are matched before rewrites, so these are
 * served by the CDN and never wake the function at all.
 *
 * Express serves the same files from `node_modules` in development, so the two
 * environments agree without either being special-cased.
 */
const assets = [
  ['swagger-ui-dist/swagger-ui.css', 'docs/assets/swagger-ui.css'],
  ['swagger-ui-dist/swagger-ui-bundle.js', 'docs/assets/swagger-ui-bundle.js'],
  [
    'swagger-ui-dist/swagger-ui-standalone-preset.js',
    'docs/assets/swagger-ui-standalone-preset.js',
  ],
  ['redoc/bundles/redoc.standalone.js', 'redoc/assets/redoc.standalone.js'],
];

let copied = 0;
for (const [from, to] of assets) {
  let source;
  try {
    source = require.resolve(from);
  } catch {
    console.warn(`documentation asset not found, skipping: ${from}`);
    continue;
  }
  const target = join(outDir, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  copied += 1;
}

// The Swagger bootstrap lives in the repository, not in a dependency.
const initialise = join(repoRoot, 'apps', 'backend', 'assets', 'initialise.js');
if (existsSync(initialise)) {
  const target = join(outDir, 'docs', 'assets', 'initialise.js');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(initialise, target);
  copied += 1;
}

console.log(`documentation assets copied: ${copied}`);
