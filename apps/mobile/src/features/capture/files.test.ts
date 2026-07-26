/**
 * File attachment behaviour.
 *
 * The interesting cases are all failure cases: a cancelled pick must be
 * distinguishable from a genuine error (or the app shows an alert every time
 * someone changes their mind), and an oversized file must be refused before it
 * enters the upload queue rather than after it has failed twelve times.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocked before import: these modules reach for native bindings at load time.
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-file-system', () => ({
  documentDirectory: 'file:///documents/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: vi.fn(),
  makeDirectoryAsync: vi.fn(),
  copyAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: vi.fn(),
}));

import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';

import { describeFileType, DOCUMENT_MIME_TYPES, pickDocuments } from './files';

const picker = vi.mocked(DocumentPicker.getDocumentAsync);
const fs = vi.mocked(FileSystem);
const crypto = vi.mocked(Crypto);

beforeEach(() => {
  vi.clearAllMocks();
  fs.getInfoAsync.mockResolvedValue({ exists: true, size: 1024 } as never);
  fs.makeDirectoryAsync.mockResolvedValue(undefined as never);
  fs.copyAsync.mockResolvedValue(undefined as never);
  fs.readAsStringAsync.mockResolvedValue('ZmFrZQ==' as never);
  crypto.digestStringAsync.mockResolvedValue('a'.repeat(64) as never);
});

function asset(overrides: Partial<DocumentPicker.DocumentPickerAsset> = {}) {
  return {
    uri: 'file:///cache/staged/report.pdf',
    name: 'Certificate of Compliance.pdf',
    size: 1024,
    mimeType: 'application/pdf',
    ...overrides,
  } as DocumentPicker.DocumentPickerAsset;
}

describe('pickDocuments', () => {
  it('reports a cancelled pick without an error message', async () => {
    picker.mockResolvedValue({ canceled: true, assets: null } as never);

    const outcome = await pickDocuments();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.cancelled).toBe(true);
      // Null message is what stops the caller alerting on every cancel.
      expect(outcome.failure.message).toBeNull();
    }
  });

  it('copies the picked file into app storage rather than trusting the picker URI', async () => {
    picker.mockResolvedValue({ canceled: false, assets: [asset()] } as never);

    const outcome = await pickDocuments();
    expect(outcome.ok).toBe(true);

    // The staged/content:// URI stops resolving once the providing app dies,
    // which would leave an attachment that can never be uploaded.
    expect(fs.copyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'file:///cache/staged/report.pdf' }),
    );
    if (outcome.ok) {
      expect(outcome.files[0]!.localUri).toContain('orbit-media/');
      expect(outcome.files[0]!.localUri).not.toBe('file:///cache/staged/report.pdf');
    }
  });

  it('preserves the file extension so the server can serve a correct content type', async () => {
    picker.mockResolvedValue({ canceled: false, assets: [asset()] } as never);
    const outcome = await pickDocuments();
    if (outcome.ok) expect(outcome.files[0]!.localUri.endsWith('.pdf')).toBe(true);
  });

  it('sanitises the display name without losing the extension', async () => {
    picker.mockResolvedValue({
      canceled: false,
      assets: [asset({ name: 'Report: 2026/01 <final>.pdf' })],
    } as never);

    const outcome = await pickDocuments();
    if (outcome.ok) {
      const name = outcome.files[0]!.fileName;
      expect(name).not.toMatch(/[/<>:]/);
      expect(name.endsWith('.pdf')).toBe(true);
    }
  });

  it('hashes the file so the server can deduplicate and verify it', async () => {
    picker.mockResolvedValue({ canceled: false, assets: [asset()] } as never);
    const outcome = await pickDocuments();
    if (outcome.ok) expect(outcome.files[0]!.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses an oversized file before it reaches the upload queue', async () => {
    picker.mockResolvedValue({
      canceled: false,
      assets: [asset({ name: 'huge.pdf', size: 80 * 1024 * 1024 })],
    } as never);

    const outcome = await pickDocuments();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.cancelled).toBe(false);
      expect(outcome.failure.message).toContain('huge.pdf');
      expect(outcome.failure.message).toContain('MB');
    }
    // Nothing was copied — the rejection happens before any disk work.
    expect(fs.copyAsync).not.toHaveBeenCalled();
  });

  it('caps how many files one pick can attach', async () => {
    picker.mockResolvedValue({
      canceled: false,
      assets: Array.from({ length: 20 }, (_, i) => asset({ name: `doc-${i}.pdf` })),
    } as never);

    const outcome = await pickDocuments({ multiple: true, maxFiles: 3 });
    if (outcome.ok) expect(outcome.files).toHaveLength(3);
  });

  it('turns a picker crash into a reportable failure rather than throwing', async () => {
    picker.mockRejectedValue(new Error('Provider not available'));

    const outcome = await pickDocuments();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.cancelled).toBe(false);
      expect(outcome.failure.message).toContain('Provider not available');
    }
  });

  it('restricts the picker to document types by default', async () => {
    picker.mockResolvedValue({ canceled: true, assets: null } as never);
    await pickDocuments();
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.arrayContaining(['application/pdf']) }),
    );
  });

  it('offers the document types an inspection actually receives', () => {
    expect(DOCUMENT_MIME_TYPES).toContain('application/pdf');
    expect(DOCUMENT_MIME_TYPES).toContain('image/jpeg');
    expect(DOCUMENT_MIME_TYPES).toContain('text/csv');
  });
});

describe('describeFileType', () => {
  it('names types in words an inspector recognises', () => {
    expect(describeFileType('application/pdf')).toBe('PDF');
    expect(describeFileType('image/png')).toBe('Image');
    expect(describeFileType('text/csv')).toBe('Spreadsheet');
    expect(describeFileType('audio/m4a')).toBe('Audio');
    expect(describeFileType('application/octet-stream')).toBe('File');
  });
});
