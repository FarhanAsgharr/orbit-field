/**
 * Barcode and QR scanning.
 *
 * One screen handles both: the underlying camera API decodes every symbology
 * from the same stream, and an inspector holding a phone at an asset label does
 * not care what the encoding is called. What they care about is that it reads
 * the scratched, faded, half-obscured label on the first try.
 *
 * Two consequences:
 *  - Manual entry is always available, never a hidden fallback. Labels behind a
 *    panel or under twenty years of grime cannot be scanned at all, and refusing
 *    manual entry would block the inspection entirely.
 *  - A scan is confirmed, not auto-accepted. Reading the wrong adjacent barcode
 *    silently attaches an inspection to the wrong asset, which is worse than
 *    one extra tap.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Button, Field, Txt } from '../../components/ui';
import { useTheme } from '../../theme/ThemeProvider';

/** Symbologies worth decoding for asset and equipment labels. */
export const SUPPORTED_SYMBOLOGIES = [
  'qr', 'ean13', 'ean8', 'code128', 'code39', 'code93',
  'codabar', 'itf14', 'upc_a', 'upc_e', 'datamatrix', 'pdf417', 'aztec',
] as const;

export interface ScanResult {
  value: string;
  /** Symbology reported by the decoder, e.g. `code128`. */
  type: string;
  scannedAt: string;
  /** True when the operator typed it rather than scanning. */
  manual: boolean;
}

export function ScannerModal({
  visible,
  title,
  hint,
  onClose,
  onResult,
  /** Restrict to QR only, for fields that expect a QR payload specifically. */
  qrOnly = false,
}: {
  visible: boolean;
  title: string;
  hint?: string;
  onClose: () => void;
  onResult: (result: ScanResult) => void;
  qrOnly?: boolean;
}): React.ReactElement {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [candidate, setCandidate] = useState<{ value: string; type: string } | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [showManual, setShowManual] = useState(false);

  // The decoder fires continuously while a code is in frame. Without this latch
  // a single label produces dozens of callbacks a second.
  const latched = useRef(false);

  useEffect(() => {
    if (!visible) {
      latched.current = false;
      setCandidate(null);
      setManualValue('');
      setShowManual(false);
    }
  }, [visible]);

  const handleScan = useCallback((result: BarcodeScanningResult) => {
    if (latched.current) return;
    const value = result.data?.trim();
    if (!value) return;

    latched.current = true;
    // A short haptic confirms the read without the inspector having to look at
    // the screen — useful when the phone is held at an awkward angle.
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setCandidate({ value, type: result.type ?? 'unknown' });
  }, []);

  const accept = useCallback(
    (value: string, type: string, manual: boolean) => {
      onResult({ value, type, scannedAt: new Date().toISOString(), manual });
      onClose();
    },
    [onResult, onClose],
  );

  const rescan = useCallback(() => {
    latched.current = false;
    setCandidate(null);
  }, []);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* --- camera or permission gate --- */}
        {permission?.granted && !showManual ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{
              barcodeTypes: qrOnly ? ['qr'] : [...SUPPORTED_SYMBOLOGIES],
            }}
            onBarcodeScanned={candidate ? undefined : handleScan}
          />
        ) : null}

        {/* --- framing guide --- */}
        {permission?.granted && !showManual && !candidate ? (
          <View style={styles.overlay} pointerEvents="none">
            <View
              style={[
                styles.reticle,
                { borderColor: theme.colors.accent, aspectRatio: qrOnly ? 1 : 1.8 },
              ]}
            />
          </View>
        ) : null}

        {/* --- header --- */}
        <View style={[styles.header, { paddingTop: theme.spacing.huge }]}>
          <Pressable onPress={onClose} hitSlop={16} accessibilityRole="button" accessibilityLabel="Cancel scanning">
            <Txt variant="bodyStrong" style={{ color: '#fff' }}>Cancel</Txt>
          </Pressable>
          <Txt variant="subheading" style={{ color: '#fff', flex: 1, textAlign: 'center' }}>
            {title}
          </Txt>
          <View style={{ width: 60 }} />
        </View>

        {/* --- body --- */}
        <View style={styles.footer}>
          {!permission ? (
            <Txt style={{ color: '#fff' }}>Checking camera access…</Txt>
          ) : !permission.granted && !showManual ? (
            <View style={{ gap: theme.spacing.md }}>
              <Txt variant="subheading" style={{ color: '#fff' }}>Camera access needed</Txt>
              <Txt variant="caption" style={{ color: '#C3CDDC' }}>
                {permission.canAskAgain
                  ? 'Orbit Field uses the camera to read asset labels.'
                  : 'Enable camera access for Orbit Field in your device settings, or type the code instead.'}
              </Txt>
              {permission.canAskAgain ? (
                <Button label="Allow camera" onPress={() => void requestPermission()} fullWidth />
              ) : null}
              <Button label="Type the code instead" variant="secondary" onPress={() => setShowManual(true)} fullWidth />
            </View>
          ) : candidate ? (
            // Confirm rather than auto-accept: labels sit next to each other on
            // a panel, and silently attaching the wrong asset is unrecoverable
            // once the inspector has left site.
            <View style={{ gap: theme.spacing.md }}>
              <Txt variant="caption" style={{ color: '#94A3BC' }}>
                {candidate.type.toUpperCase()} · scanned
              </Txt>
              <Txt variant="title" style={{ color: '#fff' }} numberOfLines={3}>
                {candidate.value}
              </Txt>
              <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                <Button label="Scan again" variant="secondary" onPress={rescan} style={{ flex: 1 }} />
                <Button
                  label="Use this code"
                  onPress={() => accept(candidate.value, candidate.type, false)}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : showManual ? (
            <View style={{ gap: theme.spacing.md }}>
              <Field
                label="Asset or equipment code"
                value={manualValue}
                onChangeText={setManualValue}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                placeholder="e.g. MPG-B2-DB01"
              />
              <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                {permission.granted ? (
                  <Button
                    label="Use camera"
                    variant="secondary"
                    onPress={() => setShowManual(false)}
                    style={{ flex: 1 }}
                  />
                ) : null}
                <Button
                  label="Save code"
                  onPress={() => accept(manualValue.trim(), 'manual', true)}
                  disabled={manualValue.trim().length === 0}
                  style={{ flex: 1 }}
                />
              </View>
            </View>
          ) : (
            <View style={{ gap: theme.spacing.md }}>
              <Txt variant="caption" style={{ color: '#C3CDDC', textAlign: 'center' }}>
                {hint ?? 'Hold the camera steady over the label.'}
              </Txt>
              <Button
                label="Label damaged? Type it instead"
                variant="secondary"
                onPress={() => setShowManual(true)}
                fullWidth
              />
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  reticle: { width: '78%', borderWidth: 3, borderRadius: 14, backgroundColor: 'transparent' },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 16,
    backgroundColor: 'rgba(7,10,18,0.72)',
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 20,
    paddingBottom: 40,
    backgroundColor: 'rgba(7,10,18,0.88)',
  },
});
