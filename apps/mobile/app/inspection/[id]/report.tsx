/**
 * Report preview and export.
 *
 * Generation is deliberately explicit rather than automatic on screen entry:
 * embedding forty photos is memory-intensive and takes several seconds, and
 * doing it unbidden every time someone opens the screen would make the app feel
 * broken.
 */

import { formatBytes } from '@orbit/utils';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Button, Card, Divider, EmptyState, Txt } from '../../../src/components/ui';
import {
  type GeneratedReport,
  generateReport,
  printReport,
  shareReport,
} from '../../../src/features/report/report.service';
import { useLiveQuery } from '../../../src/hooks/useLiveQuery';
import { useRuntime } from '../../../src/stores/session.store';
import { useTheme } from '../../../src/theme/ThemeProvider';

export default function ReportScreen(): React.ReactElement {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const runtime = useRuntime();
  const { id } = useLocalSearchParams<{ id: string }>();
  const inspectionId = id ?? '';

  const [includePhotos, setIncludePhotos] = useState(true);
  const [includeMap, setIncludeMap] = useState(true);
  const [includeSignatures, setIncludeSignatures] = useState(true);
  const [failuresOnly, setFailuresOnly] = useState(false);

  const [busy, setBusy] = useState<'generate' | 'print' | 'share' | null>(null);
  const [report, setReport] = useState<GeneratedReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inspection = useLiveQuery(
    () => runtime.repositories.inspections.findById(inspectionId),
    [inspectionId],
  );

  const attachmentCount = useLiveQuery(
    () => runtime.repositories.attachments.forInspection(inspectionId).length,
    [inspectionId],
  );

  const options = useMemo(
    () => ({ includePhotos, includeMap, includeSignatures, failuresOnly }),
    [includePhotos, includeMap, includeSignatures, failuresOnly],
  );

  const generate = useCallback(async () => {
    setBusy('generate');
    setError(null);
    try {
      const result = await generateReport(runtime, inspectionId, options);
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The report could not be generated.');
    } finally {
      setBusy(null);
    }
  }, [runtime, inspectionId, options]);

  const print = useCallback(async () => {
    setBusy('print');
    setError(null);
    try {
      await printReport(runtime, inspectionId, options);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the print dialog.');
    } finally {
      setBusy(null);
    }
  }, [runtime, inspectionId, options]);

  const share = useCallback(async () => {
    if (!report) return;
    setBusy('share');
    try {
      await shareReport(report);
    } catch (err) {
      Alert.alert('Could not share', err instanceof Error ? err.message : 'Try again.');
    } finally {
      setBusy(null);
    }
  }, [report]);

  if (!inspection) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background, paddingTop: insets.top }}>
        <EmptyState
          icon="⚠"
          title="Inspection unavailable"
          action={<Button label="Back" onPress={() => router.back()} />}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        padding: theme.spacing.lg,
        paddingTop: insets.top + theme.spacing.lg,
        paddingBottom: theme.spacing.huge,
        gap: theme.spacing.lg,
      }}
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

      <View style={{ gap: theme.spacing.xs }}>
        <Txt variant="title">Report</Txt>
        <Txt variant="caption" color="secondary">
          {inspection.number} · {inspection.title}
        </Txt>
      </View>

      {/* Generation is fully local — worth saying, because most apps that claim
          offline support cannot do this one. */}
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <Txt color="success">✓</Txt>
          <Txt variant="caption" color="secondary" style={{ flex: 1 }}>
            Reports are generated on this device. No connection is needed.
          </Txt>
        </View>
      </Card>

      <Card padded={false}>
        <OptionRow
          label="Include photographs"
          hint={`${attachmentCount} attached`}
          value={includePhotos}
          onChange={setIncludePhotos}
        />
        <Divider />
        <OptionRow label="Include GPS coordinates" value={includeMap} onChange={setIncludeMap} />
        <Divider />
        <OptionRow
          label="Include signatures"
          value={includeSignatures}
          onChange={setIncludeSignatures}
        />
        <Divider />
        <OptionRow
          label="Failed items only"
          hint="Produces a defect schedule rather than the full checklist"
          value={failuresOnly}
          onChange={setFailuresOnly}
        />
      </Card>

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

      {report ? (
        <Card>
          <View style={{ gap: theme.spacing.md }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Txt variant="subheading">Ready</Txt>
              <Badge label={formatBytes(report.sizeBytes)} tone="success" icon="✓" />
            </View>
            <Txt variant="caption" color="muted" numberOfLines={1}>
              {report.fileName}
            </Txt>
            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
              <Button
                label="Share"
                onPress={() => void share()}
                busy={busy === 'share'}
                style={{ flex: 1 }}
              />
              <Button
                label="Print"
                variant="secondary"
                onPress={() => void print()}
                busy={busy === 'print'}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </Card>
      ) : null}

      <Button
        label={report ? 'Regenerate' : 'Generate report'}
        variant={report ? 'secondary' : 'primary'}
        size="large"
        onPress={() => void generate()}
        busy={busy === 'generate'}
        fullWidth
      />

      {!report ? (
        <Button
          label="Print without saving"
          variant="ghost"
          onPress={() => void print()}
          busy={busy === 'print'}
          fullWidth
        />
      ) : null}
    </ScrollView>
  );
}

function OptionRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.lg,
        padding: theme.spacing.lg,
        minHeight: theme.touchTarget.comfortable,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="body">{label}</Txt>
        {hint ? (
          <Txt variant="micro" color="muted">
            {hint}
          </Txt>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: theme.colors.accent, false: theme.colors.borderStrong }}
      />
    </View>
  );
}
