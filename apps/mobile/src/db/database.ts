/**
 * SQLite access layer.
 *
 * Wraps `expo-sqlite` behind a narrow synchronous interface. Synchronous is a
 * deliberate choice: the inspection form reads dozens of rows per render, and an
 * async round-trip per read makes scrolling a 200-question checklist visibly
 * janky. expo-sqlite's sync API runs on the JSI thread, so this is safe.
 */

import * as SQLite from 'expo-sqlite';

import { CONNECTION_PRAGMAS, META_KEYS, MIGRATIONS, SCHEMA_VERSION } from './schema';

export type SqlValue = string | number | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowId: number;
}

const DATABASE_NAME = 'orbit-field.db';

export class Database {
  private db: SQLite.SQLiteDatabase;
  private inTransaction = false;

  private constructor(db: SQLite.SQLiteDatabase) {
    this.db = db;
  }

  static async open(name: string = DATABASE_NAME): Promise<Database> {
    const raw = await SQLite.openDatabaseAsync(name);
    const instance = new Database(raw);
    instance.applyPragmas();
    instance.migrate();
    return instance;
  }

  private applyPragmas(): void {
    for (const pragma of CONNECTION_PRAGMAS) {
      // A pragma failing is not fatal — some are unsupported on older Android
      // SQLite builds — but it must be visible, not silent.
      try {
        this.db.execSync(pragma);
      } catch (err) {
        console.warn(`[db] pragma failed: ${pragma}`, err);
      }
    }
  }

  /**
   * Apply outstanding migrations.
   *
   * Each runs in its own transaction so a failure halfway through a multi-step
   * upgrade leaves the database at the last complete version rather than in a
   * half-migrated state the app cannot reason about.
   */
  private migrate(): void {
    this.db.execSync(
      `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT);`,
    );

    const row = this.getFirst<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [
      META_KEYS.SCHEMA_VERSION,
    ]);
    const current = row ? Number(row.value) : 0;

    if (current >= SCHEMA_VERSION) return;

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;

      this.db.execSync('BEGIN');
      try {
        for (const statement of migration.statements) {
          this.db.execSync(statement);
        }
        this.db.runSync(
          `INSERT INTO meta (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [META_KEYS.SCHEMA_VERSION, String(migration.version)],
        );
        this.db.execSync('COMMIT');
        console.info(`[db] migrated to v${migration.version} (${migration.name})`);
      } catch (err) {
        this.db.execSync('ROLLBACK');
        // Continuing on a failed migration would run the app against a schema
        // it was not written for, which corrupts data rather than merely
        // failing. Surfacing it is the safe outcome.
        throw new Error(
          `Migration v${migration.version} (${migration.name}) failed: ${String(err)}`,
        );
      }
    }
  }

  getFirst<T>(sql: string, params: SqlValue[] = []): T | null {
    return (this.db.getFirstSync(sql, params) as T | null) ?? null;
  }

  getAll<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.getAllSync(sql, params) as T[];
  }

  run(sql: string, params: SqlValue[] = []): RunResult {
    const result = this.db.runSync(sql, params);
    return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
  }

  exec(sql: string): void {
    this.db.execSync(sql);
  }

  /**
   * Run `fn` inside a transaction.
   *
   * Nested calls join the outer transaction rather than opening a second one —
   * SQLite has no nested transactions, and the common case (a repository method
   * that both writes a row and enqueues an outbox entry, called from a service
   * that is already transactional) would otherwise fail at runtime.
   */
  write<T>(fn: () => T): T {
    if (this.inTransaction) return fn();

    this.inTransaction = true;
    this.db.execSync('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.execSync('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.execSync('ROLLBACK');
      } catch {
        // A rollback failure means the transaction was already resolved;
        // the original error is the one worth propagating.
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // --- meta helpers --------------------------------------------------------

  getMeta(key: string): string | null {
    return (
      this.getFirst<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, [key])?.value ?? null
    );
  }

  setMeta(key: string, value: string): void {
    this.run(
      `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  getCursor(): number {
    return Number(this.getMeta(META_KEYS.SYNC_CURSOR) ?? '0');
  }

  setCursor(cursor: number): void {
    // Never move the watermark backwards: an out-of-order page would otherwise
    // cause the next pull to re-request changes already applied.
    if (cursor > this.getCursor()) {
      this.setMeta(META_KEYS.SYNC_CURSOR, String(cursor));
    }
  }

  /** Approximate on-device size, for the storage indicator. */
  sizeBytes(): number {
    const row = this.getFirst<{ size: number }>(
      `SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`,
    );
    return row?.size ?? 0;
  }

  /** Reclaim space after a bulk delete. Expensive — call it deliberately. */
  vacuum(): void {
    this.db.execSync('VACUUM');
  }

  /**
   * Wipe replicated data while preserving the outbox.
   *
   * Used when the server reports the device's cursor is past the retention
   * window. Unsent local work must survive: it has never reached the server, so
   * discarding it would be exactly the data loss this system exists to prevent.
   */
  resetForFullResync(): void {
    this.write(() => {
      for (const table of [
        'organizations',
        'users',
        'clients',
        'projects',
        'sites',
        'assets',
        'template_versions',
        'inspections',
        'inspection_responses',
        'signatures',
        'notifications',
      ]) {
        // Rows with pending local changes are kept; the delta pull will
        // reconcile them and any true conflict surfaces normally.
        this.run(`DELETE FROM ${table} WHERE is_dirty = 0`);
      }
      // Attachments are kept unconditionally: the local file may be the only
      // copy of a photo that has not finished uploading.
      this.setMeta(META_KEYS.SYNC_CURSOR, '0');
      this.setMeta(META_KEYS.LAST_FULL_RESYNC_AT, new Date().toISOString());
    });
  }

  close(): void {
    this.db.closeSync();
  }
}

let instance: Database | null = null;

export async function getDatabase(): Promise<Database> {
  if (!instance) instance = await Database.open();
  return instance;
}

export function getDatabaseSync(): Database {
  if (!instance) {
    throw new Error('Database has not been opened. Await getDatabase() during app startup.');
  }
  return instance;
}

export { META_KEYS };
