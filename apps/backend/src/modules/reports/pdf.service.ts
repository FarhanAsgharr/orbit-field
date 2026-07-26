/**
 * Server-side PDF generation.
 *
 * Distinct from the mobile PDF engine and deliberately so. The device renders a
 * single inspection offline through the OS print stack, because an inspector in
 * a van with no signal must be able to hand a client a report. This renders
 * *aggregate* reports — a month across a portfolio, an inspector scorecard, a
 * client summary — which need data no single device holds.
 *
 * PDFKit rather than headless Chrome: a browser in the API container triples
 * the image size and adds a class of crash that is hard to diagnose in
 * production, for output that is tabular and does not need a layout engine.
 */

import { toDisplayString } from '@orbit/utils';
import PDFDocument from 'pdfkit';

import type { SheetColumn } from './excel.service.js';

const BRAND = '#1B5CF0';
const INK = '#0B1220';
const MUTED = '#6B7A94';
const LINE = '#DFE6F0';
const OK = '#0E8A5F';
const WARN = '#B26A00';
const DANGER = '#C2371F';

export interface PdfMeta {
  organisation: string;
  title: string;
  subtitle?: string;
  generatedBy: string;
  generatedAt: Date;
  from?: Date;
  to?: Date;
  footerText?: string | null;
}

export interface PdfSection<T> {
  heading: string;
  description?: string;
  columns: Array<SheetColumn<T>>;
  rows: T[];
  /** Rendered as a row of large figures above the table. */
  highlights?: Array<{ label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }>;
}

const PAGE_MARGIN = 40;

function formatCell(value: unknown, format: SheetColumn<never>['format']): string {
  if (value === null || value === undefined || value === '') return '—';
  if (value instanceof Date) {
    return format === 'date'
      ? value.toISOString().slice(0, 10)
      : value.toISOString().slice(0, 16).replace('T', ' ');
  }
  if (typeof value === 'number') {
    if (format === 'percent') return `${value.toFixed(1)}%`;
    if (format === 'integer') return value.toLocaleString('en-GB');
    return value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return toDisplayString(value);
}

/**
 * Render a multi-section PDF report.
 *
 * Resolves to a Buffer rather than streaming to the response: reports are
 * bounded (the datasets cap rows), and buffering means a mid-render failure
 * produces a clean 500 instead of a truncated file the client has already
 * started downloading.
 */
export interface PreparedSection {
  heading: string;
  description?: string;
  highlights?: PdfSection<never>['highlights'];
  /** Row count, needed before the section is rendered. */
  rowCount: number;
  render: (draw: SectionRenderer) => void;
}

/** Callbacks a prepared section uses to emit itself. */
export interface SectionRenderer {
  table: <T>(columns: Array<SheetColumn<T>>, rows: T[]) => void;
}

export function section<T>(spec: PdfSection<T>): PreparedSection {
  return {
    heading: spec.heading,
    description: spec.description,
    highlights: spec.highlights,
    rowCount: spec.rows.length,
    render: (draw) => draw.table(spec.columns, spec.rows),
  };
}

export async function buildPdfReport(meta: PdfMeta, sections: PreparedSection[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: meta.title,
        Author: meta.organisation,
        Creator: 'Orbit Field',
        CreationDate: meta.generatedAt,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;

    // --- cover block ---
    doc.fillColor(BRAND).fontSize(20).font('Helvetica-Bold').text(meta.organisation);
    doc.fillColor(INK).fontSize(15).text(meta.title, { continued: false });

    if (meta.subtitle) {
      doc.moveDown(0.2);
      doc.fillColor(MUTED).fontSize(10).font('Helvetica').text(meta.subtitle);
    }

    doc.moveDown(0.4);
    const window =
      meta.from && meta.to
        ? `${meta.from.toISOString().slice(0, 10)} to ${meta.to.toISOString().slice(0, 10)}`
        : null;
    doc
      .fillColor(MUTED)
      .fontSize(8.5)
      .text(
        [
          window ? `Period: ${window}` : null,
          `Generated ${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          `By ${meta.generatedBy}`,
        ]
          .filter(Boolean)
          .join('   ·   '),
      );

    doc.moveDown(0.6);
    doc
      .strokeColor(BRAND)
      .lineWidth(2)
      .moveTo(PAGE_MARGIN, doc.y)
      .lineTo(PAGE_MARGIN + contentWidth, doc.y)
      .stroke();
    doc.moveDown(0.8);

    // --- sections ---
    for (const [index, section] of sections.entries()) {
      if (index > 0) {
        doc.addPage();
      }

      doc.fillColor(INK).fontSize(13).font('Helvetica-Bold').text(section.heading);
      if (section.description) {
        doc.fillColor(MUTED).fontSize(9).font('Helvetica').text(section.description);
      }
      doc.moveDown(0.5);

      // --- highlights ---
      if (section.highlights?.length) {
        const boxWidth = contentWidth / section.highlights.length;
        const top = doc.y;

        section.highlights.forEach((highlight, i) => {
          const x = PAGE_MARGIN + i * boxWidth;
          const colour =
            highlight.tone === 'ok'
              ? OK
              : highlight.tone === 'warn'
                ? WARN
                : highlight.tone === 'danger'
                  ? DANGER
                  : INK;

          doc
            .fillColor(colour)
            .fontSize(19)
            .font('Helvetica-Bold')
            .text(highlight.value, x, top, { width: boxWidth - 8 });
          doc
            .fillColor(MUTED)
            .fontSize(7.5)
            .font('Helvetica')
            .text(highlight.label.toUpperCase(), x, top + 22, {
              width: boxWidth - 8,
              characterSpacing: 0.6,
            });
        });

        doc.y = top + 42;
        doc.moveDown(0.4);
      }

      if (section.rowCount === 0) {
        doc
          .fillColor(MUTED)
          .fontSize(10)
          .font('Helvetica-Oblique')
          .text('No records in this period.');
        continue;
      }

      // --- table ---
      section.render({
        table: <R>(tableColumns: Array<SheetColumn<R>>, tableRows: R[]) => {
          drawTable(tableColumns, tableRows);
        },
      });
    }

    finalise();
    doc.end();

    /** Renders one table, handling page breaks and header repetition. */
    function drawTable<R>(sectionColumns: Array<SheetColumn<R>>, sectionRows: R[]): void {
      // Column widths proportional to declared Excel widths, so the two
      // formats put the same emphasis on the same columns.
      const totalWeight = sectionColumns.reduce((sum, c) => sum + (c.width ?? 14), 0);
      const widths = sectionColumns.map((c) => ((c.width ?? 14) / totalWeight) * contentWidth);

      const drawHeader = (): void => {
        const y = doc.y;
        doc.rect(PAGE_MARGIN, y, contentWidth, 18).fill(BRAND);
        doc.fillColor('#FFFFFF').fontSize(7.5).font('Helvetica-Bold');

        let x = PAGE_MARGIN;
        sectionColumns.forEach((column, i) => {
          doc.text(column.header, x + 4, y + 5.5, {
            width: widths[i]! - 8,
            ellipsis: true,
            lineBreak: false,
          });
          x += widths[i]!;
        });
        doc.y = y + 18;
      };

      drawHeader();

      doc.font('Helvetica').fontSize(7.5);

      for (const [rowIndex, row] of sectionRows.entries()) {
        // Page break before the row is drawn, and the header is redrawn on the
        // new page — a table continuing across pages without headers is
        // unreadable in a printed report.
        if (doc.y + 16 > doc.page.height - PAGE_MARGIN - 20) {
          doc.addPage();
          drawHeader();
          doc.font('Helvetica').fontSize(7.5);
        }

        const y = doc.y;

        if (rowIndex % 2 === 1) {
          doc.rect(PAGE_MARGIN, y, contentWidth, 14).fill('#F5F7FB');
        }

        let x = PAGE_MARGIN;
        sectionColumns.forEach((column, i) => {
          const signal = column.signal?.(row) ?? null;
          doc.fillColor(
            signal === 'danger' ? DANGER : signal === 'warn' ? WARN : signal === 'ok' ? OK : INK,
          );
          doc.text(formatCell(column.value(row), column.format), x + 4, y + 3.5, {
            width: widths[i]! - 8,
            ellipsis: true,
            lineBreak: false,
          });
          x += widths[i]!;
        });

        doc
          .strokeColor(LINE)
          .lineWidth(0.5)
          .moveTo(PAGE_MARGIN, y + 14)
          .lineTo(PAGE_MARGIN + contentWidth, y + 14)
          .stroke();

        doc.y = y + 14;
      }
    }

    /** Page numbers, applied after layout so the total is known. */
    function finalise(): void {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.fillColor(MUTED).fontSize(7.5).font('Helvetica');
        doc.text(
          `${meta.footerText ?? meta.organisation}   ·   ${meta.title}`,
          PAGE_MARGIN,
          doc.page.height - 28,
          { width: contentWidth / 2, lineBreak: false },
        );
        doc.text(
          `Page ${i + 1} of ${range.count}`,
          PAGE_MARGIN + contentWidth / 2,
          doc.page.height - 28,
          { width: contentWidth / 2, align: 'right', lineBreak: false },
        );
      }
    }
  });
}
