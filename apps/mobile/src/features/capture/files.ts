/**
 * File and document attachment.
 *
 * Inspectors attach manufacturer certificates, prior test sheets, and scanned
 * paperwork handed to them on site. Every picked file is copied into permanent
 * app storage before it is registered: the picker hands back a URI into a
 * temporary staging area or, on Android, a content:// URI that stops resolving
 * once the providing app is killed. Registering that URI directly produces an
 * attachment that works until the phone is restarted and then silently cannot
 * be uploaded.
 */

import { safeFileName, ulid } from '@orbit/utils';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

const MEDIA_DIR = `${FileSystem.documentDirectory}orbit-media/`;

/** Beyond this, a phone upload over a field connection is not realistic. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** What a field inspection legitimately attaches. */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
] as const;

export interface PickedFile {
  localUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  capturedAt: string;
}

export interface PickFailure {
  cancelled: boolean;
  /** Safe to show verbatim. Null when the user simply cancelled. */
  message: string | null;
}

export type PickOutcome = { ok: true; files: PickedFile[] } | { ok: false; failure: PickFailure };

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(MEDIA_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
}

/** Extension from a filename, or a sensible default from the MIME type. */
function extensionFor(name: string, mimeType: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 6) return name.slice(dot);
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType.startsWith('image/')) return `.${mimeType.split('/')[1]}`;
  if (mimeType === 'text/csv') return '.csv';
  return '.bin';
}

/**
 * Copy a picked file into permanent storage and hash it.
 *
 * The copy is the whole point: see the module note.
 */
async function adopt(asset: DocumentPicker.DocumentPickerAsset): Promise<PickedFile> {
  await ensureDir();

  const mimeType = asset.mimeType ?? 'application/octet-stream';
  const originalName = asset.name || `attachment${extensionFor('', mimeType)}`;
  const localUri = `${MEDIA_DIR}${ulid()}${extensionFor(originalName, mimeType)}`;

  await FileSystem.copyAsync({ from: asset.uri, to: localUri });

  const info = await FileSystem.getInfoAsync(localUri, { size: true });
  const sizeBytes = info.exists && 'size' in info ? info.size : (asset.size ?? 0);

  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return {
    localUri,
    fileName: safeFileName(originalName),
    mimeType,
    sizeBytes,
    checksum: await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, base64),
    capturedAt: new Date().toISOString(),
  };
}

export interface PickOptions {
  /** Restrict the picker. Defaults to the document set above. */
  mimeTypes?: readonly string[];
  multiple?: boolean;
  maxFiles?: number;
  maxBytes?: number;
}

/**
 * Present the system document picker.
 *
 * Returns a discriminated outcome rather than throwing: a cancelled pick is the
 * single most common result and is not an error, but it must be distinguishable
 * from a genuine failure so the caller does not show an alert for it.
 */
export async function pickDocuments(options: PickOptions = {}): Promise<PickOutcome> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;

  try {
    const result = await DocumentPicker.getDocumentAsync({
      type: options.mimeTypes ? [...options.mimeTypes] : [...DOCUMENT_MIME_TYPES],
      multiple: options.multiple ?? false,
      // Ask the OS to stage a readable copy; we still copy again into app
      // storage, because the staged copy is not guaranteed to outlive the session.
      copyToCacheDirectory: true,
    });

    if (result.canceled) {
      return { ok: false, failure: { cancelled: true, message: null } };
    }

    const assets = result.assets.slice(0, options.maxFiles ?? 10);

    const oversized = assets.filter((a) => (a.size ?? 0) > maxBytes);
    if (oversized.length > 0) {
      const limit = Math.round(maxBytes / 1_048_576);
      return {
        ok: false,
        failure: {
          cancelled: false,
          message:
            oversized.length === 1
              ? `“${oversized[0]!.name}” is larger than the ${limit} MB limit.`
              : `${oversized.length} files are larger than the ${limit} MB limit.`,
        },
      };
    }

    const files: PickedFile[] = [];
    for (const asset of assets) {
      files.push(await adopt(asset));
    }

    if (files.length === 0) {
      return { ok: false, failure: { cancelled: true, message: null } };
    }

    return { ok: true, files };
  } catch (err) {
    return {
      ok: false,
      failure: {
        cancelled: false,
        message: err instanceof Error ? err.message : 'The file could not be attached.',
      },
    };
  }
}

/** Convenience wrapper for fields that want any file type. */
export async function pickAnyFile(
  options: Omit<PickOptions, 'mimeTypes'> = {},
): Promise<PickOutcome> {
  return pickDocuments({ ...options, mimeTypes: ['*/*'] });
}

/** Human label for a MIME type, for the attachment list. */
export function describeFileType(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv')
    return 'Spreadsheet';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'Document';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('text/')) return 'Text';
  return 'File';
}
