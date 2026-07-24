/**
 * Object storage abstraction.
 *
 * Two drivers: local filesystem for development and single-node installs, S3
 * for anything with more than one API replica. The interface is deliberately
 * narrow — chunked uploads need exactly these five operations, and a wider
 * surface would tempt callers into provider-specific behaviour.
 *
 * Chunks are written as individual objects and concatenated on finalise rather
 * than using S3 multipart. Multipart is more efficient, but its part numbering
 * cannot express "the client sent chunk 7 twice and chunk 4 never arrived",
 * which is exactly the situation a field device on a failing link produces.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export interface StorageDriver {
  putChunk(uploadId: string, index: number, data: Buffer): Promise<void>;
  hasChunk(uploadId: string, index: number): Promise<boolean>;
  /** Concatenate chunks in order into a final object. Returns its storage key. */
  finalise(uploadId: string, totalChunks: number, key: string): Promise<{ key: string; sizeBytes: number; checksum: string }>;
  discard(uploadId: string): Promise<void>;
  read(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

/** Reject keys that could escape the storage root. */
function safeKey(key: string): string {
  if (key.includes('..') || key.startsWith('/') || key.includes('\0')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
  return key;
}

class LocalStorage implements StorageDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private chunkPath(uploadId: string, index: number): string {
    return join(this.root, '.chunks', safeKey(uploadId), `${index}.part`);
  }

  private objectPath(key: string): string {
    return join(this.root, safeKey(key));
  }

  async putChunk(uploadId: string, index: number, data: Buffer): Promise<void> {
    const path = this.chunkPath(uploadId, index);
    await mkdir(dirname(path), { recursive: true });
    // Write to a temporary name then rename: a crash mid-write must not leave a
    // truncated chunk that later passes the "has chunk" check.
    const temp = `${path}.tmp`;
    await writeFile(temp, data);
    const { rename } = await import('node:fs/promises');
    await rename(temp, path);
  }

  async hasChunk(uploadId: string, index: number): Promise<boolean> {
    try {
      const info = await stat(this.chunkPath(uploadId, index));
      return info.isFile() && info.size > 0;
    } catch {
      return false;
    }
  }

  async finalise(uploadId: string, totalChunks: number, key: string): Promise<{ key: string; sizeBytes: number; checksum: string }> {
    const target = this.objectPath(key);
    await mkdir(dirname(target), { recursive: true });

    const hash = createHash('sha256');
    const output = createWriteStream(target);
    let sizeBytes = 0;

    try {
      for (let index = 0; index < totalChunks; index++) {
        const chunkPath = this.chunkPath(uploadId, index);
        // Streamed rather than buffered: a 500 MB video must not be held in
        // memory to be assembled.
        const input = createReadStream(chunkPath);
        input.on('data', (buf: Buffer | string) => {
          const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
          hash.update(b);
          sizeBytes += b.length;
        });
        await pipeline(input, output, { end: false });
      }
      output.end();
      await new Promise<void>((resolveDone, reject) => {
        output.on('finish', () => resolveDone());
        output.on('error', reject);
      });
    } catch (err) {
      output.destroy();
      await rm(target, { force: true }).catch(() => undefined);
      throw err;
    }

    return { key, sizeBytes, checksum: hash.digest('hex') };
  }

  async discard(uploadId: string): Promise<void> {
    await rm(join(this.root, '.chunks', safeKey(uploadId)), { recursive: true, force: true }).catch(() => undefined);
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.objectPath(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.objectPath(key))).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true }).catch(() => undefined);
  }
}

/**
 * S3-compatible driver.
 *
 * Loaded lazily so a deployment using local storage does not need the AWS SDK
 * installed at all — it is a large dependency to force on every install.
 */
class S3Storage implements StorageDriver {
  private client: unknown = null;

  /**
   * Module specifier held in a variable, not a literal.
   *
   * The AWS SDK is an optional peer: deployments using local storage should not
   * be forced to install ~40 MB of dependency they will never load. A literal
   * `import('@aws-sdk/client-s3')` would make TypeScript demand it at compile
   * time even inside an unreachable branch, so the specifier is computed.
   */
  private static readonly SDK_MODULE = '@aws-sdk/client-s3';

  private async sdk(): Promise<{ client: never; commands: never }> {
    if (!this.client) {
      // Deliberately dynamic: keeps @aws-sdk out of the dependency graph for
      // local deployments.
      const mod = (await import(S3Storage.SDK_MODULE).catch(() => null)) as never;
      if (!mod) {
        throw new Error(
          'S3 storage is configured but @aws-sdk/client-s3 is not installed. Run: npm i @aws-sdk/client-s3 -w @orbit/backend',
        );
      }
      const { S3Client } = mod as unknown as { S3Client: new (c: unknown) => unknown };
      this.client = new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials:
          env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
      return { client: this.client as never, commands: mod as never };
    }
    const mod = (await import(S3Storage.SDK_MODULE)) as never;
    return { client: this.client as never, commands: mod as never };
  }

  private chunkKey(uploadId: string, index: number): string {
    return `.chunks/${uploadId}/${index}.part`;
  }

  async putChunk(uploadId: string, index: number, data: Buffer): Promise<void> {
    const { client, commands } = await this.sdk();
    const { PutObjectCommand } = commands as unknown as { PutObjectCommand: new (i: unknown) => never };
    await (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: this.chunkKey(uploadId, index), Body: data }),
    );
  }

  async hasChunk(uploadId: string, index: number): Promise<boolean> {
    try {
      const { client, commands } = await this.sdk();
      const { HeadObjectCommand } = commands as unknown as { HeadObjectCommand: new (i: unknown) => never };
      await (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(
        new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: this.chunkKey(uploadId, index) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async finalise(uploadId: string, totalChunks: number, key: string): Promise<{ key: string; sizeBytes: number; checksum: string }> {
    const { client, commands } = await this.sdk();
    const { GetObjectCommand, PutObjectCommand } = commands as unknown as {
      GetObjectCommand: new (i: unknown) => never;
      PutObjectCommand: new (i: unknown) => never;
    };
    const send = (client as unknown as { send: (c: unknown) => Promise<unknown> }).send.bind(client);

    const parts: Buffer[] = [];
    const hash = createHash('sha256');
    let sizeBytes = 0;

    for (let index = 0; index < totalChunks; index++) {
      const response = (await send(
        new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: this.chunkKey(uploadId, index) }),
      )) as { Body: { transformToByteArray: () => Promise<Uint8Array> } };
      const bytes = Buffer.from(await response.Body.transformToByteArray());
      hash.update(bytes);
      sizeBytes += bytes.length;
      parts.push(bytes);
    }

    await send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: Buffer.concat(parts) }));
    return { key, sizeBytes, checksum: hash.digest('hex') };
  }

  async discard(uploadId: string): Promise<void> {
    const { client, commands } = await this.sdk();
    const { DeleteObjectsCommand, ListObjectsV2Command } = commands as unknown as {
      DeleteObjectsCommand: new (i: unknown) => never;
      ListObjectsV2Command: new (i: unknown) => never;
    };
    const send = (client as unknown as { send: (c: unknown) => Promise<unknown> }).send.bind(client);

    const listed = (await send(
      new ListObjectsV2Command({ Bucket: env.S3_BUCKET, Prefix: `.chunks/${uploadId}/` }),
    )) as { Contents?: Array<{ Key: string }> };

    if (listed.Contents?.length) {
      await send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: { Objects: listed.Contents.map((o) => ({ Key: o.Key })) },
        }),
      );
    }
  }

  async read(key: string): Promise<Buffer> {
    const { client, commands } = await this.sdk();
    const { GetObjectCommand } = commands as unknown as { GetObjectCommand: new (i: unknown) => never };
    const response = (await (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    )) as { Body: { transformToByteArray: () => Promise<Uint8Array> } };
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async exists(key: string): Promise<boolean> {
    try {
      const { client, commands } = await this.sdk();
      const { HeadObjectCommand } = commands as unknown as { HeadObjectCommand: new (i: unknown) => never };
      await (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(
        new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const { client, commands } = await this.sdk();
    const { DeleteObjectCommand } = commands as unknown as { DeleteObjectCommand: new (i: unknown) => never };
    await (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(
      new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    );
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!driver) {
    driver = env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(env.STORAGE_LOCAL_PATH);
    logger.info({ driver: env.STORAGE_DRIVER }, 'storage driver initialised');
  }
  return driver;
}

/**
 * Object key for an attachment.
 *
 * Partitioned by org and date so a bucket listing stays navigable and lifecycle
 * rules can target old data by prefix.
 */
export function attachmentKey(orgId: string, attachmentId: string, fileName: string): string {
  const date = new Date();
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
  return `attachments/${orgId}/${yyyy}/${mm}/${attachmentId}${extension}`;
}
