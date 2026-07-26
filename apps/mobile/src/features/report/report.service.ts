/**
 * Report generation, print, and share.
 *
 * Assembles the context from local SQLite only — no network. An inspector must
 * be able to hand a client a PDF from the back of a van with no signal, which
 * is the single most common reason field staff distrust "offline-capable" apps
 * that turn out not to be.
 */

import {
  type Attachment,
  type Inspection,
  type InspectionResponse,
  SignatureRole,
} from '@orbit/types';
import { safeFileName, scoreInspection, ulid } from '@orbit/utils';
import * as FileSystem from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import type { Runtime } from '../../runtime/runtime';
import { deserialiseSignature, signatureToSvg } from '../signature/SignaturePad';
import { buildReportHtml, type ReportContext } from './report.template';

const REPORT_DIR = `${FileSystem.documentDirectory}orbit-reports/`;

export interface ReportOptions {
  includePhotos?: boolean;
  includeMap?: boolean;
  includeSignatures?: boolean;
  failuresOnly?: boolean;
  /** Cap on embedded photos — a 60-photo report can exceed device memory. */
  maxPhotos?: number;
}

export interface GeneratedReport {
  uri: string;
  fileName: string;
  sizeBytes: number;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(REPORT_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(REPORT_DIR, { intermediates: true });
}

/** Read an image into a data URI for embedding. */
async function toDataUri(uri: string, mimeType: string): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    if (!info.exists) return null;

    // Base64 inflates by ~33% and the print engine holds the whole document in
    // memory. Skipping oversized images beats an out-of-memory crash that loses
    // the report entirely.
    if ('size' in info && info.size > 4 * 1024 * 1024) return null;

    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return `data:${mimeType};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * Build the report context from local data.
 *
 * Everything here is a synchronous SQLite read except the image loading, which
 * is bounded by `maxPhotos`.
 */
export async function buildContext(
  runtime: Runtime,
  inspectionId: string,
  options: ReportOptions = {},
): Promise<ReportContext | null> {
  const inspection = runtime.repositories.inspections.findById(inspectionId);
  if (!inspection) return null;

  const template = runtime.repositories.templates.findVersion(inspection.templateVersionId);
  if (!template) return null;

  const responses = runtime.repositories.responses.forInspection(inspectionId);
  const attachments = runtime.repositories.attachments.forInspection(inspectionId);
  const answers = runtime.repositories.responses.answerMap(inspectionId);

  const score = scoreInspection({
    sections: template.sections,
    answers,
    policy: template.scoring,
  });

  // --- related records, read straight from the local replica ---
  const org = runtime.db.getFirst<{ name: string; logo_url: string | null; settings: string }>(
    `SELECT name, logo_url, settings FROM organizations WHERE id = ? LIMIT 1`,
    [runtime.identity.orgId],
  );

  let settings: { reportFooterText?: string | null; brandColor?: string | null } = {};
  try {
    settings = org?.settings ? JSON.parse(org.settings) : {};
  } catch {
    settings = {};
  }

  const client = inspection.clientId
    ? runtime.db.getFirst<{ name: string; contact_name: string | null; address: string | null }>(
        `SELECT name, contact_name, address FROM clients WHERE id = ?`,
        [inspection.clientId],
      )
    : null;

  const site = inspection.siteId
    ? runtime.db.getFirst<{
        name: string;
        address: string | null;
        latitude: number | null;
        longitude: number | null;
      }>(`SELECT name, address, latitude, longitude FROM sites WHERE id = ?`, [inspection.siteId])
    : null;

  const inspector = runtime.db.getFirst<{ first_name: string; last_name: string; email: string }>(
    `SELECT first_name, last_name, email FROM users WHERE id = ?`,
    [inspection.assignedToId ?? runtime.identity.userId],
  );

  // --- signatures ---
  const signatureRows = runtime.db.getAll<{
    role: string;
    signer_name: string;
    signer_title: string | null;
    signed_at: string;
    strokes: string | null;
    declaration: string | null;
  }>(
    `SELECT role, signer_name, signer_title, signed_at, strokes, declaration
       FROM signatures WHERE inspection_id = ? AND deleted_at IS NULL`,
    [inspectionId],
  );

  const signatures = signatureRows.map((row) => {
    let svg: string | null = null;
    if (row.strokes) {
      try {
        const data = deserialiseSignature(JSON.parse(row.strokes));
        // Rendered from the original vectors at print time, so it is crisp at
        // any DPI rather than an upscaled bitmap.
        if (data) svg = signatureToSvg(data, { strokeWidth: 2 });
      } catch {
        svg = null;
      }
    }
    return {
      role: row.role,
      signerName: row.signer_name,
      signerTitle: row.signer_title,
      signedAt: row.signed_at,
      svg,
      declaration: row.declaration,
    };
  });

  // --- photos ---
  const photoDataUris: Record<string, string> = {};
  if (options.includePhotos !== false) {
    const limit = options.maxPhotos ?? 40;
    const photos = attachments.filter((a) => a.kind === 'PHOTO' && a.localUri).slice(0, limit);

    for (const photo of photos) {
      const dataUri = await toDataUri(photo.localUri!, photo.mimeType);
      if (dataUri) photoDataUris[photo.id] = dataUri;
    }
  }

  const logoDataUri = org?.logo_url?.startsWith('file://')
    ? await toDataUri(org.logo_url, 'image/png')
    : null;

  return {
    inspection: inspection as Inspection,
    sections: template.sections,
    responses: responses as InspectionResponse[],
    attachments: attachments as Attachment[],
    score,
    organisation: {
      name: org?.name ?? 'Organisation',
      logoDataUri,
      footerText: settings.reportFooterText ?? null,
      brandColor: settings.brandColor ?? null,
    },
    client: client
      ? { name: client.name, contactName: client.contact_name, address: client.address }
      : null,
    site: site
      ? {
          name: site.name,
          address: site.address,
          latitude: site.latitude,
          longitude: site.longitude,
        }
      : null,
    inspector: {
      name: inspector ? `${inspector.first_name} ${inspector.last_name}` : 'Unknown',
      email: inspector?.email ?? '',
      registrationNumber: null,
    },
    signatures,
    photoDataUris,
    templateName: template.name,
    templateVersion: template.version,
    options: {
      includePhotos: options.includePhotos !== false,
      includeMap: options.includeMap !== false,
      includeSignatures: options.includeSignatures !== false,
      failuresOnly: options.failuresOnly === true,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Generate the PDF to a permanent file and return its location. */
export async function generateReport(
  runtime: Runtime,
  inspectionId: string,
  options: ReportOptions = {},
): Promise<GeneratedReport> {
  const context = await buildContext(runtime, inspectionId, options);
  if (!context) {
    throw new Error('This inspection or its checklist is not available on this device.');
  }

  const html = buildReportHtml(context);
  const { uri } = await Print.printToFileAsync({ html, base64: false });

  await ensureDir();
  const fileName = safeFileName(`${context.inspection.number}-report.pdf`);
  const target = `${REPORT_DIR}${ulid()}-${fileName}`;

  // The print engine writes to a temporary location the OS may reclaim; move it
  // somewhere durable so the report survives until the user deletes it.
  await FileSystem.moveAsync({ from: uri, to: target });

  const info = await FileSystem.getInfoAsync(target, { size: true });

  return {
    uri: target,
    fileName,
    sizeBytes: info.exists && 'size' in info ? info.size : 0,
  };
}

/** Open the OS print dialog directly. */
export async function printReport(
  runtime: Runtime,
  inspectionId: string,
  options: ReportOptions = {},
): Promise<void> {
  const context = await buildContext(runtime, inspectionId, options);
  if (!context) throw new Error('This inspection is not available on this device.');
  await Print.printAsync({ html: buildReportHtml(context) });
}

/**
 * Share the PDF through the OS sheet.
 *
 * Covers email, messaging, AirDrop, and cloud storage in one action — building
 * a bespoke email composer would be worse in every case.
 */
export async function shareReport(report: GeneratedReport): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(report.uri, {
    mimeType: 'application/pdf',
    dialogTitle: report.fileName,
    UTI: 'com.adobe.pdf',
  });
}

/** Previously generated reports for an inspection. */
export async function listReports(): Promise<
  Array<{ uri: string; fileName: string; sizeBytes: number }>
> {
  try {
    await ensureDir();
    const files = await FileSystem.readDirectoryAsync(REPORT_DIR);
    const out: Array<{ uri: string; fileName: string; sizeBytes: number }> = [];
    for (const file of files) {
      const uri = `${REPORT_DIR}${file}`;
      const info = await FileSystem.getInfoAsync(uri, { size: true });
      if (info.exists) {
        out.push({
          uri,
          fileName: file.replace(/^[0-9A-Z]{26}-/, ''),
          sizeBytes: 'size' in info ? info.size : 0,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function deleteReport(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

export { REPORT_DIR, SignatureRole };
