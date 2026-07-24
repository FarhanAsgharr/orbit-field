/**
 * Shared UI primitives.
 *
 * Kept in one file because they are small, mutually referential, and always
 * imported together. Splitting them across nine files would add import noise
 * without improving anything.
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import {
  InspectionOutcome,
  InspectionStatus,
  type Priority,
} from '@orbit/types';
import { useTheme } from '../../theme/ThemeProvider';

export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({
  children,
  style,
  onPress,
  padded = true,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  padded?: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const base: ViewStyle = {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: padded ? theme.spacing.lg : 0,
  };

  if (!onPress) return <View style={[base, style]}>{children}</View>;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [base, pressed && { opacity: 0.75 }, style]}
    >
      {children}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({
  label,
  tone = 'neutral',
  icon,
}: {
  label: string;
  tone?: BadgeTone;
  icon?: string;
}): React.ReactElement {
  const theme = useTheme();

  const tones: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: theme.colors.surfaceSunken, fg: theme.colors.textSecondary },
    accent: { bg: theme.colors.accentMuted, fg: theme.colors.accent },
    success: { bg: theme.colors.successMuted, fg: theme.colors.success },
    warning: { bg: theme.colors.warningMuted, fg: theme.colors.warning },
    danger: { bg: theme.colors.dangerMuted, fg: theme.colors.danger },
    info: { bg: theme.colors.infoMuted, fg: theme.colors.info },
  };

  const { bg, fg } = tones[tone];

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        backgroundColor: bg,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
        borderRadius: theme.radius.sm,
        alignSelf: 'flex-start',
      }}
    >
      {/* The glyph carries the same meaning as the colour, so the badge stays
          legible for colour-blind users and in greyscale print-outs. */}
      {icon ? <Text style={{ fontSize: 11, color: fg }}>{icon}</Text> : null}
      <Text style={[theme.typography.micro, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Status → badge presentation. One mapping, used by every screen. */
export function statusPresentation(status: InspectionStatus): {
  label: string;
  tone: BadgeTone;
  icon: string;
} {
  switch (status) {
    case InspectionStatus.DRAFT:
      return { label: 'Draft', tone: 'neutral', icon: '○' };
    case InspectionStatus.SCHEDULED:
      return { label: 'Scheduled', tone: 'info', icon: '◔' };
    case InspectionStatus.IN_PROGRESS:
      return { label: 'In progress', tone: 'accent', icon: '◑' };
    case InspectionStatus.SUBMITTED:
      return { label: 'Submitted', tone: 'info', icon: '↑' };
    case InspectionStatus.UNDER_REVIEW:
      return { label: 'Under review', tone: 'warning', icon: '◐' };
    case InspectionStatus.APPROVED:
      return { label: 'Approved', tone: 'success', icon: '✓' };
    case InspectionStatus.REJECTED:
      return { label: 'Rejected', tone: 'danger', icon: '↺' };
    case InspectionStatus.CANCELLED:
      return { label: 'Cancelled', tone: 'neutral', icon: '✕' };
    case InspectionStatus.ARCHIVED:
      return { label: 'Archived', tone: 'neutral', icon: '▣' };
    default:
      return { label: String(status), tone: 'neutral', icon: '•' };
  }
}

export function outcomePresentation(outcome: InspectionOutcome): {
  label: string;
  tone: BadgeTone;
  icon: string;
} {
  switch (outcome) {
    case InspectionOutcome.PASS:
      return { label: 'Pass', tone: 'success', icon: '✓' };
    case InspectionOutcome.PASS_WITH_OBSERVATIONS:
      return { label: 'Pass with observations', tone: 'warning', icon: '!' };
    case InspectionOutcome.FAIL:
      return { label: 'Fail', tone: 'danger', icon: '✕' };
    case InspectionOutcome.NOT_APPLICABLE:
      return { label: 'N/A', tone: 'neutral', icon: '–' };
    case InspectionOutcome.PENDING:
    default:
      return { label: 'Pending', tone: 'neutral', icon: '○' };
  }
}

export function priorityPresentation(priority: Priority): { label: string; tone: BadgeTone; icon: string } {
  switch (priority) {
    case 'CRITICAL':
      return { label: 'Critical', tone: 'danger', icon: '▲' };
    case 'HIGH':
      return { label: 'High', tone: 'warning', icon: '▲' };
    case 'NORMAL':
      return { label: 'Normal', tone: 'neutral', icon: '■' };
    case 'LOW':
    default:
      return { label: 'Low', tone: 'neutral', icon: '▼' };
  }
}

// ---------------------------------------------------------------------------
// Typography helpers
// ---------------------------------------------------------------------------

type TextVariant = keyof ReturnType<typeof useTheme>['typography'];

export function Txt({
  children,
  variant = 'body',
  color,
  style,
  numberOfLines,
  ...rest
}: {
  children: React.ReactNode;
  variant?: TextVariant;
  color?: 'primary' | 'secondary' | 'muted' | 'accent' | 'danger' | 'success' | 'warning';
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
} & Pick<
  TextProps,
  'accessibilityLabel' | 'accessibilityRole' | 'accessibilityHint' | 'selectable' | 'testID' | 'onPress'
>): React.ReactElement {
  const theme = useTheme();
  const colorMap = {
    primary: theme.colors.textPrimary,
    secondary: theme.colors.textSecondary,
    muted: theme.colors.textMuted,
    accent: theme.colors.accent,
    danger: theme.colors.danger,
    success: theme.colors.success,
    warning: theme.colors.warning,
  };

  return (
    <Text
      numberOfLines={numberOfLines}
      style={[theme.typography[variant], { color: colorMap[color ?? 'primary'] }, style]}
      {...rest}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export interface FieldProps extends TextInputProps {
  label?: string;
  error?: string | null;
  hint?: string | null;
  required?: boolean;
  trailing?: React.ReactNode;
}

export function Field({
  label,
  error,
  hint,
  required,
  trailing,
  style,
  ...rest
}: FieldProps): React.ReactElement {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xs }}>
      {label ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
          <Txt variant="captionStrong" color="secondary">
            {label}
          </Txt>
          {required ? (
            <Text style={{ color: theme.colors.danger, fontSize: 14 }} accessibilityLabel="required">
              *
            </Text>
          ) : null}
        </View>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          // The error border is the only colour cue; the message below carries
          // the actual information, so this is decoration rather than meaning.
          borderColor: error ? theme.colors.danger : theme.colors.border,
          minHeight: theme.touchTarget.comfortable,
          paddingHorizontal: theme.spacing.lg,
          gap: theme.spacing.sm,
        }}
      >
        <TextInput
          style={[
            { flex: 1, color: theme.colors.textPrimary, paddingVertical: theme.spacing.md },
            theme.typography.body,
            style,
          ]}
          placeholderTextColor={theme.colors.textMuted}
          accessibilityLabel={label}
          {...rest}
        />
        {trailing}
      </View>

      {error ? (
        <Txt variant="caption" color="danger">
          {error}
        </Txt>
      ) : hint ? (
        <Txt variant="caption" color="muted">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function EmptyState({
  icon = '◎',
  title,
  message,
  action,
}: {
  icon?: string;
  title: string;
  message?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: theme.spacing.huge,
        paddingHorizontal: theme.spacing.xxl,
        gap: theme.spacing.md,
      }}
    >
      <Text style={{ fontSize: 44, color: theme.colors.textMuted }}>{icon}</Text>
      <Txt variant="heading" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      {message ? (
        <Txt variant="caption" color="muted" style={{ textAlign: 'center' }}>
          {message}
        </Txt>
      ) : null}
      {action ? <View style={{ marginTop: theme.spacing.sm }}>{action}</View> : null}
    </View>
  );
}

/**
 * Skeleton placeholder.
 *
 * Deliberately static rather than shimmering: a shimmer animation on a list of
 * 40 rows is a measurable battery cost, and battery is a scarce resource on a
 * ten-hour shift with no charger.
 */
export function Skeleton({
  height = 16,
  width = '100%',
  radius: r,
}: {
  height?: number;
  width?: number | `${number}%`;
  radius?: number;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        height,
        width,
        borderRadius: r ?? theme.radius.sm,
        backgroundColor: theme.colors.surfaceSunken,
      }}
    />
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }): React.ReactElement {
  const theme = useTheme();
  return (
    <View style={{ padding: theme.spacing.huge, alignItems: 'center', gap: theme.spacing.md }}>
      <ActivityIndicator color={theme.colors.accent} />
      <Txt variant="caption" color="muted">
        {label}
      </Txt>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function ProgressBar({
  value,
  tone = 'accent',
  height = 6,
  label,
}: {
  /** 0..1 */
  value: number;
  tone?: BadgeTone;
  height?: number;
  label?: string;
}): React.ReactElement {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  const colorMap: Record<BadgeTone, string> = {
    neutral: theme.colors.textMuted,
    accent: theme.colors.accent,
    success: theme.colors.success,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    info: theme.colors.info,
  };

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      accessibilityLabel={label}
      style={{
        height,
        borderRadius: height / 2,
        backgroundColor: theme.colors.surfaceSunken,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height: '100%',
          backgroundColor: colorMap[tone],
          borderRadius: height / 2,
        }}
      />
    </View>
  );
}

export function Divider(): React.ReactElement {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />;
}

/** Label/value row used throughout detail screens. */
export function DetailRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'muted';
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
      }}
    >
      <Txt variant="caption" color="muted" style={{ flexShrink: 0 }}>
        {label}
      </Txt>
      {typeof value === 'string' ? (
        <Txt
          variant="caption"
          color={tone === 'muted' ? 'muted' : 'primary'}
          style={{ flex: 1, textAlign: 'right' }}
        >
          {value}
        </Txt>
      ) : (
        <View style={{ flex: 1, alignItems: 'flex-end' }}>{value}</View>
      )}
    </View>
  );
}
