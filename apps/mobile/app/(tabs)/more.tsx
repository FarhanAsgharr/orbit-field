/**
 * Settings and account.
 *
 * Sync and storage controls sit above appearance, because those are the ones
 * inspectors actually change — usually while standing somewhere with bad signal
 * trying to work out why something has not uploaded.
 */

import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Switch, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Application from 'expo-application';
import { formatBytes, formatRelativeTime } from '@orbit/utils';
import { Badge, Button, Card, Divider, Txt } from '../../src/components/ui';
import { useTheme, useThemePreference } from '../../src/theme/ThemeProvider';
import { useRuntime, useSession } from '../../src/stores/session.store';
import { useLiveQuery, invalidateQueries } from '../../src/hooks/useLiveQuery';
import { storage, STORAGE_KEYS } from '../../src/lib/storage';

export default function MoreScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);
  const syncStatus = useSession((s) => s.syncStatus);
  const { preference, setPreference } = useThemePreference();

  const [wifiOnly, setWifiOnly] = useState(
    () => storage.getBoolean(STORAGE_KEYS.SYNC_WIFI_ONLY) ?? true,
  );
  const [autoSync, setAutoSync] = useState(
    () => storage.getBoolean(STORAGE_KEYS.SYNC_AUTO) ?? true,
  );

  const stats = useLiveQuery(() => ({
    storageBytes: runtime.repositories.attachments.localStorageBytes(),
    dbBytes: runtime.db.sizeBytes(),
    queued: runtime.outbox.counts(),
    templates: runtime.repositories.templates.count(),
  }), []);

  const pendingWork = stats.queued.pending + stats.queued.retrying + stats.queued.conflicted;

  /**
   * Sign out.
   *
   * Blocked while unsent work exists unless the user explicitly overrides.
   * Signing out does not delete anything, but people assume it does, and an
   * inspector who signs out believing their day is saved when it is queued is
   * exactly the failure this app must not have.
   */
  const handleLogout = useCallback(() => {
    if (pendingWork > 0) {
      Alert.alert(
        'You have unsynced work',
        `${pendingWork} change${pendingWork === 1 ? '' : 's'} have not reached the server yet. They stay on this device and will upload when you sign back in, but nobody else can see them until then.`,
        [
          { text: 'Stay signed in', style: 'cancel' },
          { text: 'Sign out anyway', style: 'destructive', onPress: () => void logout() },
        ],
      );
      return;
    }

    Alert.alert('Sign out?', 'Your downloaded inspections stay on this device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void logout() },
    ]);
  }, [pendingWork, logout]);

  const freeStorage = useCallback(() => {
    Alert.alert(
      'Free up space?',
      'Removes photos and videos from this device that have already been uploaded and belong to closed inspections. Nothing unsent is touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Free space',
          onPress: () => {
            void (async () => {
              const result = await runtime.uploader.evictConfirmedFiles(30);
              invalidateQueries();
              Alert.alert(
                'Space freed',
                result.count === 0
                  ? 'Nothing could be safely removed yet.'
                  : `Removed ${result.count} file${result.count === 1 ? '' : 's'}, freeing ${formatBytes(result.freedBytes)}.`,
              );
            })();
          },
        },
      ],
    );
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
    >
      <Txt variant="title">More</Txt>

      {/* --- account --- */}
      <Card>
        <View style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <View
              style={{
                width: 52,
                height: 52,
                borderRadius: 26,
                backgroundColor: theme.colors.accentMuted,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Txt variant="heading" color="accent">
                {(session?.user.firstName?.[0] ?? '') + (session?.user.lastName?.[0] ?? '')}
              </Txt>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="subheading">
                {session?.user.firstName} {session?.user.lastName}
              </Txt>
              <Txt variant="caption" color="muted" numberOfLines={1}>
                {session?.user.email}
              </Txt>
              <View style={{ flexDirection: 'row', gap: theme.spacing.xs, marginTop: 4 }}>
                <Badge label={String(session?.user.role ?? 'INSPECTOR')} tone="accent" />
                {session?.organization.name ? (
                  <Badge label={session.organization.name} tone="neutral" />
                ) : null}
              </View>
            </View>
          </View>
        </View>
      </Card>

      {/* --- sync settings --- */}
      <View style={{ gap: theme.spacing.md }}>
        <Txt variant="subheading">Sync</Txt>
        <Card padded={false}>
          <ToggleRow
            label="Upload media on Wi-Fi only"
            hint="Holds photos and videos back until you are on an unmetered connection. Answers always sync immediately."
            value={wifiOnly}
            onChange={(next) => {
              setWifiOnly(next);
              storage.set(STORAGE_KEYS.SYNC_WIFI_ONLY, next);
            }}
          />
          <Divider />
          <ToggleRow
            label="Sync automatically"
            hint="Syncs in the background when the connection returns."
            value={autoSync}
            onChange={(next) => {
              setAutoSync(next);
              storage.set(STORAGE_KEYS.SYNC_AUTO, next);
            }}
          />
          <Divider />
          <LinkRow
            label="Sync details"
            value={
              syncStatus?.lastSuccessfulSyncAt
                ? formatRelativeTime(syncStatus.lastSuccessfulSyncAt)
                : 'Never synced'
            }
            onPress={() => router.push('/(tabs)/sync')}
          />
        </Card>
      </View>

      {/* --- storage --- */}
      <View style={{ gap: theme.spacing.md }}>
        <Txt variant="subheading">Storage</Txt>
        <Card>
          <View style={{ gap: theme.spacing.sm }}>
            <InfoRow label="Photos & videos" value={formatBytes(stats.storageBytes)} />
            <InfoRow label="Database" value={formatBytes(stats.dbBytes)} />
            <InfoRow label="Templates downloaded" value={String(stats.templates)} />
            <InfoRow
              label="Queued changes"
              value={pendingWork === 0 ? 'None' : String(pendingWork)}
            />
            <Button
              label="Free up space"
              variant="secondary"
              onPress={freeStorage}
              fullWidth
              style={{ marginTop: theme.spacing.sm }}
            />
          </View>
        </Card>
      </View>

      {/* --- appearance --- */}
      <View style={{ gap: theme.spacing.md }}>
        <Txt variant="subheading">Appearance</Txt>
        <Card padded={false}>
          {(['system', 'light', 'dark'] as const).map((option, index) => (
            <View key={option}>
              {index > 0 ? <Divider /> : null}
              <Pressable
                onPress={() => setPreference(option)}
                accessibilityRole="radio"
                accessibilityState={{ selected: preference === option }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: theme.spacing.lg,
                  minHeight: theme.touchTarget.comfortable,
                }}
              >
                <Txt variant="body">
                  {option === 'system' ? 'Match device' : option === 'light' ? 'Light' : 'Dark'}
                </Txt>
                {preference === option ? <Txt color="accent">✓</Txt> : null}
              </Pressable>
            </View>
          ))}
        </Card>
      </View>

      {/* --- account actions --- */}
      <View style={{ gap: theme.spacing.md }}>
        <Card padded={false}>
          <LinkRow label="Change password" onPress={() => router.push('/account/password')} />
          <Divider />
          <LinkRow label="Registered devices" onPress={() => router.push('/account/devices')} />
        </Card>

        <Button label="Sign out" variant="danger" onPress={handleLogout} fullWidth />

        <Txt variant="micro" color="muted" style={{ textAlign: 'center' }}>
          Orbit Field {Application.nativeApplicationVersion ?? '1.0.0'} (
          {Application.nativeBuildVersion ?? 'dev'})
        </Txt>
      </View>
    </ScrollView>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.lg,
        padding: theme.spacing.lg,
        minHeight: theme.touchTarget.comfortable,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="body">{label}</Txt>
        {hint ? (
          <Txt variant="micro" color="muted">
            {hint}
          </Txt>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: theme.colors.accent, false: theme.colors.borderStrong }}
      />
    </View>
  );
}

function LinkRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value?: string;
  onPress: () => void;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: theme.spacing.lg,
        minHeight: theme.touchTarget.comfortable,
        gap: theme.spacing.md,
      }}
    >
      <Txt variant="body">{label}</Txt>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        {value ? (
          <Txt variant="caption" color="muted">
            {value}
          </Txt>
        ) : null}
        <Txt color="muted">›</Txt>
      </View>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }): React.ReactElement {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
      <Txt variant="caption" color="secondary">
        {label}
      </Txt>
      <Txt variant="captionStrong">{value}</Txt>
    </View>
  );
}
