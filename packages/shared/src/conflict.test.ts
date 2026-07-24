import { describe, expect, it } from 'vitest';
import { ConflictResolution, type JsonValue } from '@orbit/types';
import { autoMerge, buildConflict, diffRecords, mergeRecords, deepEqual } from './conflict.js';

type Snap = Record<string, JsonValue>;

const base: Snap = {
  id: 'INS1',
  title: 'Substation A quarterly',
  notes: 'Initial visit',
  priority: 'NORMAL',
  assignedToId: 'USER1',
  tags: ['electrical'],
};

describe('deepEqual', () => {
  it('treats structurally identical objects as equal regardless of key order', () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
  });

  it('is order-sensitive for arrays', () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  it('does not conflate null and undefined with values', () => {
    expect(deepEqual(null, 0)).toBe(false);
    expect(deepEqual(undefined, null)).toBe(false);
  });
});

describe('diffRecords — three-way classification', () => {
  it('auto-resolves to local when only the device changed a field', () => {
    const local: Snap = { ...base, notes: 'Found corrosion on busbar' };
    const server: Snap = { ...base };

    const diffs = diffRecords(base, local, server);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.path).toBe('notes');
    expect(diffs[0]!.isConflicting).toBe(false);
    expect(diffs[0]!.autoResolution).toBe(ConflictResolution.KEEP_LOCAL);
  });

  it('auto-resolves to server when only the server changed a field', () => {
    const local: Snap = { ...base };
    const server: Snap = { ...base, assignedToId: 'USER2' };

    const diffs = diffRecords(base, local, server);
    expect(diffs[0]!.path).toBe('assignedToId');
    expect(diffs[0]!.autoResolution).toBe(ConflictResolution.KEEP_SERVER);
    expect(diffs[0]!.isConflicting).toBe(false);
  });

  it('flags a genuine conflict when both sides changed the same field differently', () => {
    const local: Snap = { ...base, priority: 'CRITICAL' };
    const server: Snap = { ...base, priority: 'LOW' };

    const diffs = diffRecords(base, local, server);
    expect(diffs[0]!.isConflicting).toBe(true);
    expect(diffs[0]!.autoResolution).toBeNull();
  });

  it('does not report a diff when both sides converged on the same value', () => {
    const local: Snap = { ...base, priority: 'HIGH' };
    const server: Snap = { ...base, priority: 'HIGH' };
    expect(diffRecords(base, local, server)).toHaveLength(0);
  });

  it('treats every difference as conflicting when the ancestor is unavailable', () => {
    // A device that lost its cached base cannot prove which side moved, so
    // guessing would risk discarding a real edit.
    const local: Snap = { ...base, notes: 'Local note' };
    const server: Snap = { ...base, notes: 'Server note' };

    const diffs = diffRecords(null, local, server);
    expect(diffs[0]!.isConflicting).toBe(true);
  });

  it('ignores server-authoritative and derived fields', () => {
    const local: Snap = { ...base, version: 3, score: 88, number: 'INS-2026-1' };
    const server: Snap = { ...base, version: 9, score: 42, number: 'INS-2026-2' };
    expect(diffRecords(base, local, server)).toHaveLength(0);
  });

  it('sorts genuine conflicts ahead of auto-resolvable differences', () => {
    const local: Snap = { ...base, priority: 'CRITICAL', notes: 'local only' };
    const server: Snap = { ...base, priority: 'LOW' };

    const diffs = diffRecords(base, local, server);
    expect(diffs[0]!.isConflicting).toBe(true);
    expect(diffs[0]!.path).toBe('priority');
  });

  it('merges tag arrays by union rather than picking a winner', () => {
    const local: Snap = { ...base, tags: ['electrical', 'urgent'] };
    const server: Snap = { ...base, tags: ['electrical', 'annual'] };

    const diffs = diffRecords(base, local, server);
    expect(diffs[0]!.autoResolution).toBe(ConflictResolution.MERGE);
    expect(diffs[0]!.isConflicting).toBe(false);
  });
});

describe('mergeRecords', () => {
  it('KEEP_LOCAL takes every device value but preserves server-owned fields', () => {
    const local: Snap = { ...base, notes: 'Local wins', version: 1 };
    const server: Snap = { ...base, notes: 'Server note', version: 7 };

    const diffs = diffRecords(base, local, server);
    const result = mergeRecords({ diffs, local, server, strategy: ConflictResolution.KEEP_LOCAL });

    expect(result.merged.notes).toBe('Local wins');
    expect(result.merged.version).toBe(7);
    expect(result.unresolved).toHaveLength(0);
  });

  it('KEEP_SERVER discards the local edit entirely', () => {
    const local: Snap = { ...base, notes: 'Local' };
    const server: Snap = { ...base, notes: 'Server' };
    const diffs = diffRecords(base, local, server);

    const result = mergeRecords({ diffs, local, server, strategy: ConflictResolution.KEEP_SERVER });
    expect(result.merged.notes).toBe('Server');
  });

  it('MERGE honours per-field choices and reports nothing unresolved', () => {
    const local: Snap = { ...base, notes: 'Local note', priority: 'CRITICAL' };
    const server: Snap = { ...base, notes: 'Server note', priority: 'LOW' };
    const diffs = diffRecords(base, local, server);

    const result = mergeRecords({
      diffs,
      local,
      server,
      strategy: ConflictResolution.MERGE,
      fieldChoices: { notes: 'LOCAL', priority: 'SERVER' },
    });

    expect(result.merged.notes).toBe('Local note');
    expect(result.merged.priority).toBe('LOW');
    expect(result.unresolved).toHaveLength(0);
  });

  it('reports unresolved paths rather than silently picking a side', () => {
    const local: Snap = { ...base, priority: 'CRITICAL' };
    const server: Snap = { ...base, priority: 'LOW' };
    const diffs = diffRecords(base, local, server);

    // MERGE with no choice supplied for a genuinely conflicting field.
    const result = mergeRecords({ diffs, local, server, strategy: ConflictResolution.MERGE });
    expect(result.unresolved).toEqual(['priority']);
  });

  it('a hand-typed value beats both sides', () => {
    const local: Snap = { ...base, priority: 'CRITICAL' };
    const server: Snap = { ...base, priority: 'LOW' };
    const diffs = diffRecords(base, local, server);

    const result = mergeRecords({
      diffs, local, server,
      strategy: ConflictResolution.MERGE,
      fieldValues: { priority: 'HIGH' },
    });
    expect(result.merged.priority).toBe('HIGH');
    expect(result.unresolved).toHaveLength(0);
  });

  it('unions tags without losing either side’s additions', () => {
    const local: Snap = { ...base, tags: ['electrical', 'urgent'] };
    const server: Snap = { ...base, tags: ['electrical', 'annual'] };
    const diffs = diffRecords(base, local, server);

    const result = mergeRecords({ diffs, local, server, strategy: ConflictResolution.MERGE });
    expect(result.merged.tags).toEqual(['electrical', 'annual', 'urgent']);
  });
});

describe('autoMerge', () => {
  const makeConflict = (local: Snap, server: Snap) =>
    buildConflict({
      operationId: 'OP1',
      entity: 'INSPECTION',
      entityId: 'INS1',
      baseVersion: 1 as never,
      serverVersion: 2 as never,
      base,
      local,
      server,
      serverUpdatedAt: '2026-07-24T10:00:00.000Z',
      now: '2026-07-24T10:05:00.000Z',
    });

  it('resolves without human input when the two sides touched different fields', () => {
    const conflict = makeConflict(
      { ...base, notes: 'Inspector note' },
      { ...base, assignedToId: 'USER2' },
    );

    expect(conflict.isAutoResolvable).toBe(true);
    const merged = autoMerge(conflict);
    expect(merged).not.toBeNull();
    // Both edits survive — this is the whole point.
    expect(merged!.notes).toBe('Inspector note');
    expect(merged!.assignedToId).toBe('USER2');
  });

  it('refuses to auto-merge a real conflict', () => {
    const conflict = makeConflict(
      { ...base, priority: 'CRITICAL' },
      { ...base, priority: 'LOW' },
    );
    expect(conflict.isAutoResolvable).toBe(false);
    expect(autoMerge(conflict)).toBeNull();
  });
});
