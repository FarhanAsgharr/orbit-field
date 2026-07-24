/**
 * Choice inputs: pass/fail, yes/no, radio, dropdown, multi-select, checkbox.
 *
 * These carry most of an inspection's meaning and are tapped hundreds of times
 * a day, so they get the largest targets and the clearest state. Selected
 * options are indicated by border, fill, *and* a check glyph — never colour
 * alone, because red/green pass-fail is precisely the pairing that fails for
 * colour-blind users.
 */

import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import type { FieldOption, JsonValue, TemplateField } from '@orbit/types';
import { Badge, Button, Txt } from '../../../components/ui';
import { useTheme } from '../../../theme/ThemeProvider';

export interface ChoiceFieldProps {
  field: TemplateField;
  value: JsonValue;
  disabled?: boolean;
  onChange: (value: JsonValue) => void;
}

/** Tone an option should render with, derived from its scoring semantics. */
function optionTone(option: FieldOption): 'success' | 'danger' | 'neutral' | 'warning' {
  if (option.isFailure === true) return 'danger';
  if (option.isNotApplicable === true) return 'neutral';
  if (typeof option.score === 'number' && option.score > 0) return 'success';
  return 'neutral';
}

/**
 * Segmented selector for small option sets (pass/fail, yes/no).
 *
 * Laid out as full-width rows rather than a horizontal segment when labels are
 * long — a truncated "Pass with observations" is worse than a taller control.
 */
export function SegmentedChoice({
  field,
  value,
  disabled,
  onChange,
}: ChoiceFieldProps): React.ReactElement {
  const theme = useTheme();
  const options = field.options;

  // Horizontal only when every label is short enough to survive the split.
  const horizontal = options.length <= 3 && options.every((o) => o.label.length <= 12);

  return (
    <View
      style={{
        flexDirection: horizontal ? 'row' : 'column',
        gap: theme.spacing.sm,
      }}
    >
      {options.map((option) => {
        const selected = value === option.value;
        const tone = optionTone(option);
        const accent =
          tone === 'danger'
            ? theme.colors.danger
            : tone === 'success'
              ? theme.colors.success
              : theme.colors.accent;

        return (
          <Pressable
            key={option.value}
            disabled={disabled}
            onPress={() => onChange(selected ? null : option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={option.label}
            style={{
              flex: horizontal ? 1 : undefined,
              minHeight: theme.touchTarget.large,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 2,
              borderColor: selected ? accent : theme.colors.border,
              backgroundColor: selected ? `${accent}22` : theme.colors.surfaceRaised,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: horizontal ? 'center' : 'flex-start',
              gap: theme.spacing.sm,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            {/* Glyph, not just colour — the state must survive greyscale. */}
            <Txt
              variant="bodyStrong"
              style={{ color: selected ? accent : theme.colors.textMuted }}
            >
              {selected ? '●' : '○'}
            </Txt>
            <Txt
              variant="bodyStrong"
              style={{ color: selected ? accent : theme.colors.textPrimary }}
              numberOfLines={2}
            >
              {option.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Vertical radio list for longer option sets. */
export function RadioChoice(props: ChoiceFieldProps): React.ReactElement {
  return <SegmentedChoice {...props} />;
}

/** Multi-select: same affordance, square markers to signal multiplicity. */
export function MultiSelectChoice({
  field,
  value,
  disabled,
  onChange,
}: ChoiceFieldProps): React.ReactElement {
  const theme = useTheme();
  const selected = useMemo<string[]>(
    () => (Array.isArray(value) ? value.map(String) : []),
    [value],
  );

  const toggle = (optionValue: string): void => {
    const next = selected.includes(optionValue)
      ? selected.filter((v) => v !== optionValue)
      : [...selected, optionValue];
    onChange(next as JsonValue);
  };

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {field.options.map((option) => {
        const isSelected = selected.includes(option.value);
        const tone = optionTone(option);
        const accent =
          tone === 'danger' ? theme.colors.danger : tone === 'success' ? theme.colors.success : theme.colors.accent;

        return (
          <Pressable
            key={option.value}
            disabled={disabled}
            onPress={() => toggle(option.value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: isSelected, disabled }}
            accessibilityLabel={option.label}
            style={{
              minHeight: theme.touchTarget.comfortable,
              paddingHorizontal: theme.spacing.lg,
              paddingVertical: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 2,
              borderColor: isSelected ? accent : theme.colors.border,
              backgroundColor: isSelected ? `${accent}22` : theme.colors.surfaceRaised,
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              opacity: disabled ? 0.5 : 1,
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: theme.radius.sm,
                borderWidth: 2,
                borderColor: isSelected ? accent : theme.colors.borderStrong,
                backgroundColor: isSelected ? accent : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {isSelected ? <Txt style={{ color: '#FFFFFF', fontSize: 14 }}>✓</Txt> : null}
            </View>
            <Txt variant="body" style={{ flex: 1 }} numberOfLines={2}>
              {option.label}
            </Txt>
          </Pressable>
        );
      })}

      {selected.length > 0 ? (
        <Txt variant="micro" color="muted">
          {selected.length} selected
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * Dropdown.
 *
 * A modal sheet rather than a native picker: the native iOS picker is unusable
 * with gloves, and the Android spinner cannot show the option colour coding that
 * pass/fail semantics rely on.
 */
export function DropdownChoice({
  field,
  value,
  disabled,
  onChange,
}: ChoiceFieldProps): React.ReactElement {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  const selectedOption = field.options.find((o) => o.value === value) ?? null;

  return (
    <>
      <Pressable
        disabled={disabled}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${field.label}. ${selectedOption?.label ?? 'Nothing selected'}`}
        style={{
          minHeight: theme.touchTarget.comfortable,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surfaceRaised,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Txt
          variant="body"
          color={selectedOption ? 'primary' : 'muted'}
          style={{ flex: 1 }}
          numberOfLines={1}
        >
          {selectedOption?.label ?? 'Select an option'}
        </Txt>
        <Txt color="muted">▾</Txt>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={{ flex: 1, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          {/* Inner press must not close the sheet. */}
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              paddingTop: theme.spacing.lg,
              paddingBottom: theme.spacing.xxl,
              maxHeight: '75%',
            }}
          >
            <View style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
              <Txt variant="heading">{field.label}</Txt>
            </View>

            <ScrollView contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.sm }}>
              {field.options.map((option) => {
                const isSelected = option.value === value;
                const tone = optionTone(option);
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => {
                      onChange(isSelected ? null : option.value);
                      setOpen(false);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected }}
                    style={{
                      minHeight: theme.touchTarget.comfortable,
                      paddingHorizontal: theme.spacing.lg,
                      paddingVertical: theme.spacing.md,
                      borderRadius: theme.radius.md,
                      backgroundColor: isSelected ? theme.colors.accentMuted : theme.colors.surfaceRaised,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                    }}
                  >
                    <Txt variant="body" style={{ flex: 1 }}>
                      {option.label}
                    </Txt>
                    {tone !== 'neutral' ? (
                      <Badge
                        label={tone === 'danger' ? 'Fail' : 'Pass'}
                        tone={tone === 'danger' ? 'danger' : 'success'}
                      />
                    ) : null}
                    {isSelected ? <Txt color="accent">✓</Txt> : null}
                  </Pressable>
                );
              })}
            </ScrollView>

            <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg }}>
              <Button label="Cancel" variant="secondary" onPress={() => setOpen(false)} fullWidth />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

/** Standalone boolean checkbox (no options defined on the field). */
export function CheckboxField({
  field,
  value,
  disabled,
  onChange,
}: ChoiceFieldProps): React.ReactElement {
  const theme = useTheme();

  // A field with options behaves as a choice list; only a bare checkbox is boolean.
  if (field.options.length > 0) {
    return <MultiSelectChoice field={field} value={value} disabled={disabled} onChange={onChange} />;
  }

  const checked = value === true;

  return (
    <Pressable
      disabled={disabled}
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={field.label}
      style={{
        minHeight: theme.touchTarget.comfortable,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: theme.radius.sm,
          borderWidth: 2,
          borderColor: checked ? theme.colors.accent : theme.colors.borderStrong,
          backgroundColor: checked ? theme.colors.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? <Txt style={{ color: '#FFFFFF', fontSize: 16 }}>✓</Txt> : null}
      </View>
      <Txt variant="body" style={{ flex: 1 }}>
        {checked ? 'Yes' : 'No'}
      </Txt>
    </Pressable>
  );
}

/**
 * Rating.
 *
 * Renders discrete tappable steps rather than a slider — a slider cannot be
 * operated precisely with gloves, and "4 out of 5" must be unambiguous.
 */
export function RatingField({
  field,
  value,
  disabled,
  onChange,
}: ChoiceFieldProps): React.ReactElement {
  const theme = useTheme();
  const min = field.ui.ratingMin ?? 1;
  const max = field.ui.ratingMax ?? 5;
  const current = typeof value === 'number' ? value : null;
  const icon = field.ui.ratingIcon ?? 'STAR';

  const steps = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  return (
    <View style={{ gap: theme.spacing.md }}>
      <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
        {steps.map((step) => {
          const active = current !== null && step <= current;
          const isExact = current === step;

          return (
            <Pressable
              key={step}
              disabled={disabled}
              onPress={() => onChange(isExact ? null : step)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isExact, disabled }}
              accessibilityLabel={`${step} out of ${max}`}
              style={{
                width: theme.touchTarget.comfortable,
                height: theme.touchTarget.comfortable,
                borderRadius: icon === 'NUMBER' ? theme.radius.md : theme.radius.pill,
                borderWidth: 2,
                borderColor: isExact ? theme.colors.accent : theme.colors.border,
                backgroundColor: active ? theme.colors.accentMuted : theme.colors.surfaceRaised,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              <Txt
                variant="bodyStrong"
                style={{ color: active ? theme.colors.accent : theme.colors.textMuted }}
              >
                {icon === 'NUMBER' ? String(step) : icon === 'CIRCLE' ? (active ? '●' : '○') : active ? '★' : '☆'}
              </Txt>
            </Pressable>
          );
        })}
      </View>

      <Txt variant="micro" color="muted">
        {current !== null ? `${current} of ${max}` : `Not rated · scale ${min}–${max}`}
      </Txt>
    </View>
  );
}
