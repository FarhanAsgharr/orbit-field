/**
 * Change password.
 *
 * Requires a connection: the password hash lives only on the server, so there is
 * nothing to verify against offline. Said plainly rather than failing with a
 * generic network error.
 *
 * The strength meter mirrors the server's policy exactly (`checkPasswordStrength`
 * semantics) so a password accepted here is never rejected on submit.
 */

import { AppError } from '@orbit/shared';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, ProgressBar, Txt } from '../../src/components/ui';
import { PasswordField } from '../../src/components/ui/PasswordField';
import { getNetworkState } from '../../src/lib/network';
import { useRuntime, useSession } from '../../src/stores/session.store';
import { useTheme } from '../../src/theme/ThemeProvider';

/** Client-side mirror of the server's policy. Advisory — the server decides. */
function assessPassword(
  password: string,
  context: { email?: string; firstName?: string },
): {
  score: number;
  problems: string[];
} {
  const problems: string[] = [];
  if (password.length < 12) problems.push('At least 12 characters');
  if (!/[A-Z]/.test(password)) problems.push('An uppercase letter');
  if (!/[a-z]/.test(password)) problems.push('A lowercase letter');
  if (!/\d/.test(password)) problems.push('A number');

  const lower = password.toLowerCase();
  for (const [, value] of Object.entries(context)) {
    if (!value || value.length < 3) continue;
    if (lower.includes(value.toLowerCase().split('@')[0] ?? '')) {
      problems.push('Must not contain your name or email');
      break;
    }
  }

  let score = 0;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  return { score: Math.min(4, score), problems };
}

export default function ChangePasswordScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const session = useSession((s) => s.session);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const assessment = useMemo(
    () =>
      assessPassword(next, {
        email: session?.user.email,
        firstName: session?.user.firstName,
      }),
    [next, session],
  );

  const online = getNetworkState().isConnected;
  const mismatch = confirm.length > 0 && next !== confirm;
  const ready =
    current.length > 0 && assessment.problems.length === 0 && next === confirm && next.length > 0;

  const submit = useCallback(async () => {
    setError(null);
    setFieldErrors({});
    setBusy(true);

    try {
      await runtime.api.post('/auth/change-password', {
        currentPassword: current,
        newPassword: next,
      });

      // The server revokes every session on a password change, so the user must
      // sign in again. Saying so avoids them thinking something broke.
      Alert.alert(
        'Password changed',
        'For your security, you have been signed out everywhere. Sign in again with your new password.',
        [{ text: 'OK', onPress: () => void useSession.getState().logout() }],
      );
    } catch (err) {
      if (err instanceof AppError) {
        if (err.fields) setFieldErrors(err.fields);
        setError(err.message);
      } else {
        setError('Could not change your password. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }, [runtime, current, next]);

  const strengthTone =
    assessment.score >= 4 ? 'success' : assessment.score >= 3 ? 'warning' : 'danger';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingTop: insets.top + theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
          gap: theme.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Txt
            variant="caption"
            color="accent"
            onPress={() => router.back()}
            accessibilityRole="button"
          >
            ‹ Back
          </Txt>
        </View>

        <Txt variant="title">Change password</Txt>

        {!online ? (
          <Card>
            <View style={{ gap: theme.spacing.xs }}>
              <Txt variant="captionStrong" color="warning">
                Connection required
              </Txt>
              <Txt variant="caption" color="secondary">
                Passwords are verified on the server, so this cannot be done offline.
              </Txt>
            </View>
          </Card>
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

        <PasswordField
          label="Current password"
          value={current}
          onChangeText={setCurrent}
          textContentType="password"
          error={fieldErrors.currentPassword ?? null}
          editable={!busy && online}
        />

        <View style={{ gap: theme.spacing.sm }}>
          <PasswordField
            label="New password"
            value={next}
            onChangeText={setNext}
            textContentType="newPassword"
            error={fieldErrors.newPassword ?? null}
            editable={!busy && online}
            // Stays visible while the user reads it against the rules below.
            persistReveal
          />

          {next.length > 0 ? (
            <View style={{ gap: theme.spacing.xs }}>
              <ProgressBar value={assessment.score / 4} tone={strengthTone} height={4} />
              {assessment.problems.length > 0 ? (
                <View style={{ gap: 2 }}>
                  {assessment.problems.map((problem) => (
                    <Txt key={problem} variant="micro" color="muted">
                      • {problem}
                    </Txt>
                  ))}
                </View>
              ) : (
                <Txt variant="micro" color="success">
                  Meets your organisation's requirements
                </Txt>
              )}
            </View>
          ) : null}
        </View>

        <PasswordField
          label="Confirm new password"
          value={confirm}
          onChangeText={setConfirm}
          textContentType="newPassword"
          error={mismatch ? 'The passwords do not match.' : null}
          editable={!busy && online}
        />

        <Button
          label="Change password"
          onPress={() => void submit()}
          disabled={!ready || !online}
          busy={busy}
          fullWidth
          size="large"
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
