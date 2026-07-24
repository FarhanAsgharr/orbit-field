/**
 * Excel export engine.
 *
 * Excel is what compliance teams actually forward to clients and auditors, so
 * the output has to survive being opened by somebody who did not generate it:
 * frozen headers, auto-filters, real date and number types rather than strings,
 * and column widths that do not need adjusting before the file is readable.
 *
 * Everything writes through one `buildSheet` helper so a new export cannot
 * accidentally ship without those properties.
 */

import ExcelJS from 'exceljs';

/** Orbit brand blue, matching the console and the field app. */
const BRAND = 'FF1B5CF0';
const HEADER_TEXT = 'FFFFFFFF';
const ZEBRA = 'FFF5F7FB';
const BORDER = 'FFDFE6F0';

export type CellFormat = 'text' | 'number' | 'integer' | 'percent' | 'money' | 'date' | 'datetime' | 'duration';

export interface SheetColumn<T> {
  header: string;
  /** Value extractor. Return a real Date or number where the format expects one. */
  value: (row: T) => string | number | Date | null | undefined;
  format?: CellFormat;
  width?: number;
  /** Applies a red/amber/green fill based on the raw value. */
  signal?: (row: T) => 'ok' | 'warn' | 'danger' | null;
}

export interface SheetSpec<T> {
  name: string;
  columns: Array<SheetColumn<T>>;
  rows: T[];
  /** Rendered above the table as context for whoever opens the file. */
  subtitle?: string;
  /** Adds a totals row with SUM over the named numeric columns. */
  totals?: string[];
}

export interface WorkbookMeta {
  organisation: string;
  title: string;
  generatedBy: string;
  generatedAt: Date;
  /** Reporting window, when the export covers one. */
  from?: Date;
  to?: Date;
}

/** Excel number formats per semantic type. */
const NUMBER_FORMAT: Record<CellFormat, string | undefined> = {
  text: undefined,
  number: '#,##0.00',
  integer: '#,##0',
  percent: '0.0"%"',
  money: '#,##0.00',
  // ISO-ish and unambiguous: an exported file crosses locales, and 03/04/2026
  // means two different days depending on who opens it.
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  duration: '[h]:mm',
};

const SIGNAL_FILL: Record<'ok' | 'warn' | 'danger', string> = {
  ok: 'FFDCF3E9',
  warn: 'FFFDEED6',
  danger: 'FFFCE3DD',
};

function applyBorder(cell: ExcelJS.Cell): void {
  cell.border = {
    top: { style: 'thin', color: { argb: BORDER } },
    left: { style: 'thin', color: { argb: BORDER } },
    bottom: { style: 'thin', color: { argb: BORDER } },
    right: { style: 'thin', color: { argb: BORDER } },
  };
}

/**
 * Render one worksheet.
 *
 * The header block occupies the first rows, so the table header lands on a
 * predictable row and the freeze pane can be set without counting.
 */
function buildSheet<T>(workbook: ExcelJS.Workbook, spec: SheetSpec<T>, meta: WorkbookMeta): void {
  // Excel rejects sheet names over 31 chars or containing []:*?/\ — a client
  // name in a sheet title will eventually hit both.
  const safeName = spec.name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31);
  const sheet = workbook.addWorksheet(safeName, {
    views: [{ state: 'frozen', ySplit: 4 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const columnCount = Math.max(1, spec.columns.length);

  // --- branding block ---
  sheet.mergeCells(1, 1, 1, columnCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `${meta.organisation} — ${spec.name}`;
  titleCell.font = { size: 14, bold: true, color: { argb: 'FF0B1220' } };
  sheet.getRow(1).height = 22;

  sheet.mergeCells(2, 1, 2, columnCount);
  const contextCell = sheet.getCell(2, 1);
  const window =
    meta.from && meta.to
      ? `${meta.from.toISOString().slice(0, 10)} to ${meta.to.toISOString().slice(0, 10)}`
      : null;
  contextCell.value = [
    spec.subtitle,
    window ? `Period: ${window}` : null,
    `Generated ${meta.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} by ${meta.generatedBy}`,
  ]
    .filter(Boolean)
    .join('   ·   ');
  contextCell.font = { size: 9, color: { argb: 'FF6B7A94' } };

  // Row 3 stays blank as a visual gutter; row 4 is the header.
  const headerRow = sheet.getRow(4);
  spec.columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, size: 10 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    applyBorder(cell);
  });
  headerRow.height = 20;

  // --- data ---
  spec.rows.forEach((row, rowIndex) => {
    const excelRow = sheet.getRow(5 + rowIndex);

    spec.columns.forEach((column, columnIndex) => {
      const cell = excelRow.getCell(columnIndex + 1);
      const raw = column.value(row);

      // Written as native types, not strings. A date exported as text cannot be
      // sorted or filtered by date in Excel, which is the first thing anyone
      // receiving the file tries to do.
      cell.value = raw ?? null;

      const format = column.format ?? 'text';
      const numberFormat = NUMBER_FORMAT[format];
      if (numberFormat) cell.numFmt = numberFormat;
      if (format !== 'text' && format !== 'date' && format !== 'datetime') {
        cell.alignment = { horizontal: 'right' };
      }

      const signal = column.signal?.(row) ?? null;
      if (signal) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SIGNAL_FILL[signal] } };
      } else if (rowIndex % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
      }

      cell.font = { size: 10 };
      applyBorder(cell);
    });
  });

  // --- totals ---
  if (spec.totals?.length && spec.rows.length > 0) {
    const totalRow = sheet.getRow(5 + spec.rows.length);
    totalRow.getCell(1).value = 'Total';
    totalRow.getCell(1).font = { bold: true, size: 10 };

    spec.columns.forEach((column, index) => {
      if (!spec.totals!.includes(column.header)) return;
      const letter = sheet.getColumn(index + 1).letter;
      const cell = totalRow.getCell(index + 1);
      // A formula rather than a computed value: the recipient can filter the
      // table and watch the total follow, which is the point of a spreadsheet.
      cell.value = { formula: `SUBTOTAL(109,${letter}5:${letter}${4 + spec.rows.length})` };
      cell.font = { bold: true, size: 10 };
      const totalFormat = NUMBER_FORMAT[column.format ?? 'number'];
      if (totalFormat) cell.numFmt = totalFormat;
      applyBorder(cell);
    });
  }

  // --- filters and widths ---
  if (spec.rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: 4 + spec.rows.length, column: columnCount },
    };
  }

  spec.columns.forEach((column, index) => {
    if (column.width) {
      sheet.getColumn(index + 1).width = column.width;
      return;
    }
    // Width from content, bounded: an unbounded auto-width turns a notes column
    // into a 400-character-wide sheet nobody can read.
    const sample = spec.rows.slice(0, 200).map((row) => String(column.value(row) ?? ''));
    const longest = Math.max(column.header.length, ...sample.map((v) => v.length), 8);
    sheet.getColumn(index + 1).width = Math.min(48, longest + 3);
  });
}

/**
 * A sheet whose row type has been sealed in.
 *
 * A workbook holds sheets of different row types, which TypeScript cannot
 * express directly. Closing over the spec keeps each sheet fully typed at the
 * point of construction while letting the workbook hold a heterogeneous list —
 * casting through `never` would surrender the type checking that catches a
 * column reading a field its row does not have.
 */
export interface PreparedSheet {
  name: string;
  render: (workbook: ExcelJS.Workbook, meta: WorkbookMeta) => void;
}

export function sheet<T>(spec: SheetSpec<T>): PreparedSheet {
  return {
    name: spec.name,
    render: (workbook, meta) => buildSheet(workbook, spec, meta),
  };
}

/** Build a multi-sheet workbook and return it as a buffer. */
export async function buildWorkbook(
  meta: WorkbookMeta,
  sheets: PreparedSheet[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  workbook.creator = 'Orbit Field';
  workbook.company = meta.organisation;
  workbook.title = meta.title;
  workbook.created = meta.generatedAt;
  workbook.modified = meta.generatedAt;

  for (const prepared of sheets) {
    prepared.render(workbook, meta);
  }

  // ExcelJS types this as ArrayBuffer-ish; Express needs a real Buffer.
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Single-sheet convenience wrapper. */
export async function buildSingleSheetWorkbook<T>(
  meta: WorkbookMeta,
  spec: SheetSpec<T>,
): Promise<Buffer> {
  return buildWorkbook(meta, [sheet(spec)]);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC-4180 CSV with formula-injection neutralised.
 *
 * A cell beginning `=`, `+`, `-`, or `@` is executed as a formula by Excel and
 * Sheets. Since inspection notes are attacker-influenced free text, every such
 * cell is prefixed so it lands as literal text.
 */
export function toCsv<T>(columns: Array<SheetColumn<T>>, rows: T[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text =
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'number'
          ? String(value)
          : String(value);
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(c.value(row))).join(','));
  }
  // BOM so Excel opens UTF-8 correctly instead of mangling accented names.
  return `﻿${lines.join('\r\n')}`;
}

export { ExcelJS };
