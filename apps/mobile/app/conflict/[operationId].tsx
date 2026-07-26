/**
 * Conflict resolution.
 *
 * The UI the three-way merge engine exists to serve. Design rules, in order of
 * importance:
 *
 *  1. **Nothing is pre-selected for genuinely conflicting fields.** A default
 *     selection gets accepted without reading, and the whole point of stopping
 *     here is that a human must actually choose.
 *  2. **Auto-resolved fields are shown, not hidden.** The user needs to see that
 *     their notes edit survived even though the supervisor's reassignment also
 *     applied — otherwise "merge" feels like a coin toss.
 *  3. **Neither side is labelled "correct".** Local is "Your version"; server is
 *     "Their version" with the name of who changed it where known.
 */

import { ConflictResolution, type FieldDiff, type JsonValue } from '@orbit/types';
import { formatRelativeTime } from '@orbit/utils';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Divider, EmptyState, Txt } from '../../src/components/ui';
import { invalidateQueries, useLiveQuery } from '../../src/hooks/useLiveQuery';
import { useRuntime } from '../../src/stores/session.store';
import { useTheme } from '../../src/theme/ThemeProvider';

type Side = 'LOCAL' | 'SERVER';

interface ConflictRow {
  operation_id: string;
  entity: string;
  entity_id: string;
  base_version: number | null;
  server_version: number;
  local_record: string;
  server_record: string;
  diffs: string;
  is_auto_resolvable: number;
  server_updated_at: string | null;
  server_updated_by: string | null;
  detected_at: string;
}

/** Render any JSON value as something a human can compare at a glance. */
function displayValue(value: JsonValue): string {
  if (value === null || value === undefined) return '— empty —';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (value.trim() === '') return '— empty —';
    // ISO timestamps are unreadable side-by-side; show them as dates.
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
    }
    return value;
  }
  if (Array.isArray(value)) return value.length === 0 ? '— none —' : value.map(String).join(', ');
  return JSON.stringify(value, null, 2);
}

export default function ConflictScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const { operationId } = useLocalSearchParams<{ operationId: string }>();

  const [choices, setChoices] = useState<Record<string, Side>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const conflict = useLiveQuery(
    () =>
      runtime.db.getFirst<ConflictRow>(`SELECT * FROM conflicts WHERE operation_id = ?`, [
        operationId ?? '',
      ]),
    [operationId],
  );

  const diffs = useMemo<FieldDiff[]>(() => {
    if (!conflict) return [];
    try {
      return JSON.parse(conflict.diffs) as FieldDiff[];
    } catch {
      return [];
    }
  }, [conflict]);

  const conflicting = diffs.filter((d) => d.isConflicting);
  const autoResolved = diffs.filter((d) => !d.isConflicting);

  const allDecided = conflicting.every((d) => choices[d.path] !== undefined);

  /**
   * Apply the resolution.
   *
   * Written locally first, then the queued operation is rebased onto the
   * server's current version so the replay applies cleanly instead of
   * conflicting again immediately.
   */
  const resolve = useCallback(
    async (strategy: ConflictResolution) => {
      if (!conflict) return;
      setBusy(true);
      setError(null);

      try {
        const _local = JSON.parse(conflict.local_record) as Record<string, JsonValue>;
        const server = JSON.parse(conflict.server_record) as Record<string, JsonValue>;

        const merged: Record<string, JsonValue> = { ...server };
        for (const diff of diffs) {
          const side =
            strategy === ConflictResolution.KEEP_LOCAL
              ? 'LOCAL'
              : strategy === ConflictResolution.KEEP_SERVER
                ? 'SERVER'
                : (choices[diff.path] ??
                  (diff.autoResolution === ConflictResolution.KEEP_LOCAL ? 'LOCAL' : 'SERVER'));

          merged[diff.path] = side === 'LOCAL' ? diff.localValue : diff.serverValue;
        }

        runtime.db.write(() => {
          runtime.db.run(
            `UPDATE conflicts SET resolved_at = ?, resolution = ? WHERE operation_id = ?`,
            [new Date().toISOString(), strategy, conflict.operation_id],
          );

          // Rebase onto the server version so the replayed operation is no
          // longer stale.
          runtime.outbox.requeueAfterResolution(
            conflict.operation_id,
            merged,
            conflict.server_version,
          );

          for (const table of [
            'inspections',
            'inspection_responses',
            'attachments',
            'signatures',
          ]) {
            runtime.db.run(`UPDATE ${table} SET has_conflict = 0 WHERE id = ?`, [
              conflict.entity_id,
            ]);
          }
        });

        invalidateQueries();
        void runtime.engine.sync('MANUAL');
        router.back();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not apply your choice.');
      } finally {
        setBusy(false);
      }
    },
    [conflict, diffs, choices, runtime, router],
  );

  if (!conflict) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <EmptyState
          icon="✓"
          title="Already resolved"
          message="This conflict is no longer outstanding."
          action={<Button label="Back" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        padding: theme.spacing.lg,
        paddingTop: insets.top + theme.spacing.lg,
        paddingBottom: theme.spacing.huge,
        gap: theme.spacing.lg,
      }}
    >
      <View style={{ gap: theme.spacing.sm }}>
        <Txt variant="title">Resolve conflict</Txt>
        <Txt variant="caption" color="secondary">
          This {conflict.entity.toLowerCase()} was changed on the server while you were offline.
          Nothing has been overwritten — your version is still safe on this device.
        </Txt>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          <Badge label={`Detected ${formatRelativeTime(conflict.detected_at)}`} tone="neutral" />
          {conflict.server_updated_by ? (
            <Badge label={`Changed by ${conflict.server_updated_by}`} tone="info" />
          ) : null}
        </View>
      </View>

      {error ? (
        <View
          style={{
            backgroundColor: theme.colors.dangerMuted,
            borderRadius: theme.radius.md,
            padding: theme.spacing.lg,
          }}
        >
          <Txt variant="caption" color="danger">
            {error}
          </Txt>
        </View>
      ) : null}

      {/* --- fields needing a decision --- */}
      {conflicting.length > 0 ? (
        <View style={{ gap: theme.spacing.md }}>
          <Txt variant="subheading" color="danger">
            {conflicting.length} field{conflicting.length === 1 ? '' : 's'} need a decision
          </Txt>

          {conflicting.map((diff) => (
            <Card key={diff.path}>
              <View style={{ gap: theme.spacing.md }}>
                <Txt variant="subheading">{diff.label}</Txt>

                <ChoiceOption
                  title="Your version"
                  subtitle="Changed on this device"
                  value={displayValue(diff.localValue)}
                  selected={choices[diff.path] === 'LOCAL'}
                  onPress={() => setChoices((prev) => ({ ...prev, [diff.path]: 'LOCAL' }))}
                />

                <ChoiceOption
                  title="Their version"
                  subtitle={
                    conflict.server_updated_by
                      ? `Changed by ${conflict.server_updated_by}`
                      : 'Changed on the server'
                  }
                  value={displayValue(diff.serverValue)}
                  selected={choices[diff.path] === 'SERVER'}
                  onPress={() => setChoices((prev) => ({ ...prev, [diff.path]: 'SERVER' }))}
                />

                {/* Showing the ancestor makes the divergence comprehensible
                    rather than arbitrary. */}
                {diff.baseValue !== null && diff.baseValue !== undefined ? (
                  <View
                    style={{
                      backgroundColor: theme.colors.surfaceSunken,
                      borderRadius: theme.radius.sm,
                      padding: theme.spacing.md,
                    }}
                  >
                    <Txt variant="micro" color="muted">
                      BEFORE EITHER CHANGE
                    </Txt>
                    <Txt variant="caption" color="muted">
                      {displayValue(diff.baseValue)}
                    </Txt>
                  </View>
                ) : null}
              </View>
            </Card>
          ))}
        </View>
      ) : (
        <Card>
          <View style={{ gap: theme.spacing.sm }}>
            <Txt variant="subheading" color="success">
              No clashing edits
            </Txt>
            <Txt variant="caption" color="secondary">
              You and the server changed different fields, so both sets of changes can be kept.
            </Txt>
          </View>
        </Card>
      )}

      {/* --- automatically merged --- */}
      {autoResolved.length > 0 ? (
        <View style={{ gap: theme.spacing.md }}>
          <Txt variant="subheading">Merged automatically</Txt>
          <Txt variant="caption" color="secondary">
            Only one side changed these, so there is nothing to decide.
          </Txt>

          <Card padded={false}>
            {autoResolved.map((diff, index) => (
              <View key={diff.path}>
                {index > 0 ? <Divider /> : null}
                <View style={{ padding: theme.spacing.lg, gap: theme.spacing.xs }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <Txt variant="captionStrong">{diff.label}</Txt>
                    <Badge
                      label={
                        diff.autoResolution === ConflictResolution.KEEP_LOCAL
                          ? 'Yours kept'
                          : 'Theirs kept'
                      }
                      tone={
                        diff.autoResolution === ConflictResolution.KEEP_LOCAL ? 'accent' : 'info'
                      }
                    />
                  </View>
                  <Txt variant="caption" color="secondary">
                    {displayValue(
                      diff.autoResolution === ConflictResolution.KEEP_LOCAL
                        ? diff.localValue
                        : diff.serverValue,
                    )}
                  </Txt>
                </View>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {/* --- actions --- */}
      <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.md }}>
        <Button
          label={conflicting.length > 0 ? 'Apply my choices' : 'Merge and continue'}
          onPress={() => void resolve(ConflictResolution.MERGE)}
          disabled={conflicting.length > 0 && !allDecided}
          busy={busy}
          fullWidth
          size="large"
        />

        {conflicting.length > 0 && !allDecided ? (
          <Txt variant="micro" color="muted" style={{ textAlign: 'center' }}>
            Choose a version for each field above to continue.
          </Txt>
        ) : null}

        <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
          <Button
            label="Keep all mine"
            variant="secondary"
            onPress={() => void resolve(ConflictResolution.KEEP_LOCAL)}
            busy={busy}
            style={{ flex: 1 }}
          />
          <Button
            label="Keep all theirs"
            variant="secondary"
            onPress={() => void resolve(ConflictResolution.KEEP_SERVER)}
            busy={busy}
            style={{ flex: 1 }}
          />
        </View>

        <Button label="Decide later" variant="ghost" onPress={() => router.back()} fullWidth />
      </View>
    </ScrollView>
  );
}

function ChoiceOption({
  title,
  subtitle,
  value,
  selected,
  onPress,
}: {
  title: string;
  subtitle: string;
  value: string;
  selected: boolean;
  onPress: () => void;
}): React.ReactElement {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}: ${value}`}
      style={{
        borderWidth: 2,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.accentMuted : theme.colors.surfaceRaised,
        borderRadius: theme.radius.md,
        padding: theme.spacing.lg,
        gap: theme.spacing.xs,
        minHeight: theme.touchTarget.large,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            borderWidth: 2,
            borderColor: selected ? theme.colors.accent : theme.colors.borderStrong,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {selected ? (
            <View
              style={{
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: theme.colors.accent,
              }}
            />
          ) : null}
        </View>
        <Txt variant="captionStrong" style={{ flex: 1 }}>
          {title}
        </Txt>
      </View>

      <Txt variant="micro" color="muted">
        {subtitle}
      </Txt>

      <Txt variant="body" style={{ marginTop: theme.spacing.xs }}>
        {value}
      </Txt>
    </Pressable>
  );
}
