/**
 * Field dispatch.
 *
 * One switch, exhaustive over `FieldType`. The `never` check at the bottom means
 * adding a field type to the enum without handling it here is a compile error
 * rather than a blank space in an inspector's checklist.
 *
 * Follow-up questions are rendered inline, indented under their parent, rather
 * than in a separate panel — a "describe the defect" that appears somewhere else
 * on screen gets missed.
 */

import {
  type Attachment,
  FieldType,
  type GeoPoint,
  type JsonValue,
  type TemplateField,
} from '@orbit/types';
import React from 'react';
import { View } from 'react-native';

import { Txt } from '../../components/ui';
import { useTheme } from '../../theme/ThemeProvider';
import type { SignatureData } from '../signature/SignaturePad';
import {
  CheckboxField,
  DropdownChoice,
  MultiSelectChoice,
  RadioChoice,
  RatingField,
  SegmentedChoice,
} from './fields/ChoiceFields';
import {
  BarcodeField,
  DateTimeField,
  InstructionBlock,
  NumberField,
  TextField,
} from './fields/InputFields';
import { FileListField, LocationField, PhotoField, SignatureField } from './fields/MediaFields';
import type { FormFieldState } from './useInspectionForm';

export interface FieldActions {
  onChange: (field: TemplateField, value: JsonValue) => void;
  onCapturePhoto: (field: TemplateField) => void;
  onPickPhoto: (field: TemplateField) => void;
  onCaptureVideo: (field: TemplateField) => void;
  onCaptureAudio: (field: TemplateField) => void;
  onPickFile: (field: TemplateField) => void;
  onScanCode: (field: TemplateField) => void;
  onSign: (field: TemplateField, data: SignatureData, signerName: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onPreviewAttachment?: (attachment: Attachment) => void;
  onTouch: (fieldId: string) => void;
}

export function FieldRenderer({
  state,
  actions,
  depth = 0,
}: {
  state: FormFieldState;
  actions: FieldActions;
  depth?: number;
}): React.ReactElement | null {
  const theme = useTheme();
  const { field, visible, required, disabled, value, attachments, errors, warnings } = state;

  if (!visible) return null;

  const firstError = errors[0]?.message ?? null;

  const control = ((): React.ReactElement | null => {
    const change = (next: JsonValue): void => actions.onChange(field, next);

    switch (field.type) {
      case FieldType.INSTRUCTION:
        return <InstructionBlock field={field} />;

      case FieldType.TEXT:
      case FieldType.TEXT_AREA:
        return (
          <TextField
            field={field}
            value={value}
            disabled={disabled}
            error={firstError}
            onChange={change}
            onBlur={() => actions.onTouch(field.id)}
          />
        );

      case FieldType.NUMBER:
      case FieldType.CURRENCY:
        return (
          <NumberField
            field={field}
            value={value}
            disabled={disabled}
            error={firstError}
            onChange={change}
            onBlur={() => actions.onTouch(field.id)}
          />
        );

      case FieldType.DATE:
      case FieldType.TIME:
      case FieldType.DATETIME:
        return (
          <DateTimeField
            field={field}
            value={value}
            disabled={disabled}
            error={firstError}
            onChange={change}
          />
        );

      case FieldType.BARCODE:
        return (
          <BarcodeField
            field={field}
            value={value}
            disabled={disabled}
            error={firstError}
            onChange={change}
            onScan={() => actions.onScanCode(field)}
          />
        );

      case FieldType.PASS_FAIL:
      case FieldType.YES_NO:
        return (
          <SegmentedChoice field={field} value={value} disabled={disabled} onChange={change} />
        );

      case FieldType.RADIO:
        return <RadioChoice field={field} value={value} disabled={disabled} onChange={change} />;

      case FieldType.DROPDOWN:
        return <DropdownChoice field={field} value={value} disabled={disabled} onChange={change} />;

      case FieldType.MULTI_SELECT:
        return (
          <MultiSelectChoice field={field} value={value} disabled={disabled} onChange={change} />
        );

      case FieldType.CHECKBOX:
        return <CheckboxField field={field} value={value} disabled={disabled} onChange={change} />;

      case FieldType.RATING:
        return <RatingField field={field} value={value} disabled={disabled} onChange={change} />;

      case FieldType.GPS:
        return (
          <LocationField
            field={field}
            value={(value as unknown as GeoPoint | null) ?? null}
            disabled={disabled}
            onChange={(point) => change(point as unknown as JsonValue)}
          />
        );

      case FieldType.PHOTO:
        return (
          <PhotoField
            field={field}
            attachments={attachments}
            disabled={disabled}
            onCapture={() => actions.onCapturePhoto(field)}
            onPickFromGallery={() => actions.onPickPhoto(field)}
            onRemove={actions.onRemoveAttachment}
            onPreview={actions.onPreviewAttachment}
          />
        );

      case FieldType.VIDEO:
        return (
          <FileListField
            field={field}
            attachments={attachments}
            disabled={disabled}
            label="Record video"
            onCapture={() => actions.onCaptureVideo(field)}
            onRemove={actions.onRemoveAttachment}
          />
        );

      case FieldType.AUDIO:
        return (
          <FileListField
            field={field}
            attachments={attachments}
            disabled={disabled}
            label="Record voice note"
            onCapture={() => actions.onCaptureAudio(field)}
            onRemove={actions.onRemoveAttachment}
          />
        );

      case FieldType.FILE:
        return (
          <FileListField
            field={field}
            attachments={attachments}
            disabled={disabled}
            label="Attach file"
            onCapture={() => actions.onPickFile(field)}
            onRemove={actions.onRemoveAttachment}
          />
        );

      case FieldType.SIGNATURE:
        return (
          <SignatureField
            attachments={attachments}
            disabled={disabled}
            signerLabel={field.label}
            onSign={(data, name) => actions.onSign(field, data, name)}
            onRemove={actions.onRemoveAttachment}
          />
        );

      default: {
        // Exhaustiveness guard: a new FieldType must be handled above.
        const exhaustive: never = field.type;
        void exhaustive;
        return null;
      }
    }
  })();

  // Instruction blocks carry no label, required marker, or error slot.
  if (field.type === FieldType.INSTRUCTION) {
    return <View style={{ marginLeft: depth * theme.spacing.lg }}>{control}</View>;
  }

  return (
    <View
      style={{
        gap: theme.spacing.sm,
        marginLeft: depth * theme.spacing.lg,
        // A left rule makes the parent/child relationship legible without
        // relying on indentation alone, which is easy to miss while scrolling.
        borderLeftWidth: depth > 0 ? 2 : 0,
        borderLeftColor: theme.colors.border,
        paddingLeft: depth > 0 ? theme.spacing.md : 0,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.xs }}>
        <Txt variant="bodyStrong" style={{ flex: 1 }}>
          {field.label}
        </Txt>
        {required ? (
          <Txt style={{ color: theme.colors.danger, fontSize: 16 }} accessibilityLabel="required">
            *
          </Txt>
        ) : null}
      </View>

      {field.ui.helpText ? (
        <Txt variant="caption" color="muted">
          {field.ui.helpText}
        </Txt>
      ) : null}

      {control}

      {errors.map((issue, index) => (
        <Txt key={`e${index}`} variant="caption" color="danger">
          {issue.message}
        </Txt>
      ))}

      {warnings.map((issue, index) => (
        <Txt key={`w${index}`} variant="caption" color="warning">
          {issue.message}
        </Txt>
      ))}
    </View>
  );
}
