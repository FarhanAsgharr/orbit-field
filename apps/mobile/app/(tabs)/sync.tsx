/**
 * Sync status.
 *
 * This screen exists because "it didn't sync" is the single most common field
 * support call, and the honest answer is usually knowable on the device. It
 * shows exactly what is queued, what failed and why, and what needs a human
 * decision — rather than a spinner and a shrug.
 */

import React, { useCallback } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatBytes, formatDuration, formatRelativeTime } from '@orbit/utils';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ProgressBar,
  Txt,
} from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useRuntime, useSession } from '../../src/stores/session.store';
import { useLiveQuery, useRefresh, invalidateQueries } from '../../src/hooks/useLiveQuery';
import { getNetworkState } from '../../src/lib/network';

interface SyncLogRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  pushed_count: number;
  pulled_count: number;
  conflict_count: number;
  uploaded_count: number;
  duration_ms: number | null;
  outcome: string | null;
  error: string | null;
}

interface DeadLetterRow {
  id: string;
  entity: string;
  entity_id: string;
  last_error: string | null;
  last_error_code: string | null;
  attempts: number;
  updated_at: string;
}

export default function SyncScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const syncStatus = useSession((s) => s.syncStatus);

  const data = useLiveQuery(() => ({
    counts: runtime.outbox.counts(),
    uploads: runtime.repositories.attachments.pendingUploadBytes(),
    pendingUploadCount: runtime.repositories.attachments.pendingUploadCount(),
    conflicts: runtime.db.getAll<{ operation_id: string; entity: string; entity_id: string; detected_at: string }>(
      `SELECT operation_id, entity, entity_id, detected_at
         FROM conflicts WHERE resolved_at IS NULL
        ORDER BY detected_at DESC LIMIT 50`,
    ),
    deadLetters: runtime.db.getAll<DeadLetterRow>(
      `SELECT id, entity, entity_id, last_error, last_error_code, attempts, updated_at
         FROM outbox WHERE state = 'DEAD_LETTER'
        ORDER BY updated_at DESC LIMIT 50`,
    ),
    history: runtime.db.getAll<SyncLogRow>(
      `SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 20`,
    ),
    cursor: runtime.db.getCursor(),
  }), []);

  const { refreshing, refresh } = useRefresh(
    useCallback(async () => {
      await runtime.engine.sync('MANUAL');
    }, [runtime]),
  );

  const network = getNetworkState();
  const queued = data.counts.pending + data.counts.retrying;

  const retryAll = useCallback(() => {
    runtime.outbox.retryFailed();
    runtime.uploader.retryFailed();
    invalidateQueries();
    void runtime.engine.sync('MANUAL');
  }, [runtime]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        padding: theme.spacing.lg,
        paddingTop: insets.top + theme.spacing.lg,
        paddingBottom: theme.spacing.huge,
        gap: theme.spacing.lg,
      }}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.colors.accent} />
      }
    >
      <Txt variant="title">Sync</Txt>

      {/* --- headline state --- */}
      <Card>
        <View style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Txt variant="subheading">
              {syncStatus?.state === 'SYNCING'
                ? 'Syncing…'
                : queued === 0 && data.pendingUploadCount === 0
                  ? 'Everything is saved'
                  : 'Changes waiting'}
            </Txt>
            <Badge
              label={network.isConnected ? (network.isMetered ? 'Mobile data' : 'Online') : 'Offline'}
              tone={network.isConnected ? (network.isMetered ? 'warning' : 'success') : 'danger'}
              icon={network.isConnected ? '●' : '○'}
            />
          </View>

          {syncStatus?.state === 'SYNCING' ? (
            <View style={{ gap: theme.spacing.xs }}>
              <ProgressBar value={syncStatus.progress ?? 0} />
              <Txt variant="micro" color="muted">
                {syncStatus.currentPhase === 'PUSH'
                  ? 'Sending your changes'
                  : syncStatus.currentPhase === 'PULL'
                    ? 'Receiving updates'
                    : 'Uploading media'}
              </Txt>
            </View>
          ) : null}

          <Divider />

          <Row label="Queued changes" value={String(queued)} tone={queued > 0 ? 'warning' : 'success'} />
          <Row
            label="Media to upload"
            value={
              data.pendingUploadCount === 0
                ? 'None'
                : `${data.pendingUploadCount} · ${formatBytes(data.uploads.total - data.uploads.uploaded)}`
            }
            tone={data.pendingUploadCount > 0 ? 'warning' : 'success'}
          />
          <Row
            label="Conflicts"
            value={String(data.conflicts.length)}
            tone={data.conflicts.length > 0 ? 'danger' : 'success'}
          />
          <Row
            label="Rejected"
            value={String(data.deadLetters.length)}
            tone={data.deadLetters.length > 0 ? 'danger' : 'success'}
          />
          <Row
            label="Last synced"
            value={
              syncStatus?.lastSuccessfulSyncAt
                ? formatRelativeTime(syncStatus.lastSuccessfulSyncAt)
                : 'Never'
            }
            tone="neutral"
          />
          <Row label="Sync position" value={`#${data.cursor}`} tone="neutral" />

          <Button
            label={network.isConnected ? 'Sync now' : 'Waiting for connection'}
            onPress={refresh}
            disabled={!network.isConnected || syncStatus?.state === 'SYNCING'}
            busy={syncStatus?.state === 'SYNCING'}
            fullWidth
          />
        </View>
      </Card>

      {/* --- conflicts: the only thing here that truly needs a human --- */}
      {data.conflicts.length > 0 ? (
        <View style={{ gap: theme.spacing.md }}>
          <Txt variant="subheading" color="danger">
            Needs your decision
          </Txt>
          <Txt variant="caption" color="secondary">
            Someone else changed these records while you were offline. Nothing has been overwritten —
            review each one and choose what to keep.
          </Txt>

          {data.conflicts.map((conflict) => (
            <Card
              key={conflict.operation_id}
              onPress={() => router.push(`/conflict/${conflict.operation_id}`)}
            >
              <View style={{ gap: theme.spacing.xs }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Badge label={conflict.entity} tone="danger" icon="⚠" />
                  <Txt variant="micro" color="muted">
                    {formatRelativeTime(conflict.detected_at)}
                  </Txt>
                </View>
                <Txt variant="caption">Tap to compare and resolve</Txt>
              </View>
            </Card>
          ))}
        </View>
      ) : null}

      {/* --- rejected --- */}
      {data.deadLetters.length > 0 ? (
        <View style={{ gap: theme.spacing.md }}>
          <Txt variant="subheading" color="danger">
            Could not be saved
          </Txt>
          <Txt variant="caption" color="secondary">
            The server refused these changes. They are still stored on this device.
          </Txt>

          {data.deadLetters.map((entry) => (
            <Card key={entry.id}>
              <View style={{ gap: theme.spacing.xs }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Badge label={entry.entity} tone="danger" icon="✕" />
                  <Txt variant="micro" color="muted">
                    {entry.attempts} attempt{entry.attempts === 1 ? '' : 's'}
                  </Txt>
                </View>
                <Txt variant="caption">{entry.last_error ?? 'The change was rejected.'}</Txt>
                {entry.last_error_code ? (
                  <Txt variant="micro" color="muted">
                    {entry.last_error_code}
                  </Txt>
                ) : null}
              </View>
            </Card>
          ))}

          <Button label="Retry all" variant="secondary" onPress={retryAll} fullWidth />
        </View>
      ) : null}

      {/* --- history: the field-support view --- */}
      <View style={{ gap: theme.spacing.md }}>
        <Txt variant="subheading">Recent activity</Txt>

        {data.history.length === 0 ? (
          <Card>
            <EmptyState icon="⇅" title="No sync history yet" message="Sync runs will be listed here." />
          </Card>
        ) : (
          <Card padded={false}>
            {data.history.map((entry, index) => (
              <View key={entry.id}>
                {index > 0 ? <Divider /> : null}
                <View style={{ padding: theme.spacing.lg, gap: theme.spacing.xs }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Badge
                      label={entry.outcome ?? 'RUNNING'}
                      tone={
                        entry.outcome === 'SUCCESS'
                          ? 'success'
                          : entry.outcome === 'PARTIAL'
                            ? 'warning'
                            : entry.outcome === 'FAILED'
                              ? 'danger'
                              : 'neutral'
                      }
                    />
                    <Txt variant="micro" color="muted">
                      {formatRelativeTime(entry.started_at)}
                    </Txt>
                  </View>

                  <Txt variant="caption" color="secondary">
                    {entry.pushed_count} sent · {entry.pulled_count} received
                    {entry.uploaded_count > 0 ? ` · ${entry.uploaded_count} uploaded` : ''}
                    {entry.conflict_count > 0 ? ` · ${entry.conflict_count} conflicts` : ''}
                  </Txt>

                  <Txt variant="micro" color="muted">
                    {entry.trigger}
                    {entry.duration_ms !== null ? ` · ${formatDuration(entry.duration_ms)}` : ''}
                  </Txt>

                  {entry.error ? (
                    <Txt variant="micro" color="danger">
                      {entry.error}
                    </Txt>
                  ) : null}
                </View>
              </View>
            ))}
          </Card>
        )}
      </View>
    </ScrollView>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}): React.ReactElement {
  const theme = useTheme();
  const color = {
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    neutral: theme.colors.textPrimary,
  }[tone];

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Txt variant="caption" color="secondary">
        {label}
      </Txt>
      <Txt variant="captionStrong" style={{ color }}>
        {value}
      </Txt>
    </View>
  );
}
