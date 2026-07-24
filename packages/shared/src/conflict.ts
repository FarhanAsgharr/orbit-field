/**
 * Conflict detection and three-way merge.
 *
 * The rule this module exists to enforce: no edit is ever silently discarded.
 *
 * When a device pushes an update stamped with `baseVersion` and the server row
 * has moved past that version, we do not blindly reject and we do not blindly
 * overwrite. We compare three states — the common ancestor the device edited
 * from, the device's version, and the server's version — and classify each
 * field:
 *
 *   - only the device changed it        → take local, no human needed
 *   - only the server changed it        → take server, no human needed
 *   - both changed it to the same value → converged, no human needed
 *   - both changed it differently       → a real conflict; ask a human
 *
 * Most "conflicts" in the field are the first two cases — an inspector edits
 * notes offline while a supervisor reassigns the inspection in head office.
 * Auto-merging those is what keeps the resolution UI rare enough that people
 * actually read it when it does appear.
 */

import {
  ConflictResolution,
  type FieldDiff,
  type JsonValue,
  type RecordVersion,
  type SyncConflict,
  type SyncEntity,
} from '@orbit/types';

export type RecordSnapshot = Record<string, JsonValue>;

/** Fields that are server-owned and must never be taken from the device. */
const SERVER_AUTHORITATIVE_FIELDS = new Set([
  'id',
  'orgId',
  'number',
  'version',
  'syncCursor',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'lastWriterDeviceId',
  'lastWriterUserId',
  'reviewedById',
  'reviewedAt',
]);

/**
 * Fields whose divergence is not worth a human decision. Counters and derived
 * values get recomputed from the merged responses anyway, so presenting them
 * side-by-side would be noise that trains users to click through the dialog.
 */
const DERIVED_FIELDS = new Set([
  'score',
  'outcome',
  'totalFields',
  'answeredFields',
  'failedFields',
  'criticalFailures',
  'distanceFromSiteMeters',
]);

/** Human labels for the resolution UI. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  category: 'Category',
  department: 'Department',
  notes: 'Notes',
  tags: 'Tags',
  assignedToId: 'Assigned to',
  siteId: 'Site',
  clientId: 'Client',
  projectId: 'Project',
  assetId: 'Asset',
  scheduledFor: 'Scheduled for',
  dueAt: 'Due date',
  value: 'Answer',
  comment: 'Comment',
  caption: 'Caption',
  signerName: 'Signatory',
};

export function labelFor(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path]!;
  // `value.latitude` → `Answer › Latitude`
  return path
    .split('.')
    .map((part) =>
      (FIELD_LABELS[part] ?? part.replace(/([A-Z])/g, ' $1')).replace(/^./, (c) => c.toUpperCase()).trim(),
    )
    .join(' › ');
}

/** Structural equality for JSON values. Arrays are order-sensitive. */
export function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    if (!ka.every((k, i) => k === kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, JsonValue>)[k], (b as Record<string, JsonValue>)[k]));
  }

  return false;
}

/**
 * Tag arrays merge by union rather than last-write-wins, because two inspectors
 * adding different tags both intended additive edits. Losing one would be data
 * loss disguised as a resolution.
 */
const UNION_MERGE_FIELDS = new Set(['tags']);

export interface DiffOptions {
  /** Restrict comparison to these paths. Defaults to the union of all keys. */
  paths?: string[];
  /** Extra paths treated as derived/ignorable. */
  ignore?: string[];
}

/**
 * Compute the three-way diff.
 *
 * `base` may be absent — a device that has been offline long enough to lose its
 * cached ancestor cannot prove which side changed a field, so every difference
 * is treated as a genuine conflict. Guessing here is exactly how data gets lost.
 */
export function diffRecords(
  base: RecordSnapshot | null,
  local: RecordSnapshot,
  server: RecordSnapshot,
  options: DiffOptions = {},
): FieldDiff[] {
  const ignore = new Set([...SERVER_AUTHORITATIVE_FIELDS, ...DERIVED_FIELDS, ...(options.ignore ?? [])]);

  const paths =
    options.paths ??
    Array.from(new Set([...Object.keys(local), ...Object.keys(server)])).filter((p) => !ignore.has(p));

  const diffs: FieldDiff[] = [];

  for (const path of paths) {
    const localValue = local[path] ?? null;
    const serverValue = server[path] ?? null;

    if (deepEqual(localValue, serverValue)) continue;

    const baseValue = base ? (base[path] ?? null) : null;
    const localChanged = base ? !deepEqual(baseValue, localValue) : true;
    const serverChanged = base ? !deepEqual(baseValue, serverValue) : true;

    let isConflicting: boolean;
    let autoResolution: ConflictResolution | null;

    if (localChanged && !serverChanged) {
      isConflicting = false;
      autoResolution = ConflictResolution.KEEP_LOCAL;
    } else if (!localChanged && serverChanged) {
      isConflicting = false;
      autoResolution = ConflictResolution.KEEP_SERVER;
    } else if (UNION_MERGE_FIELDS.has(path) && Array.isArray(localValue) && Array.isArray(serverValue)) {
      isConflicting = false;
      autoResolution = ConflictResolution.MERGE;
    } else {
      // Both sides moved away from the ancestor, or there is no ancestor.
      isConflicting = true;
      autoResolution = null;
    }

    diffs.push({
      path,
      label: labelFor(path),
      baseValue,
      localValue,
      serverValue,
      isConflicting,
      autoResolution,
    });
  }

  return diffs.sort((a, b) => {
    // Genuine conflicts first — that is what the user is here to decide.
    if (a.isConflicting !== b.isConflicting) return a.isConflicting ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** Build the conflict payload the API returns and the mobile UI renders. */
export function buildConflict(input: {
  operationId: string;
  entity: SyncEntity;
  entityId: string;
  baseVersion: RecordVersion | null;
  serverVersion: RecordVersion;
  base: RecordSnapshot | null;
  local: RecordSnapshot;
  server: RecordSnapshot;
  serverUpdatedAt: string;
  serverUpdatedByName?: string | null;
  now?: string;
}): SyncConflict {
  const diffs = diffRecords(input.base, input.local, input.server);
  return {
    operationId: input.operationId as SyncConflict['operationId'],
    entity: input.entity,
    entityId: input.entityId,
    baseVersion: input.baseVersion,
    serverVersion: input.serverVersion,
    localRecord: input.local,
    serverRecord: input.server,
    diffs,
    isAutoResolvable: diffs.every((d) => !d.isConflicting),
    serverUpdatedAt: input.serverUpdatedAt as SyncConflict['serverUpdatedAt'],
    serverUpdatedByName: input.serverUpdatedByName ?? null,
    detectedAt: (input.now ?? new Date().toISOString()) as SyncConflict['detectedAt'],
  };
}

export interface MergeInput {
  diffs: FieldDiff[];
  server: RecordSnapshot;
  local: RecordSnapshot;
  strategy: ConflictResolution;
  /** Per-path overrides, used when strategy is MERGE. */
  fieldChoices?: Record<string, 'LOCAL' | 'SERVER'>;
  /** Hand-typed values that win over both sides. */
  fieldValues?: Record<string, JsonValue>;
}

export interface MergeResult {
  merged: RecordSnapshot;
  /** Paths that ended up taking the local value. */
  tookLocal: string[];
  tookServer: string[];
  /** Paths still unresolved — non-empty means the merge must not be applied. */
  unresolved: string[];
}

/**
 * Produce the merged record.
 *
 * Starts from the server row so server-authoritative fields (id, version,
 * timestamps, the inspection number) are always preserved, then layers the
 * chosen values on top.
 */
export function mergeRecords(input: MergeInput): MergeResult {
  const merged: RecordSnapshot = { ...input.server };
  const tookLocal: string[] = [];
  const tookServer: string[] = [];
  const unresolved: string[] = [];

  for (const diff of input.diffs) {
    const path = diff.path;

    // An explicit hand-edit beats everything.
    if (input.fieldValues && path in input.fieldValues) {
      merged[path] = input.fieldValues[path]!;
      tookLocal.push(path);
      continue;
    }

    let choice: 'LOCAL' | 'SERVER' | 'UNION' | null = null;

    if (input.strategy === ConflictResolution.KEEP_LOCAL) {
      choice = 'LOCAL';
    } else if (input.strategy === ConflictResolution.KEEP_SERVER) {
      choice = 'SERVER';
    } else {
      // MERGE: explicit per-field choice, else the auto-resolution.
      const explicit = input.fieldChoices?.[path];
      if (explicit) {
        choice = explicit;
      } else if (diff.autoResolution === ConflictResolution.KEEP_LOCAL) {
        choice = 'LOCAL';
      } else if (diff.autoResolution === ConflictResolution.KEEP_SERVER) {
        choice = 'SERVER';
      } else if (diff.autoResolution === ConflictResolution.MERGE) {
        choice = 'UNION';
      } else {
        choice = null;
      }
    }

    // Server-owned fields are never taken from the device, whatever was chosen.
    if (SERVER_AUTHORITATIVE_FIELDS.has(path)) {
      merged[path] = input.server[path] ?? null;
      tookServer.push(path);
      continue;
    }

    switch (choice) {
      case 'LOCAL':
        merged[path] = diff.localValue;
        tookLocal.push(path);
        break;
      case 'SERVER':
        merged[path] = diff.serverValue;
        tookServer.push(path);
        break;
      case 'UNION': {
        const l = Array.isArray(diff.localValue) ? diff.localValue : [];
        const s = Array.isArray(diff.serverValue) ? diff.serverValue : [];
        const seen = new Set<string>();
        const union: JsonValue[] = [];
        for (const item of [...s, ...l]) {
          const key = JSON.stringify(item);
          if (!seen.has(key)) {
            seen.add(key);
            union.push(item);
          }
        }
        merged[path] = union;
        tookLocal.push(path);
        break;
      }
      default:
        // Left unresolved: caller must not persist this merge.
        unresolved.push(path);
        merged[path] = diff.serverValue;
        break;
    }
  }

  return { merged, tookLocal, tookServer, unresolved };
}

/**
 * Attempt resolution without human involvement.
 * Returns null when at least one field genuinely needs a decision.
 */
export function autoMerge(conflict: SyncConflict): RecordSnapshot | null {
  if (!conflict.isAutoResolvable) return null;
  const result = mergeRecords({
    diffs: conflict.diffs,
    server: conflict.serverRecord,
    local: conflict.localRecord,
    strategy: ConflictResolution.MERGE,
  });
  return result.unresolved.length === 0 ? result.merged : null;
}

/** Count of decisions a human still owes on this conflict. */
export function pendingDecisionCount(conflict: SyncConflict): number {
  return conflict.diffs.filter((d) => d.isConflicting).length;
}

/**
 * Responses are conflict-resolved per answer rather than per inspection, so two
 * inspectors filling different sections of the same checklist never collide.
 * This narrows a whole-inspection conflict down to the answers that truly clash.
 */
export function conflictingResponseIds(conflicts: SyncConflict[]): string[] {
  return conflicts
    .filter((c) => c.entity === 'RESPONSE' && c.diffs.some((d) => d.isConflicting))
    .map((c) => c.entityId);
}
