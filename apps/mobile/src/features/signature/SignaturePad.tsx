/**
 * Signature capture.
 *
 * Strokes are captured as vector paths rather than a rasterised bitmap. That
 * matters for three reasons: the PDF can render at any resolution without
 * pixelation, the raw stroke data is retained for forensic comparison if a
 * signature is ever disputed, and vectors are two orders of magnitude smaller to
 * sync than an image.
 *
 * The rasterised PNG for the report is produced from the same paths at export
 * time, so the two can never disagree.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { JsonValue } from '@orbit/types';
import { Button, Txt } from '../../components/ui';
import { useTheme } from '../../theme/ThemeProvider';

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  points: Point[];
  /** Millis since capture began — proves the signature was drawn, not pasted. */
  startedAt: number;
  endedAt: number;
}

export interface SignatureData {
  strokes: Stroke[];
  /** Canvas dimensions the strokes were captured in, for correct scaling later. */
  width: number;
  height: number;
  capturedAt: string;
}

/**
 * Convert a stroke to an SVG path.
 *
 * Uses quadratic midpoint smoothing rather than joining raw points with straight
 * lines: touch sampling is coarse enough that a polyline signature looks visibly
 * jagged and unlike the person's actual hand.
 */
export function strokeToPath(stroke: Stroke): string {
  const points = stroke.points;
  if (points.length === 0) return '';
  if (points.length === 1) {
    // A single tap is a dot — rendered as a tiny arc so it is visible at all.
    const p = points[0]!;
    return `M ${p.x} ${p.y} l 0.1 0`;
  }

  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const current = points[i]!;
    const next = points[i + 1]!;
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    d += ` Q ${current.x} ${current.y} ${midX} ${midY}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Render a full signature as one SVG path string — used by the PDF engine. */
export function signatureToSvg(
  data: SignatureData,
  options: { strokeWidth?: number; color?: string } = {},
): string {
  const paths = data.strokes
    .map((s) => `<path d="${strokeToPath(s)}" fill="none" stroke="${options.color ?? '#000000'}" stroke-width="${options.strokeWidth ?? 2.5}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${data.width} ${data.height}" width="${data.width}" height="${data.height}">${paths}</svg>`;
}

export function SignaturePad({
  onChange,
  initial,
  disabled,
  height = 220,
}: {
  onChange: (data: SignatureData | null) => void;
  initial?: SignatureData | null;
  disabled?: boolean;
  height?: number;
}): React.ReactElement {
  const theme = useTheme();
  const [strokes, setStrokes] = useState<Stroke[]>(() => initial?.strokes ?? []);
  const [canvas, setCanvas] = useState({ width: 0, height });

  // Mutable refs: PanResponder callbacks are created once and would otherwise
  // close over stale state on every move event.
  const currentPoints = useRef<Point[]>([]);
  const strokeStart = useRef<number>(0);
  const strokesRef = useRef<Stroke[]>(strokes);
  strokesRef.current = strokes;

  const [, forceRender] = useState(0);

  const commit = useCallback(
    (next: Stroke[]) => {
      setStrokes(next);
      onChange(
        next.length === 0
          ? null
          : {
              strokes: next,
              width: canvas.width,
              height: canvas.height,
              capturedAt: new Date().toISOString(),
            },
      );
    },
    [onChange, canvas.width, canvas.height],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        // Claim the gesture so an enclosing ScrollView does not steal it
        // mid-signature, which would truncate the stroke.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,

        onPanResponderGrant: (event) => {
          strokeStart.current = Date.now();
          currentPoints.current = [
            { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY },
          ];
          forceRender((n) => n + 1);
        },

        onPanResponderMove: (event) => {
          const { locationX, locationY } = event.nativeEvent;
          const last = currentPoints.current[currentPoints.current.length - 1];
          // Drop sub-pixel jitter: it triples the point count without changing
          // how the signature looks, and bloats what has to sync.
          if (last && Math.abs(last.x - locationX) < 1 && Math.abs(last.y - locationY) < 1) return;
          currentPoints.current.push({ x: locationX, y: locationY });
          forceRender((n) => n + 1);
        },

        onPanResponderRelease: () => {
          if (currentPoints.current.length === 0) return;
          const stroke: Stroke = {
            points: currentPoints.current,
            startedAt: strokeStart.current,
            endedAt: Date.now(),
          };
          currentPoints.current = [];
          commit([...strokesRef.current, stroke]);
        },
      }),
    [disabled, commit],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height: h } = event.nativeEvent.layout;
    setCanvas({ width, height: h });
  }, []);

  const undo = useCallback(() => {
    commit(strokesRef.current.slice(0, -1));
  }, [commit]);

  const clear = useCallback(() => {
    currentPoints.current = [];
    commit([]);
  }, [commit]);

  const isEmpty = strokes.length === 0 && currentPoints.current.length === 0;

  return (
    <View style={{ gap: theme.spacing.md }}>
      <View
        onLayout={onLayout}
        {...panResponder.panHandlers}
        style={{
          height,
          borderRadius: theme.radius.md,
          borderWidth: 2,
          borderStyle: 'dashed',
          borderColor: isEmpty ? theme.colors.borderStrong : theme.colors.border,
          // Always light: a signature is a legal artefact and must look the same
          // on screen as it does in the printed report.
          backgroundColor: '#FFFFFF',
          overflow: 'hidden',
          opacity: disabled ? 0.6 : 1,
        }}
        accessibilityLabel="Signature area"
        accessibilityHint="Draw your signature with your finger or a stylus"
      >
        <Svg width="100%" height="100%">
          {strokes.map((stroke, index) => (
            <Path
              key={index}
              d={strokeToPath(stroke)}
              stroke="#0B0F1A"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          ))}
          {currentPoints.current.length > 0 ? (
            <Path
              d={strokeToPath({
                points: currentPoints.current,
                startedAt: strokeStart.current,
                endedAt: Date.now(),
              })}
              stroke="#0B0F1A"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          ) : null}
        </Svg>

        {isEmpty ? (
          <View
            style={{
              ...StyleSheetAbsoluteFill,
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <Txt variant="caption" style={{ color: '#94A3BC' }}>
              Sign here
            </Txt>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <Button
          label="Undo"
          variant="secondary"
          onPress={undo}
          disabled={disabled || strokes.length === 0}
          style={{ flex: 1 }}
        />
        <Button
          label="Clear"
          variant="ghost"
          onPress={clear}
          disabled={disabled || isEmpty}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}

const StyleSheetAbsoluteFill = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

/** Serialise for the `strokes` JSON column. */
export function serialiseSignature(data: SignatureData): JsonValue {
  return data as unknown as JsonValue;
}

export function deserialiseSignature(raw: JsonValue | null): SignatureData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as unknown as SignatureData;
  return Array.isArray(candidate.strokes) ? candidate : null;
}
