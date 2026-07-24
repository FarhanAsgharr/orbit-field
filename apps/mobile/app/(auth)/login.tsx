/**
 * Sign in.
 *
 * Two field-specific concessions:
 *  - The email is prefilled from the last successful sign-in. Typing an address
 *    on a phone in the rain with gloves on is genuinely difficult.
 *  - Biometric unlock is offered when previously enrolled, so a device that
 *    locks every 15 minutes does not cost the inspector a password entry each
 *    time they put it back in their pocket.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import * as LocalAuthentication from 'expo-local-authentication';
import type { DeviceInfo } from '@orbit/types';
import { Button, Field, Txt } from '../../src/components/ui';
import { useTheme } from '../../src/theme/ThemeProvider';
import { useSession } from '../../src/stores/session.store';
import { secureStorage, storage } from '../../src/lib/storage';
import { getInstallationId } from '../../src/lib/device';
import { getNetworkState } from '../../src/lib/network';

export default function LoginScreen(): React.ReactElement {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const login = useSession((s) => s.login);
  const busy = useSession((s) => s.busy);
  const error = useSession((s) => s.error);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});

  useEffect(() => {
    void (async () => {
      const last = await secureStorage.get(secureStorage.keys.LAST_EMAIL);
      if (last) setEmail(last);

      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      const optedIn = storage.getBoolean('biometric.enabled') ?? false;
      setBiometricAvailable(hasHardware && enrolled && optedIn && Boolean(last));
    })();
  }, []);

  const buildDeviceInfo = useCallback(async (): Promise<DeviceInfo> => {
    return {
      installationId: await getInstallationId(),
      name: Device.deviceName ?? `${Device.brand ?? 'Unknown'} ${Device.modelName ?? 'device'}`,
      platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
      osVersion: String(Device.osVersion ?? Platform.Version),
      appVersion: Application.nativeApplicationVersion ?? '1.0.0',
      model: Device.modelName ?? undefined,
    };
  }, []);

  const validate = useCallback((): boolean => {
    const errors: { email?: string; password?: string } = {};
    if (!email.trim()) errors.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errors.email = 'That does not look like a valid email address.';
    }
    if (!password) errors.password = 'Enter your password.';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [email, password]);

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;
    try {
      await login({
        email,
        password,
        device: await buildDeviceInfo(),
        rememberMe,
      });
    } catch {
      // The store owns the error message; nothing more to do here.
    }
  }, [validate, login, email, password, rememberMe, buildDeviceInfo]);

  /**
   * Biometric unlock.
   *
   * Gates the *stored* refresh token rather than replaying a password — the
   * password is never persisted, so there is nothing to unlock it with.
   */
  const handleBiometric = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Orbit Field',
      fallbackLabel: 'Use password',
      cancelLabel: 'Cancel',
    });
    if (!result.success) return;

    // A stored refresh token means boot() can restore the session directly.
    const refresh = await secureStorage.get(secureStorage.keys.REFRESH_TOKEN);
    if (refresh) {
      await useSession.getState().boot();
    }
  }, []);

  const offline = !getNetworkState().isConnected;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: theme.spacing.xxl,
          paddingTop: insets.top + theme.spacing.huge,
          paddingBottom: insets.bottom + theme.spacing.xxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: theme.spacing.sm, marginBottom: theme.spacing.lg }}>
          <Txt variant="displayLarge">Orbit Field</Txt>
          <Txt variant="body" color="secondary">
            Sign in to load your assigned inspections.
          </Txt>
        </View>

        {offline ? (
          <View
            style={{
              backgroundColor: theme.colors.warningMuted,
              borderRadius: theme.radius.md,
              padding: theme.spacing.lg,
              gap: theme.spacing.xs,
            }}
          >
            <Txt variant="captionStrong" color="warning">
              No connection
            </Txt>
            <Txt variant="caption" color="secondary">
              Signing in for the first time needs a connection. If you have signed in on this device
              before, your session will restore automatically once you are back in range.
            </Txt>
          </View>
        ) : null}

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

        <Field
          label="Email"
          value={email}
          onChangeText={(text) => {
            setEmail(text);
            if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: undefined }));
          }}
          error={fieldErrors.email}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="username"
          autoComplete="email"
          returnKeyType="next"
          editable={!busy}
          placeholder="you@company.com"
        />

        <Field
          label="Password"
          value={password}
          onChangeText={(text) => {
            setPassword(text);
            if (fieldErrors.password) setFieldErrors((prev) => ({ ...prev, password: undefined }));
          }}
          error={fieldErrors.password}
          secureTextEntry={!showPassword}
          textContentType="password"
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={() => void handleSubmit()}
          editable={!busy}
          placeholder="••••••••••••"
          trailing={
            <Pressable
              onPress={() => setShowPassword((v) => !v)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            >
              <Txt variant="caption" color="accent">
                {showPassword ? 'Hide' : 'Show'}
              </Txt>
            </Pressable>
          }
        />

        <Pressable
          onPress={() => setRememberMe((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: rememberMe }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            minHeight: theme.touchTarget.minimum,
          }}
        >
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: theme.radius.sm,
              borderWidth: 2,
              borderColor: rememberMe ? theme.colors.accent : theme.colors.borderStrong,
              backgroundColor: rememberMe ? theme.colors.accent : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {rememberMe ? (
              <Txt variant="captionStrong" style={{ color: theme.colors.accentText }}>
                ✓
              </Txt>
            ) : null}
          </View>
          <View style={{ flex: 1 }}>
            <Txt variant="caption">Keep me signed in</Txt>
            {/* Said plainly, because the honest reason matters to the user. */}
            <Txt variant="micro" color="muted">
              Recommended — lets the app work offline for up to 180 days.
            </Txt>
          </View>
        </Pressable>

        <Button label="Sign in" onPress={() => void handleSubmit()} busy={busy} fullWidth size="large" />

        {biometricAvailable ? (
          <Button
            label="Unlock with biometrics"
            variant="secondary"
            onPress={() => void handleBiometric()}
            fullWidth
          />
        ) : null}

        <Button
          label="Forgot password?"
          variant="ghost"
          onPress={() => {
            // Routed rather than inlined: the reset flow is three screens
            // (request, OTP, new password) and shares them with the change-
            // password path in settings.
          }}
          fullWidth
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
