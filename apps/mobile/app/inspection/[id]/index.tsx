/**
 * Inspection form.
 *
 * The screen the whole product exists for. Assembles the template renderer, the
 * live engines, media capture, and submission.
 *
 * Two behaviours worth calling out:
 *  - There is no "save" button for answers. Every response is written to SQLite
 *    the instant it changes. The header's saved-state chip reports that, so the
 *    inspector can see it rather than having to trust it.
 *  - Submission validates, and on failure jumps to the first unanswered required
 *    question rather than showing a summary the user then has to hunt through.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import {
  AttachmentKind,
  EDITABLE_INSPECTION_STATUSES,
  InspectionStatus,
  SignatureRole,
  type GeoPoint,
  type JsonValue,
  type TemplateField,
} from '@orbit/types';
import { formatRelativeTime } from '@orbit/utils';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  LoadingState,
  ProgressBar,
  Txt,
  outcomePresentation,
  statusPresentation,
} from '../../../src/components/ui';
import { useTheme } from '../../../src/theme/ThemeProvider';
import { useRuntime } from '../../../src/stores/session.store';
import { useInspectionForm } from '../../../src/features/inspection/useInspectionForm';
import { FieldRenderer, type FieldActions } from '../../../src/features/inspection/FieldRenderer';
import {
  persistSignatureSvg,
  processPhoto,
  processVideo,
} from '../../../src/features/camera/camera.service';
import { signatureToSvg, type SignatureData } from '../../../src/features/signature/SignaturePad';
import { ScannerModal, type ScanResult } from '../../../src/features/capture/scanner';
import { AudioRecorderModal, type AudioResult } from '../../../src/features/capture/audio';
import { pickAnyFile, pickDocuments } from '../../../src/features/capture/files';
import { useLiveQuery, invalidateQueries } from '../../../src/hooks/useLiveQuery';

export default function InspectionFormScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const { id } = useLocalSearchParams<{ id: string }>();
  const inspectionId = id ?? '';

  const scrollRef = useRef<ScrollView>(null);
  const sectionOffsets = useRef<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Which field a modal capture is currently targeting. Held rather than passed,
  // because the modal outlives the press handler that opened it.
  const [scannerField, setScannerField] = useState<TemplateField | null>(null);
  const [audioField, setAudioField] = useState<TemplateField | null>(null);

  const inspection = useLiveQuery(
    () => runtime.repositories.inspections.findById(inspectionId),
    [inspectionId],
  );

  const form = useInspectionForm({ runtime, inspectionId });

  const readOnly = useMemo(
    () => !inspection || !EDITABLE_INSPECTION_STATUSES.includes(inspection.status),
    [inspection],
  );

  // --- media ---------------------------------------------------------------

  /**
   * Attach a captured or picked image.
   *
   * The response row is created first so the attachment has a parent to hang
   * from; both are written before the file is considered attached, so a crash
   * cannot leave a photo referencing nothing.
   */
  const attachImage = useCallback(
    async (field: TemplateField, uri: string) => {
      try {
        const processed = await processPhoto(uri, {
          watermark: field.ui.camera?.watermark ?? true,
        });

        // Dedupe: the same image attached twice should not upload twice.
        const existing = runtime.repositories.attachments.findByChecksum(processed.checksum);
        if (existing && existing.responseId) {
          Alert.alert('Already attached', 'That photo is already attached to this inspection.');
          return;
        }

        const response = runtime.repositories.responses.upsert({
          inspectionId,
          sectionId: field.sectionId,
          fieldId: field.id,
          value: null,
        });

        runtime.repositories.attachments.register({
          inspectionId,
          responseId: response.id,
          kind: AttachmentKind.PHOTO,
          fileName: processed.fileName,
          mimeType: processed.mimeType,
          sizeBytes: processed.sizeBytes,
          checksum: processed.checksum,
          localUri: processed.localUri,
          thumbnailUri: processed.thumbnailUri,
          width: processed.width,
          height: processed.height,
          location: processed.location,
          capturedAt: processed.capturedAt,
        });

        form.refresh();
        invalidateQueries();
      } catch (err) {
        Alert.alert(
          'Could not save the photo',
          err instanceof Error ? err.message : 'The image could not be processed.',
        );
      }
    },
    [runtime, inspectionId, form],
  );

  const capturePhoto = useCallback(
    async (field: TemplateField) => {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Camera access needed',
          'Orbit Field needs the camera to record inspection evidence. Enable it in your device settings.',
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1, // Compression happens in our pipeline, not the picker's.
        exif: true,
      });

      if (result.canceled || !result.assets[0]) return;
      await attachImage(field, result.assets[0].uri);
    },
    [attachImage],
  );

  const pickPhoto = useCallback(
    async (field: TemplateField) => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) return;

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
        allowsMultipleSelection: true,
        selectionLimit: field.validation.maxAttachments ?? 10,
      });

      if (result.canceled) return;
      for (const asset of result.assets) {
        await attachImage(field, asset.uri);
      }
    },
    [attachImage],
  );

  const captureVideo = useCallback(
    async (field: TemplateField) => {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return;

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        videoMaxDuration: 120,
      });
      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];
      const processed = await processVideo(asset.uri, asset.duration ?? null);

      const response = runtime.repositories.responses.upsert({
        inspectionId,
        sectionId: field.sectionId,
        fieldId: field.id,
        value: null,
      });

      runtime.repositories.attachments.register({
        inspectionId,
        responseId: response.id,
        kind: AttachmentKind.VIDEO,
        fileName: processed.fileName,
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
        checksum: processed.checksum,
        localUri: processed.localUri,
        durationMs: processed.durationMs,
        location: processed.location,
        capturedAt: processed.capturedAt,
      });

      form.refresh();
      invalidateQueries();
    },
    [runtime, inspectionId, form],
  );

  const sign = useCallback(
    async (field: TemplateField, data: SignatureData) => {
      const svg = signatureToSvg(data);
      const file = await persistSignatureSvg(svg);

      const response = runtime.repositories.responses.upsert({
        inspectionId,
        sectionId: field.sectionId,
        fieldId: field.id,
        value: null,
      });

      runtime.repositories.attachments.register({
        inspectionId,
        responseId: response.id,
        kind: AttachmentKind.SIGNATURE,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        checksum: file.checksum,
        localUri: file.localUri,
        capturedAt: data.capturedAt,
      });

      form.refresh();
      invalidateQueries();
    },
    [runtime, inspectionId, form],
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      runtime.repositories.attachments.remove(attachmentId);
      form.refresh();
      invalidateQueries();
    },
    [runtime, form],
  );

  /** Register a captured binary against a field, creating its response row first. */
  const attachBinary = useCallback(
    (
      field: TemplateField,
      file: {
        localUri: string; fileName: string; mimeType: string;
        sizeBytes: number; checksum: string; capturedAt: string;
        durationMs?: number | null; location?: GeoPoint | null;
      },
      kind: AttachmentKind,
    ) => {
      const existing = runtime.repositories.attachments.findByChecksum(file.checksum);
      if (existing && existing.responseId) {
        Alert.alert('Already attached', 'That file is already attached to this inspection.');
        return;
      }

      const response = runtime.repositories.responses.upsert({
        inspectionId,
        sectionId: field.sectionId,
        fieldId: field.id,
        value: null,
      });

      runtime.repositories.attachments.register({
        inspectionId,
        responseId: response.id,
        kind,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        checksum: file.checksum,
        localUri: file.localUri,
        durationMs: file.durationMs ?? null,
        location: (file.location ?? null) as never,
        capturedAt: file.capturedAt,
      });

      form.refresh();
      invalidateQueries();
    },
    [runtime, inspectionId, form],
  );

  const pickFiles = useCallback(
    async (field: TemplateField, anyType: boolean) => {
      const outcome = anyType
        ? await pickAnyFile({ multiple: true, maxFiles: field.validation.maxAttachments ?? 5 })
        : await pickDocuments({ multiple: true, maxFiles: field.validation.maxAttachments ?? 5 });

      if (!outcome.ok) {
        // A cancelled pick is the common case and is not an error worth an alert.
        if (outcome.failure.message) {
          Alert.alert('Could not attach that file', outcome.failure.message);
        }
        return;
      }

      for (const file of outcome.files) {
        attachBinary(field, file, AttachmentKind.DOCUMENT);
      }
    },
    [attachBinary],
  );

  const handleScan = useCallback(
    (result: ScanResult) => {
      if (!scannerField) return;
      form.setValue(scannerField, result.value);
      setScannerField(null);
    },
    [scannerField, form],
  );

  const handleAudio = useCallback(
    (result: AudioResult) => {
      if (!audioField) return;
      attachBinary(audioField, result, AttachmentKind.AUDIO);
      setAudioField(null);
    },
    [audioField, attachBinary],
  );

  const actions = useMemo<FieldActions>(
    () => ({
      onChange: (field, value: JsonValue) => form.setValue(field, value),
      onCapturePhoto: (field) => void capturePhoto(field),
      onPickPhoto: (field) => void pickPhoto(field),
      onCaptureVideo: (field) => void captureVideo(field),
      onCaptureAudio: (field) => setAudioField(field),
      onPickFile: (field) => void pickFiles(field, false),
      onScanCode: (field) => setScannerField(field),
      onSign: (field, data) => void sign(field, data),
      onRemoveAttachment: removeAttachment,
      onTouch: form.markTouched,
    }),
    [form, capturePhoto, pickPhoto, captureVideo, sign, removeAttachment, pickFiles],
  );

  // --- submission ----------------------------------------------------------

  const submit = useCallback(() => {
    form.revealAllErrors();

    if (!form.canSubmit) {
      const firstError = form.errors[0];
      Alert.alert(
        'Not ready to submit',
        form.blockers.length > 0
          ? form.blockers[0]!
          : `${form.errors.length} question${form.errors.length === 1 ? '' : 's'} still need attention.${firstError ? `\n\nFirst: ${firstError.fieldLabel} — ${firstError.message}` : ''}`,
        [{ text: 'Review' }],
      );

      // Scroll to the section containing the first problem.
      if (firstError?.sectionId) {
        const offset = sectionOffsets.current[firstError.sectionId];
        if (offset !== undefined) {
          scrollRef.current?.scrollTo({ y: Math.max(0, offset - 80), animated: true });
        }
      }
      return;
    }

    Alert.alert(
      'Submit this inspection?',
      'Once submitted it goes for review and can no longer be edited. It will upload automatically when you have a connection.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Submit',
          onPress: () => {
            setSubmitting(true);
            try {
              runtime.repositories.inspections.update(inspectionId, {
                status: InspectionStatus.SUBMITTED,
                submittedAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
                score: form.score?.percentage ?? null,
                outcome: form.score?.outcome ?? 'PENDING',
              });
              invalidateQueries();
              void runtime.engine.sync('MANUAL');
              router.back();
            } finally {
              setSubmitting(false);
            }
          },
        },
      ],
    );
  }, [form, runtime, inspectionId, router]);

  // --- render --------------------------------------------------------------

  if (form.loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <LoadingState label="Loading inspection" />
      </View>
    );
  }

  if (!inspection || !form.template) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <EmptyState
          icon="⚠"
          title="Inspection unavailable"
          message="This inspection or its template is not on this device. It may still be downloading."
          action={<Button label="Back" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  const status = statusPresentation(inspection.status);
  const outcome = outcomePresentation(inspection.outcome);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/* --- sticky header --- */}
      <View
        style={{
          paddingTop: insets.top + theme.spacing.sm,
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.md,
          backgroundColor: theme.colors.surface,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          gap: theme.spacing.sm,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <Txt variant="caption" color="accent" onPress={() => router.back()} accessibilityRole="button">
            ‹ Back
          </Txt>
          <Txt variant="micro" color="muted" style={{ flex: 1 }} numberOfLines={1}>
            {inspection.number}
          </Txt>
          <Badge label={status.label} tone={status.tone} icon={status.icon} />
        </View>

        <Txt variant="heading" numberOfLines={2}>
          {inspection.title}
        </Txt>

        <ProgressBar
          value={form.progress}
          tone={form.progress === 1 ? 'success' : 'accent'}
          label={`${form.answeredCount} of ${form.totalCount} answered`}
        />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Txt variant="micro" color="muted" style={{ flex: 1 }}>
            {form.answeredCount}/{form.totalCount} answered
            {form.score?.percentage !== null && form.score?.percentage !== undefined
              ? ` · ${Math.round(form.score.percentage)}%`
              : ''}
          </Txt>

          {/* Saved-state chip: the visible proof that auto-save happened. */}
          <Txt variant="micro" color={form.saving ? 'warning' : 'success'}>
            {form.saving ? 'Saving…' : form.lastSavedAt ? `Saved ${formatRelativeTime(form.lastSavedAt)}` : 'Saved'}
          </Txt>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.huge * 2,
          gap: theme.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {readOnly ? (
          <Card>
            <View style={{ gap: theme.spacing.xs }}>
              <Txt variant="captionStrong" color="warning">
                Read only
              </Txt>
              <Txt variant="caption" color="secondary">
                This inspection is {inspection.status.toLowerCase().replace('_', ' ')} and can no
                longer be edited.
              </Txt>
            </View>
          </Card>
        ) : null}

        {form.blockers.length > 0 ? (
          <Card>
            <View style={{ gap: theme.spacing.xs }}>
              <Txt variant="captionStrong" color="danger">
                Cannot submit
              </Txt>
              {form.blockers.map((blocker, index) => (
                <Txt key={index} variant="caption" color="secondary">
                  {blocker}
                </Txt>
              ))}
            </View>
          </Card>
        ) : null}

        {form.sections
          .filter((section) => section.visible)
          .map((section) => {
            const isCollapsed = collapsed.has(section.section.id);
            return (
              <View
                key={section.section.id}
                onLayout={(e) => {
                  sectionOffsets.current[section.section.id] = e.nativeEvent.layout.y;
                }}
                style={{ gap: theme.spacing.md }}
              >
                {/* Section header doubles as a collapse control — a 200-question
                    checklist is unnavigable without it. */}
                <Txt
                  variant="subheading"
                  accessibilityRole="button"
                  onPress={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(section.section.id)) next.delete(section.section.id);
                      else next.add(section.section.id);
                      return next;
                    })
                  }
                >
                  {isCollapsed ? '▸' : '▾'} {section.section.title}
                </Txt>

                <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                  <Badge
                    label={`${section.answeredCount}/${section.fields.filter((f) => f.visible).length}`}
                    tone={section.complete ? 'success' : 'neutral'}
                    icon={section.complete ? '✓' : '○'}
                  />
                  {section.errorCount > 0 ? (
                    <Badge label={`${section.errorCount} to fix`} tone="danger" icon="!" />
                  ) : null}
                </View>

                {!isCollapsed ? (
                  <Card>
                    <View style={{ gap: theme.spacing.xl }}>
                      {section.section.description ? (
                        <>
                          <Txt variant="caption" color="muted">
                            {section.section.description}
                          </Txt>
                          <Divider />
                        </>
                      ) : null}

                      {section.fields
                        .filter((f) => f.visible)
                        .map((fieldState) => (
                          <FieldRenderer
                            key={fieldState.field.id}
                            state={{ ...fieldState, disabled: fieldState.disabled || readOnly }}
                            actions={actions}
                          />
                        ))}
                    </View>
                  </Card>
                ) : null}
              </View>
            );
          })}

        {/* --- outcome summary --- */}
        {form.score ? (
          <Card>
            <View style={{ gap: theme.spacing.md }}>
              <Txt variant="subheading">Result</Txt>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Txt variant="displayLarge">
                  {form.score.percentage !== null ? `${Math.round(form.score.percentage)}%` : '—'}
                </Txt>
                <Badge
                  label={outcomePresentation(form.score.outcome).label}
                  tone={outcomePresentation(form.score.outcome).tone}
                  icon={outcomePresentation(form.score.outcome).icon}
                />
              </View>

              {form.score.criticalFailures > 0 ? (
                <Txt variant="caption" color="danger">
                  {form.score.criticalFailures} critical failure
                  {form.score.criticalFailures === 1 ? '' : 's'} — this inspection cannot pass.
                </Txt>
              ) : form.score.failedFields > 0 ? (
                <Txt variant="caption" color="warning">
                  {form.score.failedFields} failed check
                  {form.score.failedFields === 1 ? '' : 's'} recorded.
                </Txt>
              ) : null}
            </View>
          </Card>
        ) : null}

        {!readOnly ? (
          <Button
            label="Submit inspection"
            size="large"
            onPress={submit}
            busy={submitting}
            fullWidth
          />
        ) : (
          <Button
            label="Generate report"
            variant="secondary"
            size="large"
            onPress={() => router.push(`/inspection/${inspectionId}/report`)}
            fullWidth
          />
        )}
      </ScrollView>

      <ScannerModal
        visible={scannerField !== null}
        title={scannerField?.label ?? 'Scan a code'}
        hint="Hold the camera steady over the asset label."
        qrOnly={scannerField?.ui.variant === 'DEFAULT' ? false : false}
        onClose={() => setScannerField(null)}
        onResult={handleScan}
      />

      <AudioRecorderModal
        visible={audioField !== null}
        onClose={() => setAudioField(null)}
        onResult={handleAudio}
      />
    </View>
  );
}

export { SignatureRole };
