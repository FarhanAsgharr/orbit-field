/**
 * PDF report generation.
 *
 * Built as HTML and rendered by `expo-print`, which uses the OS print engine.
 * That is what makes generation work fully offline — no server round trip, no
 * bundled PDF library, and page breaking handled natively.
 *
 * Everything embedded is a data URI. A report must remain readable years later
 * on a machine that has never heard of this API, so a remote image URL would be
 * a broken promise the first time someone opens an archived file.
 */

import type {
  Attachment,
  GeoPoint,
  Inspection,
  InspectionResponse,
  TemplateSection,
} from '@orbit/types';
import type { ScoreResult } from '@orbit/utils';
import { formatDateTime, gradeAccuracy, toDisplayString } from '@orbit/utils';

export interface ReportContext {
  inspection: Inspection;
  sections: TemplateSection[];
  responses: InspectionResponse[];
  attachments: Attachment[];
  score: ScoreResult | null;
  organisation: {
    name: string;
    logoDataUri: string | null;
    footerText: string | null;
    brandColor: string | null;
  };
  client: { name: string; contactName: string | null; address: string | null } | null;
  site: {
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
  inspector: { name: string; email: string; registrationNumber: string | null };
  signatures: Array<{
    role: string;
    signerName: string;
    signerTitle: string | null;
    signedAt: string;
    svg: string | null;
    declaration: string | null;
  }>;
  /** Photos already read into data URIs, keyed by attachment id. */
  photoDataUris: Record<string, string>;
  templateName: string;
  templateVersion: number;
  options: {
    includePhotos: boolean;
    includeMap: boolean;
    includeSignatures: boolean;
    failuresOnly: boolean;
  };
  generatedAt: string;
}

/** Escape for HTML text nodes. Never interpolate user data without this. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return toDisplayString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render an answer for print. */
function renderAnswer(
  response: InspectionResponse | undefined,
  section: TemplateSection,
  fieldId: string,
): string {
  if (
    !response ||
    response.value === null ||
    response.value === undefined ||
    response.value === ''
  ) {
    return '<span class="empty">Not answered</span>';
  }

  const field = section.fields.find((f) => f.id === fieldId);
  const value = response.value;

  if (Array.isArray(value)) {
    const labels = value.map((v) => {
      const option = field?.options.find((o) => o.value === toDisplayString(v));
      return esc(option?.label ?? v);
    });
    return labels.join(', ');
  }

  if (typeof value === 'object' && value !== null && 'latitude' in value) {
    const point = value as unknown as GeoPoint;
    const accuracy = point.accuracy !== null ? ` (±${Math.round(point.accuracy)} m)` : '';
    return `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}${esc(accuracy)}`;
  }

  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  const option = field?.options.find((o) => o.value === toDisplayString(value));
  return esc(option?.label ?? value);
}

function outcomeClass(response: InspectionResponse | undefined): string {
  if (!response) return '';
  if (response.isFailure) return 'fail';
  if (response.isNotApplicable) return 'na';
  return 'pass';
}

/**
 * A static map is deliberately not fetched.
 *
 * Every static-map provider requires a network call and an API key, which would
 * make report generation fail exactly when it is needed most — offline, on site.
 * Coordinates are printed precisely instead, with accuracy, which is what an
 * auditor actually needs.
 */
function renderLocationBlock(point: GeoPoint | null, label: string): string {
  if (!point) return '';
  const grade = gradeAccuracy(point.accuracy);
  return `
    <div class="geo">
      <div class="geo-label">${esc(label)}</div>
      <div class="geo-coords">${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}</div>
      <div class="geo-meta">
        Accuracy ${point.accuracy !== null ? `±${Math.round(point.accuracy)} m (${esc(grade.toLowerCase())})` : 'unknown'}
        ${point.altitude !== null ? ` · Altitude ${Math.round(point.altitude)} m` : ''}
        · ${esc(formatDateTime(point.capturedAt))}
      </div>
    </div>`;
}

export function buildReportHtml(ctx: ReportContext): string {
  const accent = ctx.organisation.brandColor ?? '#1B5CF0';
  const { inspection, score } = ctx;

  const responseByField = new Map<string, InspectionResponse>();
  for (const response of ctx.responses) {
    responseByField.set(`${response.fieldId}#${response.repeatIndex}`, response);
  }

  const attachmentsByResponse = new Map<string, Attachment[]>();
  for (const attachment of ctx.attachments) {
    if (!attachment.responseId) continue;
    const list = attachmentsByResponse.get(attachment.responseId) ?? [];
    list.push(attachment);
    attachmentsByResponse.set(attachment.responseId, list);
  }

  const sectionsHtml = ctx.sections
    .map((section) => {
      const rows = section.fields
        .flatMap(function expand(field): typeof section.fields {
          return [field, ...field.followUps.flatMap(expand)];
        })
        .filter((field) => field.type !== 'INSTRUCTION')
        .map((field) => {
          const response = responseByField.get(`${field.id}#0`);

          // A failures-only report still has to show unanswered questions —
          // silence is itself a finding.
          if (ctx.options.failuresOnly && response && !response.isFailure) return '';

          const photos =
            ctx.options.includePhotos && response
              ? (attachmentsByResponse.get(response.id) ?? [])
                  .filter((a) => ctx.photoDataUris[a.id])
                  .map(
                    (a) => `
                      <figure class="photo">
                        <img src="${ctx.photoDataUris[a.id]}" alt="${esc(a.fileName)}" />
                        <figcaption>
                          ${esc(a.caption ?? '')}
                          ${a.location ? `<br/>${a.location.latitude.toFixed(5)}, ${a.location.longitude.toFixed(5)}` : ''}
                          ${a.capturedAt ? `<br/>${esc(formatDateTime(a.capturedAt))}` : ''}
                        </figcaption>
                      </figure>`,
                  )
                  .join('')
              : '';

          return `
            <tr class="${outcomeClass(response)}">
              <td class="q">
                ${esc(field.label)}
                ${field.isCritical ? '<span class="critical">CRITICAL</span>' : ''}
              </td>
              <td class="a">
                ${renderAnswer(response, section, field.id)}
                ${response?.comment ? `<div class="comment">${esc(response.comment)}</div>` : ''}
                ${photos ? `<div class="photos">${photos}</div>` : ''}
              </td>
            </tr>`;
        })
        .join('');

      if (!rows.trim()) return '';

      return `
        <section class="section">
          <h2>${esc(section.title)}</h2>
          ${section.description ? `<p class="section-desc">${esc(section.description)}</p>` : ''}
          <table class="answers">
            <tbody>${rows}</tbody>
          </table>
        </section>`;
    })
    .join('');

  const signaturesHtml =
    ctx.options.includeSignatures && ctx.signatures.length > 0
      ? `
        <section class="section signatures">
          <h2>Signatures</h2>
          <div class="sig-grid">
            ${ctx.signatures
              .map(
                (sig) => `
                  <div class="sig">
                    <div class="sig-canvas">${sig.svg ?? '<span class="empty">Signature not available</span>'}</div>
                    <div class="sig-name">${esc(sig.signerName)}</div>
                    <div class="sig-meta">
                      ${esc(sig.role)}${sig.signerTitle ? ` · ${esc(sig.signerTitle)}` : ''}<br/>
                      ${esc(formatDateTime(sig.signedAt))}
                    </div>
                    ${sig.declaration ? `<div class="sig-decl">${esc(sig.declaration)}</div>` : ''}
                  </div>`,
              )
              .join('')}
          </div>
        </section>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(inspection.number)} — ${esc(inspection.title)}</title>
<style>
  /* Print geometry. The running header/footer use paged-media counters so page
     numbers work without JavaScript, which the print engine does not run. */
  @page {
    size: A4;
    margin: 18mm 14mm 20mm 14mm;
    @bottom-center {
      content: "Page " counter(page) " of " counter(pages);
      font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
      font-size: 8pt;
      color: #6B7C9B;
    }
  }

  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.45;
    color: #111726;
    margin: 0;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 3px solid ${accent};
    padding-bottom: 10pt;
    margin-bottom: 14pt;
  }
  .logo { max-height: 46pt; max-width: 150pt; }
  .org-name { font-size: 15pt; font-weight: 700; color: ${accent}; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 15pt; margin: 0 0 2pt; }
  .doc-ref { font-family: 'Courier New', monospace; font-size: 10pt; color: #33405A; }

  .verdict {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10pt 14pt; border-radius: 6pt; margin-bottom: 14pt;
    border: 1pt solid #C3CDDC;
  }
  .verdict.pass { background: #D8F3E8; border-color: #0E8A5F; }
  .verdict.fail { background: #FCE3DD; border-color: #C2371F; }
  .verdict.observations { background: #FDEED6; border-color: #B26A00; }
  .verdict-label { font-size: 16pt; font-weight: 700; }
  .verdict-score { font-size: 26pt; font-weight: 700; }

  .meta-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 8pt 18pt;
    margin-bottom: 14pt;
  }
  .meta-block { border: 1pt solid #E2E8F0; border-radius: 5pt; padding: 8pt 10pt; }
  .meta-block h3 {
    margin: 0 0 5pt; font-size: 7.5pt; text-transform: uppercase;
    letter-spacing: 0.06em; color: #6B7C9B;
  }
  .meta-row { display: flex; justify-content: space-between; gap: 10pt; padding: 1.5pt 0; }
  .meta-key { color: #4A5A78; }
  .meta-val { font-weight: 600; text-align: right; }

  .section { margin-bottom: 14pt; break-inside: avoid-page; }
  .section h2 {
    font-size: 11.5pt; margin: 0 0 6pt; padding-bottom: 3pt;
    border-bottom: 1pt solid #E2E8F0; color: ${accent};
  }
  .section-desc { color: #4A5A78; margin: 0 0 6pt; font-size: 9pt; }

  table.answers { width: 100%; border-collapse: collapse; }
  table.answers td {
    border-bottom: 0.5pt solid #E2E8F0; padding: 5pt 6pt; vertical-align: top;
  }
  td.q { width: 46%; color: #232C3D; }
  td.a { font-weight: 600; }
  /* A left rule carries pass/fail, so the verdict survives greyscale printing —
     which is how most of these are actually filed. */
  tr.fail td.q { border-left: 3pt solid #C2371F; padding-left: 6pt; }
  tr.pass td.q { border-left: 3pt solid #0E8A5F; padding-left: 6pt; }
  tr.na   td.q { border-left: 3pt solid #94A3BC; padding-left: 6pt; }
  tr.fail td.a { color: #C2371F; }

  .critical {
    display: inline-block; margin-left: 5pt; padding: 1pt 4pt;
    background: #C2371F; color: #fff; font-size: 6.5pt; border-radius: 2pt;
    letter-spacing: 0.05em;
  }
  .comment {
    font-weight: 400; color: #4A5A78; font-size: 9pt;
    margin-top: 3pt; padding-left: 6pt; border-left: 2pt solid #E2E8F0;
  }
  .empty { color: #94A3BC; font-style: italic; font-weight: 400; }

  .photos { display: flex; flex-wrap: wrap; gap: 6pt; margin-top: 6pt; }
  figure.photo { margin: 0; width: 128pt; break-inside: avoid; }
  figure.photo img {
    width: 100%; height: 96pt; object-fit: cover;
    border: 1pt solid #C3CDDC; border-radius: 3pt;
  }
  figure.photo figcaption {
    font-size: 6.5pt; color: #4A5A78; margin-top: 2pt; line-height: 1.3;
  }

  .geo { border: 1pt solid #E2E8F0; border-radius: 5pt; padding: 7pt 9pt; margin-bottom: 7pt; }
  .geo-label { font-size: 7.5pt; text-transform: uppercase; color: #6B7C9B; letter-spacing: 0.06em; }
  .geo-coords { font-family: 'Courier New', monospace; font-size: 11pt; font-weight: 700; }
  .geo-meta { font-size: 8pt; color: #4A5A78; }

  .sig-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12pt; }
  .sig { break-inside: avoid; }
  .sig-canvas {
    height: 62pt; border-bottom: 1pt solid #33405A; margin-bottom: 4pt;
    display: flex; align-items: flex-end; justify-content: center;
  }
  .sig-canvas svg { max-height: 60pt; max-width: 100%; }
  .sig-name { font-weight: 700; }
  .sig-meta { font-size: 8pt; color: #4A5A78; }
  .sig-decl { font-size: 7.5pt; color: #6B7C9B; margin-top: 3pt; font-style: italic; }

  .footer {
    margin-top: 18pt; padding-top: 8pt; border-top: 1pt solid #E2E8F0;
    font-size: 7.5pt; color: #6B7C9B; display: flex; justify-content: space-between;
  }
</style>
</head>
<body>

<div class="header">
  <div>
    ${
      ctx.organisation.logoDataUri
        ? `<img class="logo" src="${ctx.organisation.logoDataUri}" alt="${esc(ctx.organisation.name)}"/>`
        : `<div class="org-name">${esc(ctx.organisation.name)}</div>`
    }
  </div>
  <div class="doc-title">
    <h1>Inspection Report</h1>
    <div class="doc-ref">${esc(inspection.number)}</div>
  </div>
</div>

<div class="verdict ${
    inspection.outcome === 'FAIL'
      ? 'fail'
      : inspection.outcome === 'PASS_WITH_OBSERVATIONS'
        ? 'observations'
        : inspection.outcome === 'PASS'
          ? 'pass'
          : ''
  }">
  <div>
    <div class="verdict-label">${esc(inspection.outcome.replace(/_/g, ' '))}</div>
    <div style="font-size:8.5pt;color:#33405A;">
      ${score ? `${score.answeredFields} of ${score.totalFields} questions answered` : ''}
      ${score && score.failedFields > 0 ? ` · ${score.failedFields} failed` : ''}
      ${score && score.criticalFailures > 0 ? ` · ${score.criticalFailures} critical` : ''}
    </div>
  </div>
  <div class="verdict-score">${score?.percentage !== null && score?.percentage !== undefined ? `${Math.round(score.percentage)}%` : '—'}</div>
</div>

<div class="meta-grid">
  <div class="meta-block">
    <h3>Inspection</h3>
    <div class="meta-row"><span class="meta-key">Title</span><span class="meta-val">${esc(inspection.title)}</span></div>
    <div class="meta-row"><span class="meta-key">Checklist</span><span class="meta-val">${esc(ctx.templateName)} v${ctx.templateVersion}</span></div>
    <div class="meta-row"><span class="meta-key">Status</span><span class="meta-val">${esc(inspection.status.replace(/_/g, ' '))}</span></div>
    <div class="meta-row"><span class="meta-key">Priority</span><span class="meta-val">${esc(inspection.priority)}</span></div>
    ${inspection.category ? `<div class="meta-row"><span class="meta-key">Category</span><span class="meta-val">${esc(inspection.category)}</span></div>` : ''}
    <div class="meta-row"><span class="meta-key">Started</span><span class="meta-val">${esc(formatDateTime(inspection.startedAt))}</span></div>
    <div class="meta-row"><span class="meta-key">Completed</span><span class="meta-val">${esc(formatDateTime(inspection.completedAt))}</span></div>
  </div>

  <div class="meta-block">
    <h3>Inspector</h3>
    <div class="meta-row"><span class="meta-key">Name</span><span class="meta-val">${esc(ctx.inspector.name)}</span></div>
    <div class="meta-row"><span class="meta-key">Email</span><span class="meta-val">${esc(ctx.inspector.email)}</span></div>
    ${
      ctx.inspector.registrationNumber
        ? `<div class="meta-row"><span class="meta-key">Registration</span><span class="meta-val">${esc(ctx.inspector.registrationNumber)}</span></div>`
        : ''
    }
  </div>

  ${
    ctx.client
      ? `<div class="meta-block">
         <h3>Client</h3>
         <div class="meta-row"><span class="meta-key">Name</span><span class="meta-val">${esc(ctx.client.name)}</span></div>
         ${ctx.client.contactName ? `<div class="meta-row"><span class="meta-key">Contact</span><span class="meta-val">${esc(ctx.client.contactName)}</span></div>` : ''}
         ${ctx.client.address ? `<div class="meta-row"><span class="meta-key">Address</span><span class="meta-val">${esc(ctx.client.address)}</span></div>` : ''}
       </div>`
      : ''
  }

  ${
    ctx.site
      ? `<div class="meta-block">
         <h3>Site</h3>
         <div class="meta-row"><span class="meta-key">Name</span><span class="meta-val">${esc(ctx.site.name)}</span></div>
         ${ctx.site.address ? `<div class="meta-row"><span class="meta-key">Address</span><span class="meta-val">${esc(ctx.site.address)}</span></div>` : ''}
       </div>`
      : ''
  }
</div>

${ctx.options.includeMap ? renderLocationBlock(inspection.startLocation, 'Location at start') : ''}
${ctx.options.includeMap ? renderLocationBlock(inspection.endLocation, 'Location at completion') : ''}

${sectionsHtml}

${
  inspection.notes
    ? `<section class="section">
       <h2>Notes</h2>
       <p>${esc(inspection.notes).replace(/\n/g, '<br/>')}</p>
     </section>`
    : ''
}

${
  score && score.failedFields > 0
    ? `<section class="section">
       <h2>Summary of findings</h2>
       <table class="answers"><tbody>
         ${score.fields
           .filter((f) => f.isFailure)
           .map(
             (f) => `<tr class="fail">
               <td class="q">${esc(f.label)}${f.isCritical ? '<span class="critical">CRITICAL</span>' : ''}</td>
               <td class="a">Failed</td>
             </tr>`,
           )
           .join('')}
       </tbody></table>
     </section>`
    : ''
}

${signaturesHtml}

<div class="footer">
  <span>${esc(ctx.organisation.footerText ?? ctx.organisation.name)}</span>
  <span>Generated ${esc(formatDateTime(ctx.generatedAt))} · ${esc(inspection.number)}</span>
</div>

</body>
</html>`;
}
