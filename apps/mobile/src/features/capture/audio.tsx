/**
 * Voice note recording.
 *
 * Inspectors use these when their hands are dirty, they are wearing gloves, or
 * the observation is long enough that typing it on a phone in the rain is
 * unrealistic. So the control is one large button, and the recording is written
 * to permanent storage the instant it stops — a voice note describing a defect
 * cannot be re-recorded once the inspector has driven away.
 */

import type { GeoPoint } from '@orbit/types';
import { safeFileName, ulid } from '@orbit/utils';
import { Audio } from 'expo-av';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { Button, Txt } from '../../components/ui';
import { useTheme } from '../../theme/ThemeProvider';
import { quickLocation } from '../location/location.service';

const MEDIA_DIR = `${FileSystem.documentDirectory}orbit-media/`;

/** Above this, a recording is almost certainly an unattended microphone. */
const MAX_DURATION_MS = 10 * 60_000;

export interface AudioResult {
  localUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  durationMs: number;
  location: GeoPoint | null;
  capturedAt: string;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function AudioRecorderModal({
  visible,
  onClose,
  onResult,
}: {
  visible: boolean;
  onClose: () => void;
  onResult: (result: AudioResult) => void;
}): React.ReactElement {
  const theme = useTheme();
  const [permission, setPermission] = useState<Audio.PermissionResponse | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<AudioResult | null>(null);
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAt = useRef<number>(0);

  /** Release the microphone and any loaded sound on unmount or close. */
  const teardown = useCallback(async () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    if (recording) {
      // Stopping a recording that already stopped throws; the state is what we
      // want either way.
      await recording.stopAndUnloadAsync().catch(() => undefined);
    }
    if (sound) {
      await sound.unloadAsync().catch(() => undefined);
    }
  }, [recording, sound]);

  useEffect(() => {
    if (!visible) {
      void teardown();
      setRecording(null);
      setPreview(null);
      setSound(null);
      setPlaying(false);
      setElapsed(0);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => () => void teardown(), [teardown]);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);

    try {
      const granted = permission ?? (await Audio.requestPermissionsAsync());
      setPermission(granted);
      if (!granted.granted) {
        setError(
          granted.canAskAgain
            ? 'Microphone access is needed to record a voice note.'
            : 'Enable microphone access for Orbit Field in your device settings.',
        );
        return;
      }

      // Recording must keep working when the phone's ringer switch is set to
      // silent — inspectors keep them silenced on site.
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });

      const { recording: created } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );

      startedAt.current = Date.now();
      setRecording(created);
      setElapsed(0);

      timer.current = setInterval(() => {
        const value = Date.now() - startedAt.current;
        setElapsed(value);
        if (value >= MAX_DURATION_MS) void stop();
      }, 250);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording.');
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission]);

  const stop = useCallback(async () => {
    if (!recording) return;
    setBusy(true);

    try {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }

      const duration = Date.now() - startedAt.current;
      await recording.stopAndUnloadAsync();
      const tempUri = recording.getURI();
      setRecording(null);

      if (!tempUri) {
        setError('The recording could not be saved.');
        return;
      }

      // Moved out of the cache directory immediately: iOS reclaims that
      // directory without warning, and a voice note is not re-recordable.
      const info = await FileSystem.getInfoAsync(MEDIA_DIR);
      if (!info.exists) await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });

      const capturedAt = new Date().toISOString();
      const localUri = `${MEDIA_DIR}${ulid()}.m4a`;
      await FileSystem.moveAsync({ from: tempUri, to: localUri });

      const fileInfo = await FileSystem.getInfoAsync(localUri, { size: true });
      const base64 = await FileSystem.readAsStringAsync(localUri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      setPreview({
        localUri,
        fileName: safeFileName(`voice-note-${capturedAt.slice(0, 19).replace(/[:T]/g, '-')}.m4a`),
        mimeType: 'audio/m4a',
        sizeBytes: fileInfo.exists && 'size' in fileInfo ? fileInfo.size : 0,
        checksum: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64),
        durationMs: duration,
        location: await quickLocation(),
        capturedAt,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the recording.');
    } finally {
      setBusy(false);
    }
  }, [recording]);

  const togglePlayback = useCallback(async () => {
    if (!preview) return;

    if (sound) {
      if (playing) {
        await sound.pauseAsync();
        setPlaying(false);
      } else {
        await sound.replayAsync();
        setPlaying(true);
      }
      return;
    }

    await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    const { sound: loaded } = await Audio.Sound.createAsync({ uri: preview.localUri });
    loaded.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) setPlaying(false);
    });
    setSound(loaded);
    await loaded.playAsync();
    setPlaying(true);
  }, [preview, sound, playing]);

  const discard = useCallback(async () => {
    if (preview)
      await FileSystem.deleteAsync(preview.localUri, { idempotent: true }).catch(() => undefined);
    if (sound) await sound.unloadAsync().catch(() => undefined);
    setPreview(null);
    setSound(null);
    setPlaying(false);
    setElapsed(0);
  }, [preview, sound]);

  const isRecording = recording !== null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: theme.colors.background,
          padding: theme.spacing.lg,
          paddingTop: theme.spacing.huge,
          gap: theme.spacing.xl,
        }}
      >
        <View style={{ gap: theme.spacing.xs }}>
          <Txt variant="title">Voice note</Txt>
          <Txt variant="caption" color="secondary">
            Recorded on this device and uploaded with the rest of the inspection.
          </Txt>
        </View>

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

        <View
          style={{
            alignItems: 'center',
            gap: theme.spacing.lg,
            paddingVertical: theme.spacing.xxl,
          }}
        >
          <Txt variant="displayLarge" style={{ fontVariant: ['tabular-nums'] }}>
            {formatElapsed(preview ? preview.durationMs : elapsed)}
          </Txt>

          {isRecording ? (
            <Txt variant="caption" color="danger">
              ● Recording
            </Txt>
          ) : preview ? (
            <Txt variant="caption" color="success">
              Saved to this device
            </Txt>
          ) : (
            <Txt variant="caption" color="muted">
              Ready
            </Txt>
          )}

          {!preview ? (
            <Pressable
              onPress={() => void (isRecording ? stop() : start())}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
              style={{
                width: 96,
                height: 96,
                borderRadius: 48,
                backgroundColor: isRecording ? theme.colors.danger : theme.colors.accent,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: busy ? 0.6 : 1,
              }}
            >
              {/* Square to stop, circle to record — the universal convention,
                  legible without reading a label. */}
              <View
                style={
                  isRecording
                    ? { width: 30, height: 30, borderRadius: 4, backgroundColor: '#fff' }
                    : { width: 34, height: 34, borderRadius: 17, backgroundColor: '#fff' }
                }
              />
            </Pressable>
          ) : (
            <Button
              label={playing ? 'Pause' : 'Play back'}
              variant="secondary"
              onPress={() => void togglePlayback()}
              size="large"
            />
          )}

          {isRecording ? (
            <Txt variant="micro" color="muted">
              Stops automatically after {MAX_DURATION_MS / 60_000} minutes
            </Txt>
          ) : null}
        </View>

        <View style={{ marginTop: 'auto', gap: theme.spacing.md }}>
          {preview ? (
            <>
              <Button
                label="Attach this recording"
                onPress={() => {
                  onResult(preview);
                  onClose();
                }}
                fullWidth
                size="large"
              />
              <Button
                label="Record again"
                variant="secondary"
                onPress={() => void discard()}
                fullWidth
              />
            </>
          ) : null}
          <Button
            label="Cancel"
            variant="ghost"
            onPress={() => {
              void discard();
              onClose();
            }}
            fullWidth
          />
        </View>
      </View>
    </Modal>
  );
}
