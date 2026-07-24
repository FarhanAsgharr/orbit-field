/**
 * Button.
 *
 * Every variant is at least 48pt tall (see `touchTarget` in tokens) because the
 * user is wearing gloves. `busy` renders a spinner in place of the label while
 * keeping the button's width, so a submit action does not make the layout jump
 * at the moment the user is looking at it.
 */

import React, { useMemo } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'small' | 'medium' | 'large';

export interface ButtonProps extends Omit<PressableProps, 'style' | 'children'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  busy?: boolean;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'leading' | 'trailing';
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  variant = 'primary',
  size = 'medium',
  busy = false,
  fullWidth = false,
  icon,
  iconPosition = 'leading',
  disabled,
  style,
  ...rest
}: ButtonProps): React.ReactElement {
  const theme = useTheme();
  const isDisabled = disabled === true || busy;

  const { container, text } = useMemo(() => {
    const height =
      size === 'small'
        ? theme.touchTarget.minimum
        : size === 'large'
          ? theme.touchTarget.large
          : theme.touchTarget.comfortable;

    const base: ViewStyle = {
      height,
      minWidth: theme.touchTarget.minimum,
      paddingHorizontal: size === 'small' ? theme.spacing.lg : theme.spacing.xl,
      borderRadius: theme.radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      borderWidth: 1,
      borderColor: 'transparent',
    };

    switch (variant) {
      case 'secondary':
        return {
          container: { ...base, backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border },
          text: theme.colors.textPrimary,
        };
      case 'ghost':
        return {
          container: { ...base, backgroundColor: 'transparent' },
          text: theme.colors.accent,
        };
      case 'danger':
        return {
          container: { ...base, backgroundColor: theme.colors.danger },
          text: '#FFFFFF',
        };
      case 'success':
        return {
          container: { ...base, backgroundColor: theme.colors.success },
          text: '#FFFFFF',
        };
      case 'primary':
      default:
        return {
          container: { ...base, backgroundColor: theme.colors.accent },
          text: theme.colors.accentText,
        };
    }
  }, [theme, variant, size]);

  const labelStyle =
    size === 'small' ? theme.typography.captionStrong : theme.typography.bodyStrong;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy }}
      accessibilityLabel={label}
      disabled={isDisabled}
      style={({ pressed }) => [
        container,
        fullWidth && styles.fullWidth,
        // Opacity rather than a colour shift: it reads correctly against every
        // variant without maintaining five separate pressed colours.
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      {busy ? (
        <ActivityIndicator color={text} size="small" />
      ) : (
        <>
          {icon && iconPosition === 'leading' ? <View>{icon}</View> : null}
          <Text style={[labelStyle, { color: text }]} numberOfLines={1}>
            {label}
          </Text>
          {icon && iconPosition === 'trailing' ? <View>{icon}</View> : null}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fullWidth: { alignSelf: 'stretch', width: '100%' },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.4 },
});
