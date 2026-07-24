/**
 * Registered devices.
 *
 * Revoking a device is destructive in a way that is not obvious: it does not
 * just sign that device out, it stops it syncing, so anything queued on it is
 * stranded until someone signs in again. The confirmation says that explicitly
 * rather than asking a bland "are you sure?".
 */

import React, { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppError } from '@orbit/shared';
import { formatRelativeTime } from '@orbit/utils';
import { Badge, Button, Card, EmptyState, LoadingState, Txt } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useRuntime } from '../../src/stores/session.store';
import { getNetworkState } from '../../src/lib/network';

interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  model: string | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export default function DevicesScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();

  const [devices, setDevices] = useState<DeviceRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getNetworkState().isConnected) {
      setError('Device management needs a connection.');
      setLoading(false);
      return;
    }

    setError(null);
    try {
      const result = await runtime.api.get<DeviceRecord[]>('/devices');
      setDevices(result);
    } catch (err) {
      setError(err instanceof AppError ? err.message : 'Could not load your devices.');
    } finally {
      setLoading(false);
    }
  }, [runtime]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    (device: DeviceRecord) => {
      const isCurrent = device.id === runtime.identity.deviceId;

      Alert.alert(
        isCurrent ? 'Revoke this device?' : `Revoke ${device.name}?`,
        isCurrent
          ? 'You will be signed out immediately. Any inspection changes on this device that have not synced will stay here until you sign in again.'
          : 'That device will be signed out and will stop syncing. Anything it has not yet uploaded will stay on it until someone signs in there again.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Revoke',
            style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  await runtime.api.delete(`/devices/${device.id}`);
                  await load();
                } catch (err) {
                  Alert.alert(
                    'Could not revoke',
                    err instanceof AppError ? err.message : 'Try again.',
                  );
                }
              })();
            },
          },
        ],
      );
    },
    [runtime, load],
  );

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
        <RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={theme.colors.accent} />
      }
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Txt variant="caption" color="accent" onPress={() => router.back()} accessibilityRole="button">
          ‹ Back
        </Txt>
      </View>

      <Txt variant="title">Registered devices</Txt>
      <Txt variant="caption" color="secondary">
        Devices signed in to your account. Revoke any you no longer use.
      </Txt>

      {loading && !devices ? <LoadingState label="Loading devices" /> : null}

      {error ? (
        <Card>
          <View style={{ gap: theme.spacing.md }}>
            <Txt variant="caption" color="warning">
              {error}
            </Txt>
            <Button label="Try again" variant="secondary" onPress={() => void load()} />
          </View>
        </Card>
      ) : null}

      {devices?.length === 0 ? (
        <Card>
          <EmptyState icon="▢" title="No devices" message="No devices are registered to your account." />
        </Card>
      ) : null}

      {devices?.map((device) => {
        const isCurrent = device.id === runtime.identity.deviceId;
        return (
          <Card key={device.id}>
            <View style={{ gap: theme.spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.md }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt variant="subheading" numberOfLines={1}>
                    {device.name}
                  </Txt>
                  <Txt variant="caption" color="muted">
                    {device.model ?? device.platform} · {device.platform} {device.osVersion}
                  </Txt>
                </View>
                {isCurrent ? <Badge label="This device" tone="accent" icon="●" /> : null}
                {device.revokedAt ? <Badge label="Revoked" tone="danger" icon="✕" /> : null}
              </View>

              <View style={{ gap: theme.spacing.xs }}>
                <Txt variant="micro" color="muted">
                  App version {device.appVersion}
                </Txt>
                <Txt variant="micro" color="muted">
                  Last active{' '}
                  {device.lastSeenAt ? formatRelativeTime(device.lastSeenAt) : 'unknown'}
                </Txt>
                <Txt variant="micro" color="muted">
                  Last synced{' '}
                  {device.lastSyncAt ? formatRelativeTime(device.lastSyncAt) : 'never'}
                </Txt>
              </View>

              {!device.revokedAt ? (
                <Button
                  label={isCurrent ? 'Sign out this device' : 'Revoke'}
                  variant="danger"
                  onPress={() => revoke(device)}
                  fullWidth
                />
              ) : null}
            </View>
          </Card>
        );
      })}
    </ScrollView>
  );
}
