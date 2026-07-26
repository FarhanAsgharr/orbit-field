/**
 * Response repository — one row per answered question.
 *
 * Answers are stored per (inspection, field, repeatIndex), matching the server's
 * unique key exactly. That alignment is what makes a replayed offline operation
 * converge on the same row instead of failing on a constraint violation.
 *
 * Answers are also the highest-frequency write in the app: an inspector taps
 * through 200 questions in a session. `upsert` is therefore written to be cheap
 * and to coalesce in the outbox rather than emitting an operation per keystroke.
 */

import {
  type GeoPoint,
  type InspectionResponse,
  type JsonValue,
  SyncEntity,
  SyncOperation,
} from '@orbit/types';
import type { AnswerMap } from '@orbit/utils';
import { ulid } from '@orbit/utils';

import type { Outbox } from '../../sync/outbox';
import type { Database, SqlValue } from '../database';

interface ResponseRow {
  id: string;
  org_id: string;
  inspection_id: string;
  section_id: string;
  field_id: string;
  repeat_index: number;
  value: string | null;
  comment: string | null;
  score: number | null;
  is_failure: number;
  is_not_applicable: number;
  location: string | null;
  answered_at: string | null;
  answered_by_id: string | null;
  version: number;
  sync_cursor: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_dirty: number;
  has_conflict: number;
}

function parseValue(raw: string | null): JsonValue {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    // Legacy or hand-edited rows may hold a bare string. Returning it as-is is
    // better than discarding an inspector's answer over an encoding detail.
    return raw;
  }
}

function toResponse(row: ResponseRow): InspectionResponse {
  return {
    id: row.id as InspectionResponse['id'],
    orgId: row.org_id as InspectionResponse['orgId'],
    inspectionId: row.inspection_id as InspectionResponse['inspectionId'],
    sectionId: row.section_id as InspectionResponse['sectionId'],
    fieldId: row.field_id as InspectionResponse['fieldId'],
    repeatIndex: row.repeat_index,
    value: parseValue(row.value),
    comment: row.comment,
    score: row.score,
    isFailure: row.is_failure === 1,
    isNotApplicable: row.is_not_applicable === 1,
    location: row.location ? (JSON.parse(row.location) as GeoPoint) : null,
    answeredAt: row.answered_at as InspectionResponse['answeredAt'],
    answeredById: row.answered_by_id as InspectionResponse['answeredById'],
    version: row.version as InspectionResponse['version'],
    syncCursor: row.sync_cursor as InspectionResponse['syncCursor'],
    createdAt: row.created_at as InspectionResponse['createdAt'],
    updatedAt: row.updated_at as InspectionResponse['updatedAt'],
    deletedAt: row.deleted_at as InspectionResponse['deletedAt'],
    lastWriterDeviceId: null,
    lastWriterUserId: null,
  };
}

export interface UpsertAnswerInput {
  inspectionId: string;
  sectionId: string;
  fieldId: string;
  repeatIndex?: number;
  value: JsonValue;
  comment?: string | null;
  score?: number | null;
  isFailure?: boolean;
  isNotApplicable?: boolean;
  location?: GeoPoint | null;
}

export class ResponseRepository {
  constructor(
    private readonly db: Database,
    private readonly outbox: Outbox,
    private readonly identity: { userId: string; orgId: string },
  ) {}

  // --- reads ---------------------------------------------------------------

  forInspection(inspectionId: string): InspectionResponse[] {
    return this.db
      .getAll<ResponseRow>(
        `SELECT * FROM inspection_responses
          WHERE inspection_id = ? AND deleted_at IS NULL
          ORDER BY repeat_index ASC`,
        [inspectionId],
      )
      .map(toResponse);
  }

  /**
   * Answers keyed for the logic evaluator and scoring engine.
   *
   * The key format (`fieldId` or `fieldId#repeatIndex`) is defined in
   * `@orbit/utils/logic`, so the same map feeds evaluation, validation, and
   * scoring without a translation step.
   */
  answerMap(inspectionId: string): AnswerMap {
    const rows = this.db.getAll<{ field_id: string; repeat_index: number; value: string | null }>(
      `SELECT field_id, repeat_index, value
         FROM inspection_responses
        WHERE inspection_id = ? AND deleted_at IS NULL`,
      [inspectionId],
    );

    const map: AnswerMap = {};
    for (const row of rows) {
      const key = row.repeat_index === 0 ? row.field_id : `${row.field_id}#${row.repeat_index}`;
      map[key] = parseValue(row.value);
    }
    return map;
  }

  findOne(inspectionId: string, fieldId: string, repeatIndex = 0): InspectionResponse | null {
    const row = this.db.getFirst<ResponseRow>(
      `SELECT * FROM inspection_responses
        WHERE inspection_id = ? AND field_id = ? AND repeat_index = ? AND deleted_at IS NULL`,
      [inspectionId, fieldId, repeatIndex],
    );
    return row ? toResponse(row) : null;
  }

  /** Answered-question count, for the progress bar. */
  answeredCount(inspectionId: string): number {
    const row = this.db.getFirst<{ n: number }>(
      `SELECT COUNT(*) AS n FROM inspection_responses
        WHERE inspection_id = ? AND deleted_at IS NULL
          AND value IS NOT NULL AND value != 'null' AND value != '""'`,
      [inspectionId],
    );
    return row?.n ?? 0;
  }

  // --- writes --------------------------------------------------------------

  /**
   * Record an answer.
   *
   * Upsert on the natural key rather than by id: the same question answered
   * twice must update one row, and a device that lost its ack and replays must
   * land on that same row.
   */
  upsert(input: UpsertAnswerInput): InspectionResponse {
    const repeatIndex = input.repeatIndex ?? 0;
    const now = new Date().toISOString();

    return this.db.write(() => {
      const existing = this.db.getFirst<ResponseRow>(
        `SELECT * FROM inspection_responses
          WHERE inspection_id = ? AND field_id = ? AND repeat_index = ?`,
        [input.inspectionId, input.fieldId, repeatIndex],
      );

      const id = existing?.id ?? ulid();
      const encodedValue = JSON.stringify(input.value ?? null);
      const encodedLocation = input.location ? JSON.stringify(input.location) : null;

      const patch: Record<string, JsonValue> = {
        inspectionId: input.inspectionId,
        sectionId: input.sectionId,
        fieldId: input.fieldId,
        repeatIndex,
        value: input.value,
        comment: input.comment ?? null,
        score: input.score ?? null,
        isFailure: input.isFailure ?? false,
        isNotApplicable: input.isNotApplicable ?? false,
        location: (input.location ?? null) as JsonValue,
        answeredAt: now,
      };

      if (existing) {
        this.db.run(
          `UPDATE inspection_responses
              SET value = ?, comment = ?, score = ?, is_failure = ?, is_not_applicable = ?,
                  location = ?, answered_at = ?, answered_by_id = ?, updated_at = ?, is_dirty = 1
            WHERE id = ?`,
          [
            encodedValue,
            input.comment ?? null,
            input.score ?? null,
            input.isFailure ? 1 : 0,
            input.isNotApplicable ? 1 : 0,
            encodedLocation,
            now,
            this.identity.userId,
            now,
            id,
          ],
        );

        // Capture the merge ancestor on the first local edit only.
        if (existing.is_dirty === 0) {
          this.db.run(`UPDATE inspection_responses SET base_snapshot = ? WHERE id = ?`, [
            JSON.stringify(toResponse(existing)),
            id,
          ]);
        }

        this.outbox.enqueue({
          entity: SyncEntity.RESPONSE,
          operation: SyncOperation.UPDATE,
          entityId: id,
          patch,
          baseVersion: existing.version > 0 ? existing.version : null,
        });
      } else {
        this.db.run(
          `INSERT INTO inspection_responses
             (id, org_id, inspection_id, section_id, field_id, repeat_index, value, comment,
              score, is_failure, is_not_applicable, location, answered_at, answered_by_id,
              version, sync_cursor, created_at, updated_at, is_dirty)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 1)`,
          [
            id,
            this.identity.orgId,
            input.inspectionId,
            input.sectionId,
            input.fieldId,
            repeatIndex,
            encodedValue,
            input.comment ?? null,
            input.score ?? null,
            input.isFailure ? 1 : 0,
            input.isNotApplicable ? 1 : 0,
            encodedLocation,
            now,
            this.identity.userId,
            now,
            now,
          ],
        );

        this.outbox.enqueue({
          entity: SyncEntity.RESPONSE,
          operation: SyncOperation.CREATE,
          entityId: id,
          patch,
          baseVersion: null,
          // The response cannot be applied server-side before its inspection
          // exists. Naming the dependency lets the engine skip rather than fail
          // when the parent's operation has not landed yet.
          dependsOn: this.pendingInspectionOperationIds(input.inspectionId),
        });
      }

      return this.findOne(input.inspectionId, input.fieldId, repeatIndex)!;
    });
  }

  /**
   * Outbox ids of unsent CREATEs for the parent inspection.
   *
   * Empty in the common case — the inspection was created and acknowledged long
   * before its answers — which keeps the dependency list cheap.
   */
  private pendingInspectionOperationIds(inspectionId: string): string[] {
    return this.db
      .getAll<{ id: string }>(
        `SELECT id FROM outbox
          WHERE entity_id = ? AND entity = 'INSPECTION' AND operation = 'CREATE'
            AND state IN ('PENDING','RETRYING','IN_FLIGHT')`,
        [inspectionId],
      )
      .map((r) => r.id);
  }

  /** Clear an answer without deleting the row, so the tombstone still syncs. */
  clear(inspectionId: string, sectionId: string, fieldId: string, repeatIndex = 0): void {
    this.upsert({
      inspectionId,
      sectionId,
      fieldId,
      repeatIndex,
      value: null,
      comment: null,
      score: null,
      isFailure: false,
      isNotApplicable: false,
    });
  }

  /** Remove every answer for a repeat instance, e.g. deleting a repeated panel. */
  removeRepeatInstance(inspectionId: string, repeatIndex: number): void {
    this.db.write(() => {
      const rows = this.db.getAll<{ id: string; version: number }>(
        `SELECT id, version FROM inspection_responses
          WHERE inspection_id = ? AND repeat_index = ? AND deleted_at IS NULL`,
        [inspectionId, repeatIndex],
      );

      const now = new Date().toISOString();
      for (const row of rows) {
        this.db.run(`UPDATE inspection_responses SET deleted_at = ?, is_dirty = 1 WHERE id = ?`, [
          now,
          row.id,
        ]);
        this.outbox.enqueue({
          entity: SyncEntity.RESPONSE,
          operation: SyncOperation.DELETE,
          entityId: row.id,
          patch: {},
          baseVersion: row.version > 0 ? row.version : null,
        });
      }
    });
  }

  /** Highest repeat index in use, for adding the next repeated section. */
  maxRepeatIndex(inspectionId: string): number {
    const row = this.db.getFirst<{ n: number | null }>(
      `SELECT MAX(repeat_index) AS n FROM inspection_responses
        WHERE inspection_id = ? AND deleted_at IS NULL`,
      [inspectionId],
    );
    return row?.n ?? 0;
  }

  /** Bulk write used when applying carry-forward defaults on a new inspection. */
  seedDefaults(inspectionId: string, defaults: UpsertAnswerInput[]): void {
    this.db.write(() => {
      for (const answer of defaults) this.upsert(answer);
    });
  }
}

export type { SqlValue };
