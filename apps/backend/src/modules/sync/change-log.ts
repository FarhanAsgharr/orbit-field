/**
 * Change-log append helper for non-sync writers.
 *
 * The sync engine appends to the change log inline, as part of its own
 * carefully-ordered transaction. Everything *else* that mutates a syncable row —
 * admin REST routes, review decisions, bulk operations, background jobs — must
 * append too, or the change is invisible to every offline device forever.
 *
 * That is the single easiest way to break this system: write a row from a REST
 * handler, forget the change log, and watch field devices silently diverge. This
 * helper exists so there is one obvious thing to call.
 */

import { AppError, ErrorCode } from '@orbit/shared';
import type { SyncEntity, SyncOperation } from '@orbit/types';
import { Prisma } from '@prisma/client';

import type { DbClient } from '../../db/prisma.js';

export interface RecordChangeInput {
  orgId: string;
  entity: SyncEntity;
  operation: SyncOperation;
  entityId: string;
  version: number;
  /** The post-write row. Null for deletes — a tombstone carries no payload. */
  row: unknown;
  projectId?: string | null;
  assignedToId?: string | null;
  actorUserId: string | null;
  actorDeviceId: string | null;
}

/**
 * Allocate the next cursor for an organisation.
 *
 * Identical mechanism to the sync engine's: `UPDATE ... RETURNING` takes a row
 * lock, which serialises allocation per org and guarantees the dense, strictly
 * increasing sequence that delta pull depends on. Duplicated deliberately rather
 * than imported from the sync service — importing would create a cycle, and the
 * three-line query is not the part that carries the risk.
 */
async function allocateCursor(tx: DbClient, orgId: string): Promise<bigint> {
  const rows = await tx.$queryRaw<Array<{ sync_sequence: bigint }>>`
    UPDATE organizations
       SET "syncSequence" = "syncSequence" + 1
     WHERE id = ${orgId}
    RETURNING "syncSequence" AS sync_sequence
  `;
  const cursor = rows[0]?.sync_sequence;
  if (cursor === undefined) {
    throw new AppError(ErrorCode.NOT_FOUND, 'Organisation not found.');
  }
  return cursor;
}

/**
 * Serialise a Prisma row for the change log.
 *
 * BigInt and Date do not survive `JSON.stringify`, and Prisma returns both.
 * Cursors become numbers to match the wire protocol; dates become ISO strings.
 */
function serialise(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined) return null as unknown as Prisma.InputJsonValue;
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'bigint') return Number(v);
      if (v instanceof Date) return v.toISOString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}

/**
 * Append a change-log entry and stamp the row's cursor.
 *
 * Must be called inside the same transaction as the write it describes, so a
 * reader can never observe a row without its log entry.
 */
export async function recordChange(tx: DbClient, input: RecordChangeInput): Promise<bigint> {
  const cursor = await allocateCursor(tx, input.orgId);

  await tx.changeLogEntry.create({
    data: {
      cursor,
      orgId: input.orgId,
      entity: input.entity,
      operation: input.operation,
      entityId: input.entityId,
      version: input.version,
      data: input.row === null ? Prisma.DbNull : serialise(input.row),
      projectId: input.projectId ?? null,
      assignedToId: input.assignedToId ?? null,
      actorUserId: input.actorUserId,
      actorDeviceId: input.actorDeviceId,
    },
  });

  return cursor;
}

/** Table name per entity, for stamping `syncCursor` back onto the source row. */
const CURSOR_TABLE: Partial<Record<SyncEntity, string>> = {
  ORGANIZATION: 'organizations',
  USER: 'users',
  PROJECT: 'projects',
  CLIENT: 'clients',
  SITE: 'sites',
  ASSET: 'assets',
  TEMPLATE_VERSION: 'template_versions',
  INSPECTION: 'inspections',
  RESPONSE: 'inspection_responses',
  ATTACHMENT: 'attachments',
  SIGNATURE: 'signatures',
  NOTIFICATION: 'notifications',
};

/**
 * Write the allocated cursor onto the row itself.
 *
 * Optional: delta pull reads the change log, not the row. But keeping the row's
 * `syncCursor` accurate makes "what has this device seen" answerable directly
 * from the entity table, which support tooling relies on.
 */
export async function stampCursor(
  tx: DbClient,
  entity: SyncEntity,
  entityId: string,
  cursor: bigint,
): Promise<void> {
  const table = CURSOR_TABLE[entity];
  if (!table) return;
  // Table name comes from the closed map above, never from user input.
  await tx.$executeRawUnsafe(
    `UPDATE "${table}" SET "syncCursor" = $1 WHERE id = $2`,
    cursor,
    entityId,
  );
}

/** Convenience: append the entry and stamp the row in one call. */
export async function recordAndStamp(tx: DbClient, input: RecordChangeInput): Promise<bigint> {
  const cursor = await recordChange(tx, input);
  await stampCursor(tx, input.entity, input.entityId, cursor);
  return cursor;
}
