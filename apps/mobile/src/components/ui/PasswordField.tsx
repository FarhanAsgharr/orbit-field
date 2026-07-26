/**
 * Password field with a reveal toggle.
 *
 * More load-bearing on a phone than on a desktop: a soft keyboard mistypes
 * constantly, and an inspector wearing gloves in the rain has no chance of
 * entering a 16-character password blind on the first attempt.
 *
 * The toggle reverts to hidden when focus leaves, because a phone screen left
 * unlocked on a van dashboard is the realistic threat here, not a shoulder
 * surfer during the two seconds someone is reading their own password.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, type TextInputProps, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { useTheme } from '../../theme/ThemeProvider';
import { Field } from './index';

function EyeIcon({ open, color }: { open: boolean; color: string }): React.ReactElement {
  return open ? (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={1.7} />
    </Svg>
  ) : (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M10.6 6.2A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a18 18 0 0 1-2.6 3.3M6.2 7.8A17.6 17.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4-.85"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Path d="m3 3 18 18" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}

export interface PasswordFieldProps extends Omit<TextInputProps, 'secureTextEntry'> {
  label?: string;
  error?: string | null;
  hint?: string | null;
  /** Keep the value visible after focus leaves. Off by default. */
  persistReveal?: boolean;
}

export function PasswordField({
  label,
  error,
  hint,
  persistReveal = false,
  onBlur,
  ...rest
}: PasswordFieldProps): React.ReactElement {
  const theme = useTheme();
  const [revealed, setRevealed] = useState(false);

  const handleBlur = useCallback<NonNullable<TextInputProps['onBlur']>>(
    (event) => {
      if (!persistReveal) setRevealed(false);
      onBlur?.(event);
    },
    [persistReveal, onBlur],
  );

  return (
    <Field
      {...rest}
      label={label}
      error={error}
      hint={hint}
      secureTextEntry={!revealed}
      onBlur={handleBlur}
      // Autocorrect on a revealed password would "helpfully" rewrite it.
      autoCorrect={false}
      autoCapitalize="none"
      trailing={
        <Pressable
          onPress={() => setRevealed((v) => !v)}
          disabled={rest.editable === false}
          // The whole 44pt target, not just the 20pt glyph — this is tapped
          // with a thumb, often a gloved one.
          hitSlop={12}
          accessibilityRole="button"
          accessibilityState={{ selected: revealed, disabled: rest.editable === false }}
          accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
          style={{ padding: theme.spacing.xs, opacity: rest.editable === false ? 0.4 : 1 }}
        >
          <View>
            <EyeIcon
              open={revealed}
              color={revealed ? theme.colors.accent : theme.colors.textMuted}
            />
          </View>
        </Pressable>
      }
    />
  );
}
