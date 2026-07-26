/**
 * Server-side synchronisation engine.
 *
 * Push contract, precisely:
 *
 *  1. Operations arrive in the device's Lamport order and are applied in that
 *     order, one transaction per operation. Per-operation rather than
 *     per-batch, because a single bad operation in a batch of 300 must not roll
 *     back the 299 good ones — a device that has been offline for a week would
 *     never make progress.
 *  2. Before applying, the idempotency ledger is consulted. A replayed
 *     operation returns its original result instead of duplicating the write.
 *  3. The row's current version is compared against the `baseVersion` the
 *     device edited from. A mismatch produces a CONFLICT with a three-way diff;
 *     it never overwrites and never silently drops.
 *  4. On success the row's version is bumped, a cursor is allocated from the
 *     org's monotonic sequence, and a change-log entry is appended — inside the
 *     same transaction, so a reader can never observe a row without its log
 *     entry or a cursor gap.
 *
 * Pull is the mirror image: a single indexed range scan over the change log,
 * filtered to what this user is allowed to see.
 */

import {
  AppError,
  buildConflict,
  can,
  canAccessProject,
  ErrorCode,
  Permission,
} from '@orbit/shared';
import {
  SYNC_PROTOCOL_VERSION,
  type SyncChange,
  SyncEntity,
  SyncOperation,
  type SyncOperationEnvelope,
  type SyncOperationResult,
  type SyncPullRequest,
  type SyncPullResponse,
  type SyncPushRequest,
  type SyncPushResponse,
} from '@orbit/types';
import { ulid } from '@orbit/utils';
import { Prisma } from '@prisma/client';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { type DbClient, prisma } from '../../db/prisma.js';
import { withLock } from '../../db/redis.js';
import type { AuthContext } from '../../middleware/context.js';
import { ENTITY_HANDLERS, type EntityHandler } from './entity-handlers.js';

/** Entities a device is permitted to write. Everything else is pull-only. */
const WRITABLE_ENTITIES = new Set<SyncEntity>([
  SyncEntity.INSPECTION,
  SyncEntity.RESPONSE,
  SyncEntity.ATTACHMENT,
  SyncEntity.SIGNATURE,
  SyncEntity.ASSET,
]);

export interface SyncActor extends AuthContext {
  deviceId: string;
}

/**
 * Allocate the next cursor for an organisation.
 *
 * `UPDATE ... RETURNING` takes a row lock, which serialises cursor allocation
 * per org. That is exactly the guarantee delta pull needs: cursors are dense and
 * strictly increasing, so "everything after N" can never skip a change.
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

/** Append to the change log. Always called inside the write's transaction. */
async function appendChangeLog(
  tx: DbClient,
  input: {
    cursor: bigint;
    orgId: string;
    entity: SyncEntity;
    operation: SyncOperation;
    entityId: string;
    version: number;
    data: Prisma.InputJsonValue | null;
    projectId: string | null;
    assignedToId: string | null;
    actorUserId: string;
    actorDeviceId: string;
  },
): Promise<void> {
  await tx.changeLogEntry.create({
    data: {
      cursor: input.cursor,
      orgId: input.orgId,
      entity: input.entity,
      operation: input.operation,
      entityId: input.entityId,
      version: input.version,
      data: input.data ?? Prisma.DbNull,
      projectId: input.projectId,
      assignedToId: input.assignedToId,
      actorUserId: input.actorUserId,
      actorDeviceId: input.actorDeviceId,
    },
  });
}

function handlerFor(entity: SyncEntity): EntityHandler {
  const handler = ENTITY_HANDLERS[entity];
  if (!handler) {
    throw new AppError(ErrorCode.MALFORMED_REQUEST, `Entity ${entity} cannot be synchronised.`);
  }
  return handler;
}

/**
 * Apply one operation.
 *
 * Returns the result the device will see. Throws only for genuinely
 * unrecoverable conditions; everything a device can act on is expressed as a
 * result status so the rest of the batch continues.
 */
async function applyOperation(
  actor: SyncActor,
  op: SyncOperationEnvelope,
  appliedIds: Set<string>,
): Promise<SyncOperationResult> {
  // Dependency gate: if an operation this one depends on failed earlier in the
  // batch, applying it would create an orphan (a response with no inspection).
  const missing = op.dependsOn.filter((dep) => !appliedIds.has(dep));
  if (missing.length > 0) {
    return {
      operationId: op.id,
      status: 'SKIPPED_DEPENDENCY',
      errorCode: ErrorCode.SYNC_DEPENDENCY_FAILED,
      errorMessage: 'A prerequisite change has not been applied yet.',
    };
  }

  if (!WRITABLE_ENTITIES.has(op.entity)) {
    return {
      operationId: op.id,
      status: 'REJECTED',
      errorCode: ErrorCode.PERMISSION_DENIED,
      errorMessage: `${op.entity} records are managed on the server and cannot be pushed.`,
    };
  }

  const handler = handlerFor(op.entity);

  try {
    return await prisma.$transaction(
      async (tx) => {
        // ---- idempotency -------------------------------------------------
        const prior = await tx.syncOperationRecord.findUnique({ where: { id: op.id } });
        if (prior) {
          // A replay. Return the original outcome verbatim so a device that
          // lost the response and retried converges rather than duplicating.
          if (prior.status === 'APPLIED') {
            return {
              operationId: op.id,
              status: 'DUPLICATE' as const,
              entityId: prior.entityId,
              version: prior.resultVersion ?? undefined,
              syncCursor: prior.resultCursor ? Number(prior.resultCursor) : undefined,
            } as SyncOperationResult;
          }
          return {
            operationId: op.id,
            status: 'REJECTED' as const,
            errorCode: prior.errorCode ?? ErrorCode.VALIDATION_FAILED,
            errorMessage: prior.errorMessage ?? 'This change was previously rejected.',
          } as SyncOperationResult;
        }

        // ---- load current state -----------------------------------------
        const current = await handler.load(tx, actor.orgId, op.entityId);

        // ---- authorisation ----------------------------------------------
        const denial = await handler.authorize(tx, actor, op, current);
        if (denial) {
          await recordOperation(
            tx,
            actor,
            op,
            'REJECTED',
            null,
            null,
            ErrorCode.PERMISSION_DENIED,
            denial,
          );
          return {
            operationId: op.id,
            status: 'REJECTED' as const,
            errorCode: ErrorCode.PERMISSION_DENIED,
            errorMessage: denial,
          } as SyncOperationResult;
        }

        // ---- delete ------------------------------------------------------
        if (op.operation === SyncOperation.DELETE) {
          if (!current) {
            // Already gone. Deleting a deleted row is a no-op, not an error —
            // the device's intent is satisfied either way.
            await recordOperation(tx, actor, op, 'APPLIED', op.entityId, null, null, null);
            return {
              operationId: op.id,
              status: 'APPLIED' as const,
              entityId: op.entityId,
            } as SyncOperationResult;
          }
          const cursor = await allocateCursor(tx, actor.orgId);
          const version = current.version + 1;
          await handler.softDelete(tx, op.entityId, { version, cursor, actor });
          await appendChangeLog(tx, {
            cursor,
            orgId: actor.orgId,
            entity: op.entity,
            operation: SyncOperation.DELETE,
            entityId: op.entityId,
            version,
            data: null,
            projectId: handler.projectIdOf(current),
            assignedToId: handler.assigneeOf(current),
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
          });
          await recordOperation(
            tx,
            actor,
            op,
            'APPLIED',
            op.entityId,
            { version, cursor },
            null,
            null,
          );
          return {
            operationId: op.id,
            status: 'APPLIED' as const,
            entityId: op.entityId,
            version,
            syncCursor: Number(cursor),
          } as SyncOperationResult;
        }

        // ---- create ------------------------------------------------------
        if (!current) {
          // An UPDATE against a row that does not exist is treated as a create.
          // This is the "device created it, the create operation was lost, the
          // update survived" case, and rejecting it would strand real data.
          const validation = await handler.validate(tx, actor, op, null);
          if (validation) {
            await recordOperation(
              tx,
              actor,
              op,
              'REJECTED',
              null,
              null,
              ErrorCode.VALIDATION_FAILED,
              validation,
            );
            return {
              operationId: op.id,
              status: 'REJECTED' as const,
              errorCode: ErrorCode.VALIDATION_FAILED,
              errorMessage: validation,
            } as SyncOperationResult;
          }

          const cursor = await allocateCursor(tx, actor.orgId);
          const created = await handler.create(tx, actor, op, { version: 1, cursor });
          await appendChangeLog(tx, {
            cursor,
            orgId: actor.orgId,
            entity: op.entity,
            operation: SyncOperation.CREATE,
            entityId: op.entityId,
            version: 1,
            data: handler.serialize(created) as Prisma.InputJsonValue,
            projectId: handler.projectIdOf(created),
            assignedToId: handler.assigneeOf(created),
            actorUserId: actor.userId,
            actorDeviceId: actor.deviceId,
          });
          await recordOperation(
            tx,
            actor,
            op,
            'APPLIED',
            op.entityId,
            { version: 1, cursor },
            null,
            null,
          );
          return {
            operationId: op.id,
            status: 'APPLIED' as const,
            entityId: op.entityId,
            version: 1,
            syncCursor: Number(cursor),
          } as SyncOperationResult;
        }

        // ---- conflict detection -------------------------------------------
        // The device tells us which version it edited from. If the row has moved
        // on, someone else changed it while this device was offline.
        if (op.baseVersion !== null && op.baseVersion !== current.version) {
          const serverSnapshot = handler.serialize(current);
          // The device's intended post-edit state: what it had, plus its patch.
          const localSnapshot = { ...serverSnapshot, ...op.patch };
          const baseSnapshot = await handler.loadVersionSnapshot(
            tx,
            actor.orgId,
            op.entityId,
            op.baseVersion,
          );

          const conflict = buildConflict({
            operationId: op.id,
            entity: op.entity,
            entityId: op.entityId,
            baseVersion: op.baseVersion,
            serverVersion: current.version as never,
            base: baseSnapshot,
            local: localSnapshot,
            server: serverSnapshot,
            serverUpdatedAt: (current.updatedAt as Date).toISOString(),
            serverUpdatedByName: null,
          });

          // Every field the device touched is one the server left alone, so the
          // merge is unambiguous and no human needs to be interrupted.
          if (conflict.isAutoResolvable) {
            const cursor = await allocateCursor(tx, actor.orgId);
            const version = current.version + 1;
            const updated = await handler.update(tx, actor, op, { version, cursor });
            await appendChangeLog(tx, {
              cursor,
              orgId: actor.orgId,
              entity: op.entity,
              operation: SyncOperation.UPDATE,
              entityId: op.entityId,
              version,
              data: handler.serialize(updated) as Prisma.InputJsonValue,
              projectId: handler.projectIdOf(updated),
              assignedToId: handler.assigneeOf(updated),
              actorUserId: actor.userId,
              actorDeviceId: actor.deviceId,
            });
            await recordOperation(
              tx,
              actor,
              op,
              'APPLIED',
              op.entityId,
              { version, cursor },
              null,
              null,
            );
            return {
              operationId: op.id,
              status: 'APPLIED' as const,
              entityId: op.entityId,
              version,
              syncCursor: Number(cursor),
            } as SyncOperationResult;
          }

          // A genuine conflict. Persist it so a supervisor can resolve it from
          // the dashboard even if the inspector's device never comes back.
          await tx.syncConflictRecord.create({
            data: {
              id: ulid(),
              orgId: actor.orgId,
              operationId: op.id,
              deviceId: actor.deviceId,
              userId: actor.userId,
              entity: op.entity,
              entityId: op.entityId,
              baseVersion: op.baseVersion,
              serverVersion: current.version,
              localRecord: localSnapshot as Prisma.InputJsonValue,
              serverRecord: serverSnapshot as Prisma.InputJsonValue,
              diffs: conflict.diffs as unknown as Prisma.InputJsonValue,
            },
          });

          // Deliberately not written to the idempotency ledger: the device will
          // resubmit this operation after resolution, and it must be applied
          // then rather than short-circuited as a duplicate.
          return {
            operationId: op.id,
            status: 'CONFLICT' as const,
            conflict,
          } as SyncOperationResult;
        }

        // ---- clean update --------------------------------------------------
        const validation = await handler.validate(tx, actor, op, current);
        if (validation) {
          await recordOperation(
            tx,
            actor,
            op,
            'REJECTED',
            op.entityId,
            null,
            ErrorCode.VALIDATION_FAILED,
            validation,
          );
          return {
            operationId: op.id,
            status: 'REJECTED' as const,
            errorCode: ErrorCode.VALIDATION_FAILED,
            errorMessage: validation,
          } as SyncOperationResult;
        }

        const cursor = await allocateCursor(tx, actor.orgId);
        const version = current.version + 1;
        const updated = await handler.update(tx, actor, op, { version, cursor });
        await appendChangeLog(tx, {
          cursor,
          orgId: actor.orgId,
          entity: op.entity,
          operation: SyncOperation.UPDATE,
          entityId: op.entityId,
          version,
          data: handler.serialize(updated) as Prisma.InputJsonValue,
          projectId: handler.projectIdOf(updated),
          assignedToId: handler.assigneeOf(updated),
          actorUserId: actor.userId,
          actorDeviceId: actor.deviceId,
        });
        await recordOperation(
          tx,
          actor,
          op,
          'APPLIED',
          op.entityId,
          { version, cursor },
          null,
          null,
        );

        return {
          operationId: op.id,
          status: 'APPLIED' as const,
          entityId: op.entityId,
          version,
          syncCursor: Number(cursor),
        } as SyncOperationResult;
      },
      {
        // Serializable would be safer still, but cursor allocation already
        // serialises the only cross-row invariant, and RepeatableRead avoids
        // spurious retries on a busy multi-device org.
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15_000,
      },
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
      // Write conflict — genuinely transient, tell the device to retry.
      return {
        operationId: op.id,
        status: 'RETRY',
        errorCode: ErrorCode.LOCK_TIMEOUT,
        errorMessage: 'The change conflicted with a concurrent write. Please retry.',
      };
    }
    logger.error({ err, operationId: op.id, entity: op.entity }, 'sync operation failed');
    return {
      operationId: op.id,
      status: 'RETRY',
      errorCode: ErrorCode.INTERNAL_ERROR,
      errorMessage: 'The change could not be applied. It will be retried.',
    };
  }
}

async function recordOperation(
  tx: DbClient,
  actor: SyncActor,
  op: SyncOperationEnvelope,
  status: string,
  entityId: string | null,
  result: { version: number; cursor: bigint } | null,
  errorCode: string | null,
  errorMessage: string | null,
): Promise<void> {
  await tx.syncOperationRecord.create({
    data: {
      id: op.id,
      orgId: actor.orgId,
      deviceId: actor.deviceId,
      userId: actor.userId,
      entity: op.entity,
      operation: op.operation,
      entityId: entityId ?? op.entityId,
      status,
      resultVersion: result?.version ?? null,
      resultCursor: result?.cursor ?? null,
      errorCode,
      errorMessage,
      lamport: op.lamport,
      expiresAt: new Date(Date.now() + env.SYNC_IDEMPOTENCY_RETENTION_DAYS * 86_400_000),
    },
  });
}

/**
 * Handle a push batch.
 *
 * Serialised per device by a Redis lock: two concurrent pushes from the same
 * installation could otherwise interleave and apply Lamport-ordered operations
 * out of order.
 */
export async function push(actor: SyncActor, request: SyncPushRequest): Promise<SyncPushResponse> {
  if (request.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new AppError(
      ErrorCode.UNSUPPORTED_PROTOCOL_VERSION,
      `This app version is no longer supported. Please update to continue syncing.`,
    );
  }
  if (request.operations.length > env.SYNC_PUSH_MAX_OPERATIONS) {
    throw new AppError(
      ErrorCode.PAYLOAD_TOO_LARGE,
      `A push may contain at most ${env.SYNC_PUSH_MAX_OPERATIONS} operations.`,
    );
  }

  const session = await prisma.syncSession.create({
    data: {
      id: ulid(),
      orgId: actor.orgId,
      deviceId: actor.deviceId,
      userId: actor.userId,
      trigger: 'PUSH',
      cursorBefore: BigInt(request.cursor),
    },
  });

  const run = async (): Promise<SyncPushResponse> => {
    // Lamport order is the device's own causal order. Sorting defensively
    // protects against a client that batches out of order.
    const ordered = [...request.operations].sort((a, b) => a.lamport - b.lamport);
    const results: SyncOperationResult[] = [];
    const appliedIds = new Set<string>();

    for (const op of ordered) {
      const result = await applyOperation(actor, op, appliedIds);
      results.push(result);
      if (result.status === 'APPLIED' || result.status === 'DUPLICATE') {
        appliedIds.add(op.id);
      }
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: actor.orgId },
      select: { syncSequence: true },
    });

    const conflicts = results.filter((r) => r.status === 'CONFLICT').length;
    const applied = results.filter((r) => r.status === 'APPLIED').length;

    await prisma.syncSession.update({
      where: { id: session.id },
      data: {
        cursorAfter: org.syncSequence,
        pushedCount: applied,
        conflictCount: conflicts,
        outcome: results.some((r) => r.status === 'RETRY' || r.status === 'REJECTED')
          ? 'PARTIAL'
          : 'SUCCESS',
        finishedAt: new Date(),
        durationMs: Date.now() - session.startedAt.getTime(),
      },
    });

    await prisma.device.update({
      where: { id: actor.deviceId },
      data: { lastSyncAt: new Date() },
    });

    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      results,
      cursor: Number(org.syncSequence) as never,
      serverTime: new Date().toISOString() as never,
    };
  };

  const result = await withLock(`sync:device:${actor.deviceId}`, 60_000, run);
  if (result === null) {
    throw new AppError(
      ErrorCode.RATE_LIMITED,
      'A synchronisation is already running for this device.',
      { retryAfter: 5 },
    );
  }
  return result;
}

/**
 * Delta pull.
 *
 * One indexed range scan over the change log. The `+1` on the limit is how we
 * detect a further page without a second count query.
 */
export async function pull(actor: SyncActor, request: SyncPullRequest): Promise<SyncPullResponse> {
  if (request.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new AppError(
      ErrorCode.UNSUPPORTED_PROTOCOL_VERSION,
      'This app version is no longer supported. Please update to continue syncing.',
    );
  }

  const since = BigInt(request.since);
  const limit = Math.min(request.limit || 500, env.SYNC_PULL_MAX_CHANGES);

  // A cursor older than the retention window means the device cannot be brought
  // up to date incrementally: the log entries it needs have been pruned.
  if (since > 0n) {
    const retentionCutoff = new Date(Date.now() - env.SYNC_CHANGELOG_RETENTION_DAYS * 86_400_000);
    const oldest = await prisma.changeLogEntry.findFirst({
      where: { orgId: actor.orgId },
      orderBy: { cursor: 'asc' },
      select: { cursor: true, createdAt: true },
    });
    if (oldest && oldest.cursor > since + 1n && oldest.createdAt > retentionCutoff) {
      return {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        changes: [],
        cursor: request.since,
        hasMore: false,
        serverTime: new Date().toISOString() as never,
        requiresFullResync: true,
      };
    }
  }

  // Scope: users without `inspection:read:all` receive only their own work, and
  // project-scoped users only their projects. Filtering here rather than after
  // the fact is what keeps a pull from becoming a cross-tenant leak.
  const seesEverything = can(actor, Permission.INSPECTION_READ_ALL);
  const scopedProjects = actor.projectIds.length > 0 ? actor.projectIds : null;

  // Both scopes are conjunctive, and both are expressed as an OR. Spreading two
  // `OR` keys into one object literal silently drops the first — a project-
  // scoped inspector would then receive every inspection in their projects
  // rather than only their own. They are collected into `AND` so each one
  // constrains the result independently.
  const scopes: Prisma.ChangeLogEntryWhereInput[] = [];

  if (!seesEverything) {
    scopes.push({
      OR: [
        { assignedToId: actor.userId },
        { assignedToId: null }, // reference data: templates, sites, clients
      ],
    });
  }

  if (scopedProjects) {
    scopes.push({ OR: [{ projectId: { in: scopedProjects } }, { projectId: null }] });
  }

  const where: Prisma.ChangeLogEntryWhereInput = {
    orgId: actor.orgId,
    cursor: { gt: since },
    ...(request.entities?.length ? { entity: { in: request.entities } } : {}),
    ...(scopes.length > 0 ? { AND: scopes } : {}),
  };

  const rows = await prisma.changeLogEntry.findMany({
    where,
    orderBy: { cursor: 'asc' },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const changes: SyncChange[] = page.map((row) => ({
    entity: row.entity as SyncEntity,
    operation: row.operation as SyncOperation,
    entityId: row.entityId,
    data: (row.data as SyncChange['data']) ?? null,
    version: row.version as never,
    syncCursor: Number(row.cursor) as never,
    updatedAt: row.createdAt.toISOString() as never,
  }));

  const lastCursor = page.at(-1)?.cursor ?? since;

  // Only advance the device's stored watermark; a paged pull must not move it
  // backwards if a later page arrives out of order.
  await prisma.device
    .update({
      where: { id: actor.deviceId },
      data: { lastSyncCursor: lastCursor, lastSyncAt: new Date() },
    })
    .catch(() => undefined);

  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    changes,
    cursor: Number(lastCursor) as never,
    hasMore,
    serverTime: new Date().toISOString() as never,
  };
}

/** Unresolved conflicts for the current user, for the resolution inbox. */
export async function listConflicts(actor: SyncActor): Promise<unknown[]> {
  return prisma.syncConflictRecord.findMany({
    where: {
      orgId: actor.orgId,
      resolvedAt: null,
      ...(can(actor, Permission.INSPECTION_READ_ALL) ? {} : { userId: actor.userId }),
    },
    orderBy: { detectedAt: 'desc' },
    take: 200,
  });
}

/** Prune change-log and idempotency rows past their retention window. */
export async function pruneSyncTables(): Promise<{ changeLog: number; operations: number }> {
  const changeCutoff = new Date(Date.now() - env.SYNC_CHANGELOG_RETENTION_DAYS * 86_400_000);
  const [changeLog, operations] = await Promise.all([
    prisma.changeLogEntry.deleteMany({ where: { createdAt: { lt: changeCutoff } } }),
    prisma.syncOperationRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
  ]);
  return { changeLog: changeLog.count, operations: operations.count };
}

export { canAccessProject };
