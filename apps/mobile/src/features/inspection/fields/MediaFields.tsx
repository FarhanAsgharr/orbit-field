/**
 * Media inputs: photo, video, audio, file, signature, GPS.
 *
 * Every one of these shows its sync state per item. An inspector needs to know
 * which of the twelve photos they took is still sitting on the device — that is
 * the difference between "my evidence is filed" and "my evidence is on a phone
 * I am about to drop in a puddle".
 */

import { type Attachment, AttachmentState, type GeoPoint, type TemplateField } from '@orbit/types';
import { formatBytes, gradeAccuracy } from '@orbit/utils';
import React, { useCallback, useState } from 'react';
import { Alert, Image, Modal, Pressable, ScrollView, View } from 'react-native';

import { Badge, Button, Txt } from '../../../components/ui';
import { useTheme } from '../../../theme/ThemeProvider';
import { captureLocation } from '../../location/location.service';
import { type SignatureData, SignaturePad } from '../../signature/SignaturePad';

/** Per-attachment sync badge. */
function attachmentBadge(state: AttachmentState): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  icon: string;
} {
  switch (state) {
    case AttachmentState.UPLOADED:
    case AttachmentState.EVICTABLE:
      return { label: 'Uploaded', tone: 'success', icon: '✓' };
    case AttachmentState.UPLOADING:
    case AttachmentState.FINALIZING:
      return { label: 'Uploading', tone: 'warning', icon: '↑' };
    case AttachmentState.FAILED:
      return { label: 'Failed', tone: 'danger', icon: '!' };
    case AttachmentState.QUEUED:
    case AttachmentState.LOCAL_ONLY:
    default:
      return { label: 'On device', tone: 'neutral', icon: '○' };
  }
}

export interface MediaFieldProps {
  field: TemplateField;
  attachments: Attachment[];
  disabled?: boolean;
  onCapture: () => void;
  onPickFromGallery?: () => void;
  onRemove: (attachmentId: string) => void;
  onPreview?: (attachment: Attachment) => void;
}

export function PhotoField({
  field,
  attachments,
  disabled,
  onCapture,
  onPickFromGallery,
  onRemove,
  onPreview,
}: MediaFieldProps): React.ReactElement {
  const theme = useTheme();
  const max = field.validation.maxAttachments;
  const atLimit = max !== undefined && attachments.length >= max;
  const pairMode = field.ui.camera?.pairMode === 'BEFORE_AFTER';

  const confirmRemove = useCallback(
    (attachment: Attachment) => {
      const uploaded = attachment.state === AttachmentState.UPLOADED;
      Alert.alert(
        'Remove this photo?',
        uploaded
          ? 'It has already been uploaded. Removing it here also removes it from the report.'
          : 'This photo has not been uploaded yet. Once removed it cannot be recovered.',
        [
          { text: 'Keep', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => onRemove(attachment.id) },
        ],
      );
    },
    [onRemove],
  );

  const grouped = pairMode
    ? {
        BEFORE: attachments.filter((a) => a.pairTag === 'BEFORE'),
        AFTER: attachments.filter((a) => a.pairTag === 'AFTER'),
        UNTAGGED: attachments.filter((a) => !a.pairTag),
      }
    : null;

  return (
    <View style={{ gap: theme.spacing.md }}>
      {grouped ? (
        // Before/after work is compared side by side, so it is grouped rather
        // than shown in one undifferentiated strip.
        <View style={{ gap: theme.spacing.md }}>
          {(['BEFORE', 'AFTER'] as const).map((tag) => (
            <View key={tag} style={{ gap: theme.spacing.sm }}>
              <Txt variant="micro" color="muted">
                {tag}
              </Txt>
              <PhotoStrip
                attachments={grouped[tag]}
                onRemove={confirmRemove}
                onPreview={onPreview}
                disabled={disabled}
              />
            </View>
          ))}
        </View>
      ) : (
        <PhotoStrip
          attachments={attachments}
          onRemove={confirmRemove}
          onPreview={onPreview}
          disabled={disabled}
        />
      )}

      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <Button
          label={attachments.length === 0 ? 'Take photo' : 'Add photo'}
          variant={attachments.length === 0 ? 'primary' : 'secondary'}
          onPress={onCapture}
          disabled={disabled || atLimit}
          style={{ flex: 1 }}
        />
        {onPickFromGallery && field.ui.camera?.allowGallery !== false ? (
          <Button
            label="Gallery"
            variant="secondary"
            onPress={onPickFromGallery}
            disabled={disabled || atLimit}
            style={{ flex: 1 }}
          />
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Txt variant="micro" color="muted">
          {attachments.length}
          {max !== undefined ? ` of ${max}` : ''} attached
          {field.validation.minAttachments ? ` · ${field.validation.minAttachments} required` : ''}
        </Txt>
        {attachments.some((a) => a.state !== AttachmentState.UPLOADED) ? (
          <Txt variant="micro" color="warning">
            {attachments.filter((a) => a.state !== AttachmentState.UPLOADED).length} not uploaded
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

function PhotoStrip({
  attachments,
  onRemove,
  onPreview,
  disabled,
}: {
  attachments: Attachment[];
  onRemove: (attachment: Attachment) => void;
  onPreview?: (attachment: Attachment) => void;
  disabled?: boolean;
}): React.ReactElement | null {
  const theme = useTheme();
  if (attachments.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: theme.spacing.sm }}
    >
      {attachments.map((attachment) => {
        const badge = attachmentBadge(attachment.state);
        return (
          <Pressable
            key={attachment.id}
            onPress={() => onPreview?.(attachment)}
            onLongPress={() => !disabled && onRemove(attachment)}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Photo, ${badge.label}. Long press to remove.`}
            style={{
              width: 108,
              height: 108,
              borderRadius: theme.radius.md,
              overflow: 'hidden',
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surfaceSunken,
            }}
          >
            {attachment.localUri ? (
              <Image
                source={{ uri: attachment.localUri }}
                style={{ width: '100%', height: '100%' }}
              />
            ) : (
              // Evicted locally but safe on the server — say so rather than
              // showing a broken image.
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 4 }}>
                <Txt variant="micro" color="muted" style={{ textAlign: 'center' }}>
                  On server
                </Txt>
              </View>
            )}

            <View
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                backgroundColor: 'rgba(7,10,18,0.82)',
                paddingHorizontal: 4,
                paddingVertical: 3,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
              }}
            >
              <Txt
                variant="micro"
                style={{
                  color:
                    badge.tone === 'success'
                      ? '#13A874'
                      : badge.tone === 'danger'
                        ? '#E24A2E'
                        : '#C3CDDC',
                }}
              >
                {badge.icon}
              </Txt>
              <Txt variant="micro" style={{ color: '#C3CDDC', flex: 1 }} numberOfLines={1}>
                {formatBytes(attachment.sizeBytes)}
              </Txt>
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Video / audio / generic file — a list rather than a thumbnail strip. */
export function FileListField({
  field,
  attachments,
  disabled,
  onCapture,
  onRemove,
  label,
}: MediaFieldProps & { label: string }): React.ReactElement {
  const theme = useTheme();
  const max = field.validation.maxAttachments;
  const atLimit = max !== undefined && attachments.length >= max;

  return (
    <View style={{ gap: theme.spacing.md }}>
      {attachments.map((attachment) => {
        const badge = attachmentBadge(attachment.state);
        return (
          <View
            key={attachment.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              padding: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surfaceRaised,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="caption" numberOfLines={1}>
                {attachment.fileName}
              </Txt>
              <Txt variant="micro" color="muted">
                {formatBytes(attachment.sizeBytes)}
                {attachment.durationMs ? ` · ${Math.round(attachment.durationMs / 1000)}s` : ''}
              </Txt>
            </View>
            <Badge label={badge.label} tone={badge.tone} icon={badge.icon} />
            <Pressable
              onPress={() => onRemove(attachment.id)}
              disabled={disabled}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${attachment.fileName}`}
            >
              <Txt color="danger">✕</Txt>
            </Pressable>
          </View>
        );
      })}

      <Button
        label={label}
        variant={attachments.length === 0 ? 'primary' : 'secondary'}
        onPress={onCapture}
        disabled={disabled || atLimit}
        fullWidth
      />
    </View>
  );
}

/**
 * GPS field.
 *
 * Shows accuracy prominently and refuses a mocked fix. A coordinate presented
 * without its accuracy is a false claim of precision.
 */
export function LocationField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: TemplateField;
  value: GeoPoint | null;
  disabled?: boolean;
  onChange: (point: GeoPoint | null) => void;
}): React.ReactElement {
  const theme = useTheme();
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const capture = useCallback(async () => {
    setCapturing(true);
    setError(null);
    setProgress('Acquiring signal…');

    const result = await captureLocation({
      targetAccuracyMeters: field.validation.requiredGpsAccuracyMeters ?? 10,
      timeoutMs: 12_000,
      onProgress: (fix) => {
        setProgress(
          fix.accuracy !== null ? `Accuracy ±${Math.round(fix.accuracy)} m…` : 'Acquiring signal…',
        );
      },
    });

    setCapturing(false);
    setProgress(null);

    if (result.error || !result.point) {
      setError(result.error ?? 'Could not get a fix.');
      return;
    }
    onChange(result.point);
  }, [field.validation.requiredGpsAccuracyMeters, onChange]);

  const grade = value ? gradeAccuracy(value.accuracy) : 'UNKNOWN';
  const gradeTone =
    grade === 'EXCELLENT' || grade === 'GOOD'
      ? 'success'
      : grade === 'FAIR'
        ? 'warning'
        : grade === 'UNKNOWN'
          ? 'neutral'
          : 'danger';

  return (
    <View style={{ gap: theme.spacing.md }}>
      {value ? (
        <View
          style={{
            padding: theme.spacing.lg,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surfaceRaised,
            gap: theme.spacing.sm,
          }}
        >
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Txt variant="captionStrong" style={{ fontVariant: ['tabular-nums'] }}>
              {value.latitude.toFixed(6)}, {value.longitude.toFixed(6)}
            </Txt>
            <Badge
              label={value.accuracy !== null ? `±${Math.round(value.accuracy)} m` : 'Unknown'}
              tone={gradeTone}
              icon="◎"
            />
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {value.altitude !== null ? (
              <Txt variant="micro" color="muted">
                Alt {Math.round(value.altitude)} m
              </Txt>
            ) : null}
            {value.heading !== null ? (
              <Txt variant="micro" color="muted">
                Heading {Math.round(value.heading)}°
              </Txt>
            ) : null}
            {value.speed !== null && value.speed > 0.5 ? (
              <Txt variant="micro" color="muted">
                Speed {value.speed.toFixed(1)} m/s
              </Txt>
            ) : null}
          </View>

          <Txt variant="micro" color="muted">
            Captured {new Date(value.capturedAt).toLocaleString()}
          </Txt>

          {value.mocked ? (
            <Txt variant="caption" color="danger">
              This is a simulated location and cannot be used as evidence.
            </Txt>
          ) : null}
        </View>
      ) : null}

      {error ? (
        <Txt variant="caption" color="danger">
          {error}
        </Txt>
      ) : null}

      <Button
        label={
          capturing ? (progress ?? 'Locating…') : value ? 'Update location' : 'Capture location'
        }
        variant={value ? 'secondary' : 'primary'}
        onPress={() => void capture()}
        busy={capturing}
        disabled={disabled}
        fullWidth
      />
    </View>
  );
}

/** Signature field — opens the pad in a sheet. */
export function SignatureField({
  attachments,
  disabled,
  onSign,
  onRemove,
  signerLabel,
}: {
  attachments: Attachment[];
  disabled?: boolean;
  onSign: (data: SignatureData, signerName: string) => void;
  onRemove: (attachmentId: string) => void;
  signerLabel: string;
}): React.ReactElement {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SignatureData | null>(null);

  const existing = attachments[0] ?? null;

  return (
    <View style={{ gap: theme.spacing.md }}>
      {existing ? (
        <View
          style={{
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: '#FFFFFF',
            height: 140,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {existing.localUri ? (
            <Image
              source={{ uri: existing.localUri }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="contain"
            />
          ) : (
            <Txt variant="caption" style={{ color: '#4A5A78' }}>
              Signature captured
            </Txt>
          )}
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <Button
          label={existing ? 'Re-sign' : `Capture ${signerLabel.toLowerCase()} signature`}
          variant={existing ? 'secondary' : 'primary'}
          onPress={() => setOpen(true)}
          disabled={disabled}
          style={{ flex: 1 }}
        />
        {existing ? (
          <Button
            label="Remove"
            variant="ghost"
            onPress={() => onRemove(existing.id)}
            disabled={disabled}
          />
        ) : null}
      </View>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.background,
            padding: theme.spacing.lg,
            paddingTop: theme.spacing.huge,
            gap: theme.spacing.lg,
          }}
        >
          <Txt variant="title">{signerLabel} signature</Txt>
          <Txt variant="caption" color="secondary">
            By signing, you confirm the information recorded in this inspection is accurate.
          </Txt>

          <SignaturePad onChange={setData} height={260} />

          <View style={{ flexDirection: 'row', gap: theme.spacing.md, marginTop: 'auto' }}>
            <Button
              label="Cancel"
              variant="secondary"
              onPress={() => {
                setData(null);
                setOpen(false);
              }}
              style={{ flex: 1 }}
            />
            <Button
              label="Save signature"
              onPress={() => {
                if (!data) return;
                onSign(data, signerLabel);
                setData(null);
                setOpen(false);
              }}
              disabled={!data}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
