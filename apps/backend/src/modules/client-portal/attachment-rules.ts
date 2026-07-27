/**
 * What a customer is allowed to attach.
 *
 * These files arrive from outside the organisation — the one place in Orbit
 * Field where an unauthenticated-in-spirit party puts bytes on the server —
 * and they are later opened by an inspector on a phone and by staff on a
 * desktop. So the rules are a allowlist, not a blocklist: a blocklist of
 * dangerous extensions is a list you will always be one entry behind on,
 * whereas a list of the eight things a customer legitimately sends is a list
 * that stops being wrong.
 *
 * Nothing here scans for malware. Saying so plainly matters more than implying
 * otherwise: there is no scanner in this deployment, and what these rules
 * actually buy is that the server will not store an executable, will not write
 * outside its storage root, and will not serve anything back with a
 * content-type a browser will run. That is meaningfully less than antivirus,
 * and pretending otherwise would be the dangerous part.
 */

import { AppError, ErrorCode } from '@orbit/shared';

/** 25 MB, as the product specifies. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Twenty files is generous for a request and bounded enough to be safe. */
export const MAX_ATTACHMENTS_PER_REQUEST = 20;

/**
 * Accepted types, keyed by MIME with the extensions each may claim.
 *
 * Both halves are checked. A `.exe` renamed to `.pdf` is caught by the
 * extension not matching the declared type; a real executable declared as
 * `application/pdf` is caught by the magic-number check below.
 */
const ALLOWED: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/zip': ['.zip'],
  'text/plain': ['.txt', '.text', '.log', '.csv'],
};

/**
 * Extensions refused whatever they claim to be.
 *
 * Redundant with the allowlist — none of these could pass it — and kept
 * because it makes the refusal message specific, and because a future edit
 * that widens `ALLOWED` should still not be able to admit these by accident.
 */
const NEVER = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.jar',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
  '.vbs',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.php',
  '.pl',
  '.app',
  '.deb',
  '.rpm',
  '.apk',
  '.dmg',
  '.pkg',
  '.lnk',
  '.reg',
  '.hta',
  '.wsf',
  '.scpt',
]);

/** Leading bytes for the formats where a cheap check is meaningful. */
const MAGIC: Array<{ mime: string; prefix: number[]; offset?: number }> = [
  { mime: 'application/pdf', prefix: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: 'image/png', prefix: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  // docx/xlsx/zip are all zip containers.
  { mime: 'application/zip', prefix: [0x50, 0x4b] },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    prefix: [0x50, 0x4b],
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    prefix: [0x50, 0x4b],
  },
  // Legacy Office is an OLE compound file.
  { mime: 'application/msword', prefix: [0xd0, 0xcf, 0x11, 0xe0] },
  { mime: 'application/vnd.ms-excel', prefix: [0xd0, 0xcf, 0x11, 0xe0] },
];

/** Executable signatures, refused whatever the name and type claim. */
const EXECUTABLE_MAGIC: Array<{ label: string; prefix: number[] }> = [
  { label: 'Windows executable', prefix: [0x4d, 0x5a] }, // MZ
  { label: 'Linux executable', prefix: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  { label: 'macOS executable', prefix: [0xcf, 0xfa, 0xed, 0xfe] },
  { label: 'macOS executable', prefix: [0xce, 0xfa, 0xed, 0xfe] },
  { label: 'macOS universal binary', prefix: [0xca, 0xfe, 0xba, 0xbe] },
  { label: 'shell script', prefix: [0x23, 0x21] }, // #!
];

const extensionOf = (fileName: string): string => {
  const at = fileName.lastIndexOf('.');
  return at < 0 ? '' : fileName.slice(at).toLowerCase();
};

/**
 * Reduce a submitted name to something safe to store and safe to send back.
 *
 * The name reaches a `Content-Disposition` header and an inspector's
 * filesystem, so a path separator in it is a way to write somewhere else, and
 * a newline is a way to inject a second header. The storage key is generated
 * server-side regardless — this is defence for the places the name itself
 * travels.
 */
export function safeFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = [...base]
    /*
     * Control characters, quotes and separators, filtered by code point.
     *
     * A regex class spanning the control range reads as a typo and lints as
     * one. The name reaches a Content-Disposition header, so a newline in it
     * is a way to inject a second header, and a quote is a way to end the
     * filename early.
     */
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) return false;
      return !['"', "'", ';'].includes(ch);
    })
    .join('')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 200) || 'attachment';
}

export interface DeclaredFile {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Check what the client says about a file, before a single byte is accepted.
 *
 * Rejecting here means a 25 MB upload of something we will not keep never
 * starts, which matters on a site connection.
 */
export function validateDeclaration(file: DeclaredFile): { fileName: string } {
  const fileName = safeFileName(file.fileName);
  const extension = extensionOf(fileName);

  if (NEVER.has(extension)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `${extension} files cannot be attached.`, {
      fields: { fileName: 'Executable and script files are not accepted.' },
    });
  }

  const permitted = ALLOWED[file.mimeType];
  if (!permitted) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'That file type cannot be attached. Send a PDF, Word or Excel document, an image, a text file or a zip.',
      { fields: { mimeType: `${file.mimeType} is not accepted.` } },
    );
  }

  // The name must agree with the declared type: a `.exe` calling itself a PDF
  // fails here rather than at the magic-number check, with a clearer message.
  if (extension && !permitted.includes(extension)) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `A ${file.mimeType} file should not be named ${extension}.`,
      { fields: { fileName: 'The extension does not match the file type.' } },
    );
  }

  if (file.sizeBytes <= 0) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'That file is empty.', {
      fields: { sizeBytes: 'Must be greater than zero.' },
    });
  }
  if (file.sizeBytes > MAX_ATTACHMENT_BYTES) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      `Files must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller.`,
      { fields: { sizeBytes: 'Too large.' } },
    );
  }

  return { fileName };
}

/**
 * Check the bytes themselves once they have arrived.
 *
 * The declaration is the client's claim; this is the only thing that looks at
 * what was actually sent. Two questions, in order of severity: is this an
 * executable regardless of what it claims, and do the leading bytes match the
 * type it claims to be.
 */
export function validateContent(head: Buffer, mimeType: string): void {
  const startsWith = (prefix: number[]): boolean => prefix.every((byte, i) => head[i] === byte);

  for (const exe of EXECUTABLE_MAGIC) {
    if (startsWith(exe.prefix)) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `That file is a ${exe.label} and cannot be attached.`,
        { fields: { file: 'Executable content is never accepted.' } },
      );
    }
  }

  const expected = MAGIC.filter((m) => m.mime === mimeType);
  // Text has no signature worth checking; anything else we know we check.
  if (expected.length === 0) return;

  if (!expected.some((m) => startsWith(m.prefix))) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      'The file contents do not match the type it claims to be.',
      { fields: { file: 'Send the original file rather than a renamed one.' } },
    );
  }
}

/** The types a browser may be told to render inline. Everything else downloads. */
const INLINE_SAFE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

/**
 * How to serve a stored file back.
 *
 * Anything not on the inline list is sent as an attachment with
 * `application/octet-stream`, so a browser downloads it rather than running
 * it. A stored `.txt` that is really HTML is inert this way; served as
 * `text/html` on the API's own origin it would not be.
 */
export function dispositionFor(mimeType: string): { contentType: string; inline: boolean } {
  return INLINE_SAFE.has(mimeType)
    ? { contentType: mimeType, inline: true }
    : { contentType: 'application/octet-stream', inline: false };
}
