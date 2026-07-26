/**
 * Dashboard.
 *
 * Answers one question in the first screenful: *what do I need to do today, and
 * is my work safe?* Everything else is secondary.
 *
 * The device-state row (connection, GPS, storage, queue) is given real estate
 * that would be excessive in an office app. Here it is load-bearing: an
 * inspector needs to know before driving to a remote site whether their morning
 * has actually reached the server.
 */

import { InspectionStatus } from '@orbit/types';
import { formatBytes, formatRelativeTime } from '@orbit/utils';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { InspectionRow } from '../../src/components/InspectionRow';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  ProgressBar,
  statusPresentation,
  Txt,
} from '../../src/components/ui';
import { useLiveQuery, useRefresh } from '../../src/hooks/useLiveQuery';
import { getNetworkState } from '../../src/lib/network';
import { useRuntime, useSession } from '../../src/stores/session.store';
import { useTheme } from '../../src/theme/ThemeProvider';

export default function DashboardScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const session = useSession((s) => s.session);
  const syncStatus = useSession((s) => s.syncStatus);

  const userId = runtime.identity.userId;

  const data = useLiveQuery(() => {
    const inspections = runtime.repositories.inspections;
    return {
      counts: inspections.statusCounts(userId),
      overdue: inspections.overdueCount(userId),
      dueToday: inspections.dueTodayCount(userId),
      upNext: inspections.list({
        assignedToId: userId,
        status: [
          InspectionStatus.IN_PROGRESS,
          InspectionStatus.SCHEDULED,
          InspectionStatus.REJECTED,
        ],
        sortBy: 'dueAt',
        sortDir: 'asc',
        limit: 5,
      }),
      pendingSync: inspections.pendingSync().length,
      storageBytes: runtime.repositories.attachments.localStorageBytes(),
      pendingUploads: runtime.repositories.attachments.pendingUploadCount(),
      outbox: runtime.outbox.counts(),
    };
  }, [userId]);

  const { refreshing, refresh } = useRefresh(
    useCallback(async () => {
      await runtime.engine.sync('MANUAL');
    }, [runtime]),
  );

  const network = getNetworkState();

  const completed =
    (data.counts[InspectionStatus.APPROVED] ?? 0) + (data.counts[InspectionStatus.SUBMITTED] ?? 0);
  const open =
    (data.counts[InspectionStatus.IN_PROGRESS] ?? 0) +
    (data.counts[InspectionStatus.SCHEDULED] ?? 0) +
    (data.counts[InspectionStatus.DRAFT] ?? 0);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }, []);

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
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={theme.colors.accent}
        />
      }
    >
      {/* --- header --- */}
      <View style={{ gap: theme.spacing.xxs }}>
        <Txt variant="caption" color="muted">
          {greeting}
        </Txt>
        <Txt variant="display">{session?.user.firstName ?? 'Inspector'}</Txt>
      </View>

      {/* --- work summary --- */}
      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <StatTile
          label="Open"
          value={open}
          tone="accent"
          onPress={() => router.push('/(tabs)/inspections')}
        />
        <StatTile
          label="Due today"
          value={data.dueToday}
          tone={data.dueToday > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Overdue"
          value={data.overdue}
          tone={data.overdue > 0 ? 'danger' : 'neutral'}
        />
      </View>

      {/* --- device & sync state ---------------------------------------
          Prominent by design: this is the answer to "is my work safe?" */}
      <Card>
        <View style={{ gap: theme.spacing.md }}>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Txt variant="subheading">Device status</Txt>
            <Badge
              label={
                network.isConnected ? (network.isMetered ? 'Mobile data' : 'Online') : 'Offline'
              }
              tone={network.isConnected ? (network.isMetered ? 'warning' : 'success') : 'danger'}
              icon={network.isConnected ? '●' : '○'}
            />
          </View>

          <Divider />

          <StatusLine
            label="Unsynced changes"
            value={
              data.outbox.pending + data.outbox.retrying === 0
                ? 'All changes saved to server'
                : `${data.outbox.pending + data.outbox.retrying} waiting to upload`
            }
            tone={data.outbox.pending + data.outbox.retrying === 0 ? 'success' : 'warning'}
          />

          {data.outbox.conflicted > 0 ? (
            <StatusLine
              label="Needs your attention"
              value={`${data.outbox.conflicted} conflict${data.outbox.conflicted === 1 ? '' : 's'} to resolve`}
              tone="danger"
            />
          ) : null}

          {data.outbox.deadLetter > 0 ? (
            <StatusLine
              label="Rejected"
              value={`${data.outbox.deadLetter} change${data.outbox.deadLetter === 1 ? '' : 's'} could not be saved`}
              tone="danger"
            />
          ) : null}

          <StatusLine
            label="Photos & videos"
            value={
              data.pendingUploads === 0 ? 'All uploaded' : `${data.pendingUploads} pending upload`
            }
            tone={data.pendingUploads === 0 ? 'success' : 'warning'}
          />

          <StatusLine
            label="On-device storage"
            value={formatBytes(data.storageBytes)}
            tone="neutral"
          />

          <StatusLine
            label="Last synced"
            value={
              syncStatus?.lastSuccessfulSyncAt
                ? formatRelativeTime(syncStatus.lastSuccessfulSyncAt)
                : 'Never'
            }
            tone={syncStatus?.lastSuccessfulSyncAt ? 'neutral' : 'warning'}
          />

          {syncStatus?.state === 'SYNCING' ? (
            <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.xs }}>
              <ProgressBar value={syncStatus.progress ?? 0} label="Sync progress" />
              <Txt variant="micro" color="muted">
                {syncStatus.currentPhase === 'PUSH'
                  ? 'Uploading your changes…'
                  : syncStatus.currentPhase === 'PULL'
                    ? 'Downloading updates…'
                    : 'Uploading photos…'}
              </Txt>
            </View>
          ) : (
            <Button
              label={network.isConnected ? 'Sync now' : 'Waiting for connection'}
              variant="secondary"
              onPress={refresh}
              disabled={!network.isConnected}
              fullWidth
            />
          )}
        </View>
      </Card>

      {/* --- up next --- */}
      <View style={{ gap: theme.spacing.md }}>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Txt variant="subheading">Up next</Txt>
          <Button
            label="See all"
            variant="ghost"
            size="small"
            onPress={() => router.push('/(tabs)/inspections')}
          />
        </View>

        {data.upNext.length === 0 ? (
          <Card>
            <EmptyState
              icon="✓"
              title="Nothing outstanding"
              message="You have no open inspections assigned. Pull down to check for new work."
            />
          </Card>
        ) : (
          <View style={{ gap: theme.spacing.sm }}>
            {data.upNext.map((item) => (
              <InspectionRow
                key={item.id}
                item={item}
                onPress={() => router.push(`/inspection/${item.id}`)}
              />
            ))}
          </View>
        )}
      </View>

      {/* --- completion summary --- */}
      <Card>
        <View style={{ gap: theme.spacing.md }}>
          <Txt variant="subheading">This period</Txt>
          <View style={{ gap: theme.spacing.sm }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Txt variant="caption" color="secondary">
                Completed
              </Txt>
              <Txt variant="captionStrong">{completed}</Txt>
            </View>
            <ProgressBar
              value={completed + open > 0 ? completed / (completed + open) : 0}
              tone="success"
              label="Completion rate"
            />
            <Txt variant="micro" color="muted">
              {completed + open > 0
                ? `${Math.round((completed / (completed + open)) * 100)}% of assigned work complete`
                : 'No work assigned yet'}
            </Txt>
          </View>

          <Divider />

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {Object.entries(data.counts).map(([status, count]) => {
              const presentation = statusPresentation(status as InspectionStatus);
              return (
                <Badge
                  key={status}
                  label={`${presentation.label} · ${count}`}
                  tone={presentation.tone}
                  icon={presentation.icon}
                />
              );
            })}
          </View>
        </View>
      </Card>
    </ScrollView>
  );
}

function StatTile({
  label,
  value,
  tone,
  onPress,
}: {
  label: string;
  value: number;
  tone: 'accent' | 'warning' | 'danger' | 'neutral';
  onPress?: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const colorMap = {
    accent: theme.colors.accent,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    neutral: theme.colors.textSecondary,
  };

  return (
    <Card style={{ flex: 1 }} onPress={onPress} padded={false}>
      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.xxs }}>
        <Txt variant="displayLarge" style={{ color: colorMap[tone] }}>
          {value}
        </Txt>
        <Txt variant="micro" color="muted">
          {label.toUpperCase()}
        </Txt>
      </View>
    </Card>
  );
}

function StatusLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}): React.ReactElement {
  const theme = useTheme();
  const dot = {
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    neutral: theme.colors.textMuted,
  }[tone];

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <Txt variant="caption" color="secondary" style={{ flex: 1 }}>
        {label}
      </Txt>
      <Txt variant="caption" numberOfLines={1}>
        {value}
      </Txt>
    </View>
  );
}
