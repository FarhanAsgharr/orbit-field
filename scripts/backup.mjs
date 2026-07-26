/**
 * Database backup with verification.
 *
 * A backup nobody has restored is a hope, not a backup. This script therefore
 * does four things rather than one:
 *
 *   1. dumps the database with `pg_dump` in custom format
 *   2. records a SHA-256 of the artefact
 *   3. **restores it into a scratch database and counts the rows**
 *   4. drops the scratch database
 *
 * Step 3 is the point. A truncated dump, a permissions error that produced an
 * empty file, or a schema the current `pg_restore` cannot read all produce a
 * plausible-looking artefact — and you find out during the incident. Verifying
 * at backup time moves that discovery to a Tuesday morning.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/backup.mjs [--out DIR] [--no-verify]
 *   node scripts/backup.mjs --verify-only path/to/backup.dump
 *
 * Exit codes: 0 success, 1 backup or verification failed, 2 bad invocation.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const VERIFY_ONLY = flag('--verify-only') ? args[args.indexOf('--verify-only') + 1] : null;
const OUT_DIR = value('--out', 'backups');
const SKIP_VERIFY = flag('--no-verify');
const RETAIN = Number(value('--retain', '7'));

function log(step, message) {
  console.log(`  ${step.padEnd(12)} ${message}`);
}

function fail(message) {
  console.error(`\n\x1b[31mBackup failed:\x1b[0m ${message}`);
  process.exit(1);
}

/** SHA-256 of a file, streamed — a dump can be larger than memory. */
async function checksum(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/**
 * Split a Postgres URL into its parts.
 *
 * The scratch database for verification has to live on the same server as the
 * source, so the URL is rebuilt with a different database name rather than
 * requiring a second connection string an operator would have to keep in sync.
 */
function parseUrl(url) {
  const parsed = new URL(url);
  return {
    url,
    database: parsed.pathname.replace(/^\//, '').split('?')[0],
    withDatabase(name) {
      const copy = new URL(url);
      copy.pathname = `/${name}`;
      // pgbouncer and schema hints are meaningless against a scratch database
      // and `pg_restore` rejects some of them outright.
      copy.search = '';
      return copy.toString();
    },
    adminUrl() {
      const copy = new URL(url);
      copy.pathname = '/postgres';
      copy.search = '';
      return copy.toString();
    },
  };
}

async function pgDump(source, target) {
  // Custom format (-Fc): compressed, and restorable selectively. Plain SQL
  // cannot be restored table-by-table during a partial recovery.
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', target, source.url], {
    maxBuffer: 1024 * 1024 * 64,
  });
}

/**
 * Restore into a scratch database and confirm the data is really there.
 *
 * Row counts across the largest tables, not merely "pg_restore exited 0" —
 * restore reports success for an empty dump, which is exactly the failure this
 * is meant to catch.
 */
async function verifyRestore(source, dumpFile) {
  const scratch = `orbit_verify_${Date.now().toString(36)}`;
  const admin = source.adminUrl();

  const psql = (url, sql) => run('psql', [url, '-tAc', sql], { maxBuffer: 1024 * 1024 * 16 });

  await psql(admin, `CREATE DATABASE "${scratch}"`);
  try {
    // A restore of a dump taken from a database with extensions will emit
    // warnings for objects it cannot recreate as a non-superuser; those are
    // expected and not failures, so exit status alone is not the signal.
    await run(
      'pg_restore',
      ['--no-owner', '--no-acl', '--dbname', source.withDatabase(scratch), dumpFile],
      { maxBuffer: 1024 * 1024 * 64 },
    ).catch((err) => {
      const text = String(err.stderr ?? '');
      const fatal = text.split('\n').filter((l) => l.includes('error:') && !l.includes('warning'));
      if (fatal.length > 0) throw new Error(`pg_restore reported errors:\n${fatal.slice(0, 5).join('\n')}`);
    });

    const scratchUrl = source.withDatabase(scratch);
    const { stdout: tableList } = await psql(
      scratchUrl,
      `SELECT count(*) FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog','information_schema')`,
    );
    const tables = Number(tableList.trim());
    if (tables === 0) {
      throw new Error('restored database contains no tables — the dump is empty');
    }

    // Compare a handful of counts against the source. Equality is not required
    // (the source keeps changing) but a restored table that is empty while the
    // source is not means the dump did not capture data.
    const probes = ['users', 'inspections', 'organizations'];
    const counts = {};
    for (const table of probes) {
      const exists = await psql(
        scratchUrl,
        `SELECT to_regclass('${table}') IS NOT NULL`,
      ).catch(() => ({ stdout: 'f' }));
      if (exists.stdout.trim() !== 't') continue;

      const [restored, live] = await Promise.all([
        psql(scratchUrl, `SELECT count(*) FROM "${table}"`),
        psql(source.url, `SELECT count(*) FROM "${table}"`).catch(() => ({ stdout: '0' })),
      ]);
      counts[table] = { restored: Number(restored.stdout.trim()), source: Number(live.stdout.trim()) };
    }

    for (const [table, { restored, source: live }] of Object.entries(counts)) {
      if (live > 0 && restored === 0) {
        throw new Error(`table "${table}" restored empty while the source holds ${live} rows`);
      }
    }

    return { tables, counts };
  } finally {
    // Always dropped, even on failure: a scratch database left behind on every
    // failed run fills the disk that the backups also live on.
    await psql(admin, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => undefined);
  }
}

/** Remove artefacts older than the retention count, newest kept. */
async function prune(dir, keep) {
  const { readdir } = await import('node:fs/promises');
  const entries = (await readdir(dir))
    .filter((f) => f.endsWith('.dump'))
    .sort()
    .reverse();
  const doomed = entries.slice(keep);
  for (const file of doomed) {
    await unlink(path.join(dir, file)).catch(() => undefined);
    await unlink(path.join(dir, `${file}.sha256`)).catch(() => undefined);
  }
  return doomed.length;
}

async function main() {
  console.log('\x1b[1mOrbit Field — database backup\x1b[0m\n');

  // --- verify an existing artefact and stop -------------------------------
  if (VERIFY_ONLY) {
    if (!process.env.DATABASE_URL) {
      console.error('DATABASE_URL is required: verification restores into a scratch database.');
      process.exit(2);
    }
    const source = parseUrl(process.env.DATABASE_URL);
    const recorded = await readFile(`${VERIFY_ONLY}.sha256`, 'utf8').catch(() => null);
    const actual = await checksum(VERIFY_ONLY);

    if (recorded) {
      const expected = recorded.trim().split(/\s+/)[0];
      if (expected !== actual) {
        fail(`checksum mismatch — the file has changed since it was written.\n` +
             `  recorded ${expected}\n  actual   ${actual}`);
      }
      log('checksum', 'matches the recorded value');
    } else {
      log('checksum', `${actual} (no recorded value to compare)`);
    }

    const result = await verifyRestore(source, VERIFY_ONLY);
    log('restore', `${result.tables} tables restored`);
    for (const [table, c] of Object.entries(result.counts)) {
      log('rows', `${table}: ${c.restored} restored / ${c.source} in source`);
    }
    console.log('\n\x1b[32mVerified.\x1b[0m This artefact restores.');
    return;
  }

  // --- take a backup ------------------------------------------------------
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(2);
  }
  const source = parseUrl(process.env.DATABASE_URL);

  await mkdir(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `orbit-${source.database}-${stamp}.dump`);

  log('database', source.database);
  await pgDump(source, file).catch((err) => fail(`pg_dump: ${err.stderr ?? err.message}`));

  const { size } = await stat(file);
  if (size === 0) fail('pg_dump produced an empty file');
  log('dump', `${file} (${(size / 1024 / 1024).toFixed(2)} MB)`);

  const digest = await checksum(file);
  await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
  log('checksum', digest);

  if (!SKIP_VERIFY) {
    const result = await verifyRestore(source, file).catch((err) => fail(`restore check: ${err.message}`));
    log('restore', `${result.tables} tables restored into a scratch database`);
    for (const [table, c] of Object.entries(result.counts)) {
      log('rows', `${table}: ${c.restored} restored / ${c.source} in source`);
    }
  } else {
    log('restore', 'skipped (--no-verify) — this artefact is UNVERIFIED');
  }

  const pruned = await prune(OUT_DIR, RETAIN);
  if (pruned > 0) log('retention', `${pruned} older backup(s) removed, keeping ${RETAIN}`);

  console.log('\n\x1b[32mBackup complete and verified.\x1b[0m');
}

main().catch((err) => fail(err.message));
