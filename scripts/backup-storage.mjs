/**
 * Attachment storage backup and integrity check.
 *
 * The database dump does not contain the photographs. Every attachment row
 * carries a `storageKey` and a `checksum`, and the bytes live in object
 * storage — so a database restore alone gives you inspection records whose
 * evidence is missing, which for a compliance system is most of the value gone.
 *
 * Two modes:
 *
 *   --check    every attachment row has a retrievable object whose bytes match
 *              the recorded checksum. Read-only; safe against production.
 *   --mirror   additionally downloads each object to a local directory.
 *
 * `--check` is the one worth running on a schedule. It catches the failure that
 * a storage backup cannot: an object that was never uploaded, was deleted out
 * of band, or has silently rotted. A mirror of corrupt bytes is not a backup.
 *
 * Usage:
 *   DATABASE_URL=... S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... \
 *   S3_SECRET_ACCESS_KEY=... S3_REGION=... node scripts/backup-storage.mjs --check
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const MODE = args.includes('--mirror') ? 'mirror' : 'check';
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'backups/storage';
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const required = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0 || !process.env.DATABASE_URL) {
  console.error(`Missing configuration: ${[...missing, ...(process.env.DATABASE_URL ? [] : ['DATABASE_URL'])].join(', ')}`);
  process.exit(2);
}

const REGION = process.env.S3_REGION ?? 'us-east-1';
const prisma = new PrismaClient();

/**
 * Minimal SigV4 GET.
 *
 * The AWS SDK is a backend dependency, not a script one, and this needs exactly
 * one operation. Signing it directly keeps the script runnable with nothing but
 * Node — which matters when you are running it during an incident.
 */
async function getObject(key) {
  const url = new URL(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}/${key}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = createHash('sha256').update('').digest('hex');
  const canonicalHeaders =
    `host:${url.host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'GET',
    url.pathname.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/'),
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const { createHmac } = await import('node:crypto');
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${process.env.S3_SECRET_ACCESS_KEY}`, dateStamp), REGION), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const response = await fetch(url, {
    headers: {
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${process.env.S3_ACCESS_KEY_ID}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  console.log(`\x1b[1mOrbit Field — attachment storage ${MODE}\x1b[0m\n`);

  const attachments = await prisma.attachment.findMany({
    where: { storageKey: { not: null }, deletedAt: null },
    select: { id: true, storageKey: true, checksum: true, sizeBytes: true, fileName: true },
    take: Number.isFinite(LIMIT) ? LIMIT : undefined,
    orderBy: { createdAt: 'desc' },
  });

  if (attachments.length === 0) {
    console.log('  No stored attachments to verify.');
    return { total: 0, ok: 0, problems: [] };
  }

  if (MODE === 'mirror') await mkdir(OUT, { recursive: true });

  let ok = 0;
  const problems = [];

  for (const attachment of attachments) {
    try {
      const bytes = await getObject(attachment.storageKey);
      const digest = createHash('sha256').update(bytes).digest('hex');

      if (attachment.checksum && digest !== attachment.checksum) {
        // The row and the object disagree: one of them is wrong, and either way
        // the evidence attached to that inspection can no longer be trusted.
        problems.push({ id: attachment.id, key: attachment.storageKey, issue: 'checksum mismatch' });
        continue;
      }
      if (attachment.sizeBytes && Number(attachment.sizeBytes) !== bytes.length) {
        problems.push({ id: attachment.id, key: attachment.storageKey, issue: 'size mismatch' });
        continue;
      }

      if (MODE === 'mirror') {
        const target = path.join(OUT, attachment.storageKey);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      ok += 1;
    } catch (err) {
      problems.push({
        id: attachment.id,
        key: attachment.storageKey,
        issue: `unreadable (${err.message})`,
      });
    }
  }

  console.log(`  attachments  ${attachments.length}`);
  console.log(`  verified     ${ok}`);
  console.log(`  problems     ${problems.length}`);
  for (const p of problems.slice(0, 20)) {
    console.log(`    \x1b[31m✗\x1b[0m ${p.key} — ${p.issue}`);
  }
  if (problems.length > 20) console.log(`    … and ${problems.length - 20} more`);

  if (MODE === 'mirror') console.log(`\n  mirrored to ${OUT}`);

  return { total: attachments.length, ok, problems };
}

main()
  .then((result) => {
    if (result.problems.length > 0) {
      console.log('\n\x1b[31mStorage check failed.\x1b[0m Evidence is missing or corrupt.');
      process.exitCode = 1;
    } else {
      console.log('\n\x1b[32mEvery stored attachment matches its recorded checksum.\x1b[0m');
    }
  })
  .catch((err) => {
    console.error(`\n\x1b[31mStorage check error:\x1b[0m ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
