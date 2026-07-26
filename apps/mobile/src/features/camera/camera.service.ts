/**
 * Photo capture and processing.
 *
 * The pipeline for every captured image:
 *   capture → persist raw to permanent storage → compress → hash → register
 *
 * Persisting *before* compressing is deliberate. Compression can fail or be
 * interrupted; the original must already be somewhere durable by then, because
 * an inspector cannot go back and re-photograph a panel they have driven away
 * from. Cost is transient disk use, which is recoverable. A lost photo is not.
 *
 * Files live in `documentDirectory`, never `cacheDirectory` — iOS reclaims the
 * cache directory under storage pressure without warning, which would silently
 * destroy evidence that has not yet uploaded.
 */

import { AttachmentKind, type GeoPoint } from '@orbit/types';
import { safeFileName, ulid } from '@orbit/utils';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';

import { quickLocation } from '../location/location.service';

const MEDIA_DIR = `${FileSystem.documentDirectory}orbit-media/`;
const THUMB_DIR = `${FileSystem.documentDirectory}orbit-thumbs/`;

export interface ProcessedImage {
  localUri: string;
  thumbnailUri: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  width: number;
  height: number;
  location: GeoPoint | null;
  capturedAt: string;
}

export interface CaptureSettings {
  /** JPEG quality 0..1 after resize. */
  quality?: number;
  /** Longest edge in pixels. */
  maxDimension?: number;
  /** Burn GPS + timestamp into the pixels. */
  watermark?: boolean;
  /** Attach a location fix to the metadata (independent of watermarking). */
  captureLocation?: boolean;
}

export const DEFAULT_CAPTURE: Required<CaptureSettings> = {
  // 0.72 at 2048px keeps defect detail legible while landing most photos under
  // 500 KB — the difference between a day's evidence syncing over 3G or not.
  quality: 0.72,
  maxDimension: 2048,
  watermark: true,
  captureLocation: true,
};

async function ensureDirectories(): Promise<void> {
  for (const dir of [MEDIA_DIR, THUMB_DIR]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    }
  }
}

/** SHA-256 of the file, used for dedupe and server-side integrity checking. */
async function hashFile(uri: string): Promise<string> {
  // Hashing base64 rather than raw bytes because expo-crypto has no streaming
  // API. Acceptable at inspection photo sizes; a 40 MB video is hashed by the
  // uploader in chunks instead.
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64);
}

/**
 * Move a freshly captured file out of the camera's temporary location.
 *
 * The camera writes to the cache directory. Anything left there is at the mercy
 * of the OS, so this is the first thing that happens after the shutter.
 */
async function persistOriginal(sourceUri: string, extension = 'jpg'): Promise<string> {
  await ensureDirectories();
  const target = `${MEDIA_DIR}${ulid()}.${extension}`;
  try {
    await FileSystem.moveAsync({ from: sourceUri, to: target });
  } catch {
    // A move across volumes fails on some Android devices; copy is the fallback.
    await FileSystem.copyAsync({ from: sourceUri, to: target });
    await FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(() => undefined);
  }
  return target;
}

/**
 * Process a captured photo: resize, compress, thumbnail, hash.
 *
 * The returned `localUri` is the compressed image — that is what uploads and
 * what appears in the report. The original is replaced rather than kept: at
 * 2048px/0.72 the visual difference is negligible and keeping both would double
 * storage on a device that may hold a week of work.
 */
export async function processPhoto(
  sourceUri: string,
  settings: CaptureSettings = {},
): Promise<ProcessedImage> {
  const config = { ...DEFAULT_CAPTURE, ...settings };
  const capturedAt = new Date().toISOString();

  // Durable first, always.
  const originalUri = await persistOriginal(sourceUri);

  // Location is fetched in parallel with compression — the fix takes longer than
  // the resize, and serialising them would add a visible pause between shots.
  const locationPromise = config.captureLocation ? quickLocation() : Promise.resolve(null);

  const manipulated = await ImageManipulator.manipulateAsync(
    originalUri,
    [{ resize: { width: config.maxDimension } }],
    { compress: config.quality, format: ImageManipulator.SaveFormat.JPEG },
  );

  const thumbnail = await ImageManipulator.manipulateAsync(
    originalUri,
    [{ resize: { width: 320 } }],
    { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG },
  );

  const location = await locationPromise;

  // Replace the original with the compressed version.
  await FileSystem.deleteAsync(originalUri, { idempotent: true }).catch(() => undefined);
  const finalUri = `${MEDIA_DIR}${ulid()}.jpg`;
  await FileSystem.moveAsync({ from: manipulated.uri, to: finalUri });

  const thumbUri = `${THUMB_DIR}${ulid()}.jpg`;
  await FileSystem.moveAsync({ from: thumbnail.uri, to: thumbUri });

  const info = await FileSystem.getInfoAsync(finalUri, { size: true });
  const checksum = await hashFile(finalUri);

  return {
    localUri: finalUri,
    thumbnailUri: thumbUri,
    fileName: safeFileName(`photo-${capturedAt.slice(0, 19).replace(/[:T]/g, '-')}.jpg`),
    mimeType: 'image/jpeg',
    sizeBytes: info.exists && 'size' in info ? info.size : 0,
    checksum,
    width: manipulated.width,
    height: manipulated.height,
    location,
    capturedAt,
  };
}

/**
 * Watermark overlay description.
 *
 * Rendered as an SVG overlay at report-generation time rather than burned into
 * the JPEG. Burning it in destroys the original evidence irreversibly, and a
 * watermark with a wrong or low-accuracy coordinate baked in cannot be
 * corrected. Keeping it as metadata means the report can render it truthfully —
 * including the accuracy — while the photograph itself stays pristine.
 */
export interface WatermarkData {
  capturedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  inspectionNumber: string | null;
  inspectorName: string | null;
}

export function buildWatermark(
  image: ProcessedImage,
  context: { inspectionNumber?: string | null; inspectorName?: string | null } = {},
): WatermarkData {
  return {
    capturedAt: image.capturedAt,
    latitude: image.location?.latitude ?? null,
    longitude: image.location?.longitude ?? null,
    accuracyMeters: image.location?.accuracy ?? null,
    inspectionNumber: context.inspectionNumber ?? null,
    inspectorName: context.inspectorName ?? null,
  };
}

/** Human-readable watermark lines, shared by the preview and the PDF. */
export function watermarkLines(data: WatermarkData): string[] {
  const lines: string[] = [];
  lines.push(new Date(data.capturedAt).toLocaleString());

  if (data.latitude !== null && data.longitude !== null) {
    const accuracy = data.accuracyMeters !== null ? ` ±${Math.round(data.accuracyMeters)}m` : '';
    lines.push(`${data.latitude.toFixed(6)}, ${data.longitude.toFixed(6)}${accuracy}`);
  } else {
    // Said explicitly. A photo with no location must not silently look like one
    // that simply had the watermark cropped.
    lines.push('No location fix');
  }

  if (data.inspectionNumber) lines.push(data.inspectionNumber);
  if (data.inspectorName) lines.push(data.inspectorName);
  return lines;
}

export interface VideoResult {
  localUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  durationMs: number | null;
  location: GeoPoint | null;
  capturedAt: string;
}

/** Persist a recorded video. Not re-encoded — that would take minutes on-device. */
export async function processVideo(
  sourceUri: string,
  durationMs: number | null,
): Promise<VideoResult> {
  const capturedAt = new Date().toISOString();
  const localUri = await persistOriginal(sourceUri, 'mp4');
  const info = await FileSystem.getInfoAsync(localUri, { size: true });
  const location = await quickLocation();

  return {
    localUri,
    fileName: safeFileName(`video-${capturedAt.slice(0, 19).replace(/[:T]/g, '-')}.mp4`),
    mimeType: 'video/mp4',
    sizeBytes: info.exists && 'size' in info ? info.size : 0,
    checksum: await hashFile(localUri),
    durationMs,
    location,
    capturedAt,
  };
}

/** Write a signature PNG/SVG to permanent storage and hash it. */
export async function persistSignatureSvg(svg: string): Promise<{
  localUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}> {
  await ensureDirectories();
  const localUri = `${MEDIA_DIR}${ulid()}.svg`;
  await FileSystem.writeAsStringAsync(localUri, svg, { encoding: FileSystem.EncodingType.UTF8 });
  const info = await FileSystem.getInfoAsync(localUri, { size: true });

  return {
    localUri,
    fileName: safeFileName(`signature-${Date.now()}.svg`),
    mimeType: 'image/svg+xml',
    sizeBytes: info.exists && 'size' in info ? info.size : 0,
    checksum: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, svg),
  };
}

/** Total bytes held in the media directories. */
export async function mediaStorageBytes(): Promise<number> {
  let total = 0;
  for (const dir of [MEDIA_DIR, THUMB_DIR]) {
    try {
      const files = await FileSystem.readDirectoryAsync(dir);
      for (const file of files) {
        const info = await FileSystem.getInfoAsync(`${dir}${file}`, { size: true });
        if (info.exists && 'size' in info) total += info.size;
      }
    } catch {
      // Directory absent — nothing captured yet.
    }
  }
  return total;
}

/**
 * Remove orphaned files.
 *
 * Only deletes files with no matching attachment row. A file whose row still
 * exists is never touched, however old, because the row is what proves whether
 * the bytes have reached the server.
 */
export async function cleanupOrphans(knownUris: Set<string>): Promise<number> {
  let removed = 0;
  for (const dir of [MEDIA_DIR, THUMB_DIR]) {
    try {
      const files = await FileSystem.readDirectoryAsync(dir);
      for (const file of files) {
        const uri = `${dir}${file}`;
        if (knownUris.has(uri)) continue;
        await FileSystem.deleteAsync(uri, { idempotent: true });
        removed += 1;
      }
    } catch {
      continue;
    }
  }
  return removed;
}

export { AttachmentKind, MEDIA_DIR, THUMB_DIR };
