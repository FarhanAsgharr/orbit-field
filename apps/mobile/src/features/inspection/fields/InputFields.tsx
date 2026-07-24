/**
 * Scalar inputs: text, number, currency, date, time, datetime, barcode.
 *
 * Numeric entry deliberately keeps its own draft string. Storing the parsed
 * number on every keystroke destroys in-progress input — typing "12.5" passes
 * through "12." which `Number()` turns into 12, and the decimal point vanishes
 * under the user's finger.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Platform, Pressable, View } from 'react-native';
import { FieldType, type JsonValue, type TemplateField } from '@orbit/types';
import { Button, Field, Txt } from '../../../components/ui';
import { useTheme } from '../../../theme/ThemeProvider';

export interface InputFieldProps {
  field: TemplateField;
  value: JsonValue;
  disabled?: boolean;
  error?: string | null;
  onChange: (value: JsonValue) => void;
  onBlur?: () => void;
}

export function TextField({
  field,
  value,
  disabled,
  error,
  onChange,
  onBlur,
}: InputFieldProps): React.ReactElement {
  const multiline = field.type === FieldType.TEXT_AREA;

  return (
    <Field
      value={typeof value === 'string' ? value : ''}
      onChangeText={(text) => onChange(text)}
      onBlur={onBlur}
      editable={!disabled}
      error={error}
      placeholder={field.ui.placeholder ?? (multiline ? 'Add your observations…' : '')}
      multiline={multiline}
      numberOfLines={multiline ? 5 : 1}
      maxLength={field.validation.maxLength}
      style={multiline ? { minHeight: 120, textAlignVertical: 'top' } : undefined}
      autoCapitalize={multiline ? 'sentences' : 'none'}
      accessibilityLabel={field.label}
    />
  );
}

export function NumberField({
  field,
  value,
  disabled,
  error,
  onChange,
  onBlur,
}: InputFieldProps): React.ReactElement {
  const theme = useTheme();
  const isCurrency = field.type === FieldType.CURRENCY;

  // Local draft so partial input ("12.", "-", "0.0") survives until blur.
  const [draft, setDraft] = useState<string>(() =>
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '',
  );

  useEffect(() => {
    // Re-sync when the value changes from outside (logic SET_VALUE, resume).
    const external = typeof value === 'number' ? String(value) : '';
    if (external !== '' && Number(draft) !== value) setDraft(external);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === '-' || trimmed === '.') {
      onChange(null);
    } else {
      const parsed = Number(trimmed);
      // An unparseable draft is kept on screen rather than silently zeroed —
      // the validation engine will flag it, which is more honest than
      // pretending the inspector typed 0.
      onChange(Number.isFinite(parsed) ? parsed : trimmed);
    }
    onBlur?.();
  }, [draft, onChange, onBlur]);

  const unit = isCurrency ? (field.ui.currency ?? 'USD') : null;

  return (
    <Field
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      editable={!disabled}
      error={error}
      placeholder={field.ui.placeholder ?? '0'}
      // `decimal-pad` omits the minus sign on iOS; `numbers-and-punctuation`
      // keeps it available for readings that can legitimately go negative.
      keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'numeric'}
      accessibilityLabel={field.label}
      trailing={
        unit ? (
          <Txt variant="caption" color="muted">
            {unit}
          </Txt>
        ) : field.validation.min !== undefined || field.validation.max !== undefined ? (
          <Txt variant="micro" color="muted">
            {field.validation.min ?? '–'}…{field.validation.max ?? '–'}
          </Txt>
        ) : null
      }
      style={{ fontVariant: ['tabular-nums'] }}
    />
  );
}

/**
 * Date / time / datetime.
 *
 * A tap-through wheel picker is unusable in gloves, so this uses a compact
 * numeric entry sheet with "Now" and "Today" shortcuts — which is what an
 * inspector actually wants 90% of the time.
 */
export function DateTimeField({
  field,
  value,
  disabled,
  error,
  onChange,
}: InputFieldProps): React.ReactElement {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const mode: 'date' | 'time' | 'datetime' =
    field.type === FieldType.TIME ? 'time' : field.type === FieldType.DATETIME ? 'datetime' : 'date';

  const display = (): string => {
    if (typeof value !== 'string' || value === '') return 'Not set';
    if (mode === 'time') return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return mode === 'datetime' ? parsed.toLocaleString() : parsed.toLocaleDateString();
  };

  const setNow = (): void => {
    const now = new Date();
    if (mode === 'time') {
      onChange(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    } else if (mode === 'datetime') {
      onChange(now.toISOString());
    } else {
      onChange(now.toISOString().slice(0, 10));
    }
    setOpen(false);
  };

  return (
    <>
      <Pressable
        disabled={disabled}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${field.label}. ${display()}`}
        style={{
          minHeight: theme.touchTarget.comfortable,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: error ? theme.colors.danger : theme.colors.border,
          backgroundColor: theme.colors.surfaceRaised,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Txt variant="body" color={typeof value === 'string' && value ? 'primary' : 'muted'}>
          {display()}
        </Txt>
        <Txt color="muted">{mode === 'time' ? '◷' : '▤'}</Txt>
      </Pressable>

      {error ? (
        <Txt variant="caption" color="danger">
          {error}
        </Txt>
      ) : null}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              padding: theme.spacing.lg,
              gap: theme.spacing.md,
            }}
          >
            <Txt variant="heading">{field.label}</Txt>

            <ManualDateEntry mode={mode} value={typeof value === 'string' ? value : ''} onCommit={(next) => {
              onChange(next);
              setOpen(false);
            }} />

            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
              <Button
                label={mode === 'time' ? 'Now' : mode === 'datetime' ? 'Now' : 'Today'}
                variant="secondary"
                onPress={setNow}
                style={{ flex: 1 }}
              />
              <Button
                label="Clear"
                variant="ghost"
                onPress={() => {
                  onChange(null);
                  setOpen(false);
                }}
                style={{ flex: 1 }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** Typed entry, because a keyboard beats a wheel picker in gloves. */
function ManualDateEntry({
  mode,
  value,
  onCommit,
}: {
  mode: 'date' | 'time' | 'datetime';
  value: string;
  onCommit: (value: string) => void;
}): React.ReactElement {
  const theme = useTheme();
  const [draft, setDraft] = useState(() => {
    if (!value) return '';
    if (mode === 'time') return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return mode === 'date' ? parsed.toISOString().slice(0, 10) : parsed.toISOString().slice(0, 16).replace('T', ' ');
  });

  const placeholder = mode === 'time' ? 'HH:MM' : mode === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:MM';

  const commit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;

    if (mode === 'time') {
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) onCommit(trimmed);
      return;
    }
    const normalised = trimmed.replace(' ', 'T');
    const parsed = new Date(normalised);
    if (Number.isNaN(parsed.getTime())) return;
    onCommit(mode === 'date' ? parsed.toISOString().slice(0, 10) : parsed.toISOString());
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Field
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        autoCorrect={false}
        hint={`Format: ${placeholder}`}
      />
      <Button label="Set" onPress={commit} fullWidth />
    </View>
  );
}

/**
 * Barcode / QR field.
 *
 * Accepts a scan or a typed code. Manual entry is not a fallback afterthought:
 * asset labels in the field are frequently scratched, faded, or behind a panel
 * the scanner cannot reach, and refusing manual entry would block the
 * inspection entirely.
 */
export function BarcodeField({
  field,
  value,
  disabled,
  error,
  onChange,
  onScan,
}: InputFieldProps & { onScan?: () => void }): React.ReactElement {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Field
        value={typeof value === 'string' ? value : ''}
        onChangeText={(text) => onChange(text)}
        editable={!disabled}
        error={error}
        placeholder={field.ui.placeholder ?? 'Scan or type the code'}
        autoCapitalize="characters"
        autoCorrect={false}
        accessibilityLabel={field.label}
        trailing={
          onScan ? (
            <Pressable
              onPress={onScan}
              disabled={disabled}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Scan barcode"
            >
              <Txt variant="bodyStrong" color="accent">
                ⛶
              </Txt>
            </Pressable>
          ) : null
        }
      />
      {onScan ? (
        <Button label="Scan code" variant="secondary" onPress={onScan} disabled={disabled} fullWidth />
      ) : null}
    </View>
  );
}

/** Read-only instruction banner. Produces no answer. */
export function InstructionBlock({ field }: { field: TemplateField }): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.colors.infoMuted,
        borderRadius: theme.radius.md,
        padding: theme.spacing.lg,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.info,
        gap: theme.spacing.xs,
      }}
    >
      <Txt variant="captionStrong" color="primary">
        {field.label}
      </Txt>
      {field.ui.helpText ? (
        <Txt variant="caption" color="secondary">
          {field.ui.helpText}
        </Txt>
      ) : null}
    </View>
  );
}
