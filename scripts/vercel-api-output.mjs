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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
