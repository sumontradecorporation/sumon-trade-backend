import ExcelJS from 'exceljs';

export interface Column {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'money' | 'date' | 'percent';
  width?: number;
}

/** Builds a styled .xlsx workbook from report-style data. */
export async function toXlsx(opts: { title: string; subtitle?: string; columns: Column[]; rows: Record<string, unknown>[]; totals?: Record<string, unknown> }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sumon Trade ERP';
  wb.created = new Date();
  const ws = wb.addWorksheet(opts.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  const n = opts.columns.length;
  ws.mergeCells(1, 1, 1, Math.max(1, n));
  ws.getCell(1, 1).value = opts.title;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  let r = 2;
  if (opts.subtitle) {
    ws.mergeCells(2, 1, 2, Math.max(1, n));
    ws.getCell(2, 1).value = opts.subtitle;
    ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF555555' } };
    r = 3;
  }
  r += 1;
  const header = ws.getRow(r);
  opts.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    cell.alignment = { vertical: 'middle' };
    ws.getColumn(i + 1).width = c.width ?? (c.type === 'text' || !c.type ? 24 : 15);
    if (c.type === 'money') ws.getColumn(i + 1).numFmt = '#,##0.00';
    if (c.type === 'percent') ws.getColumn(i + 1).numFmt = '0.00"%"';
    if (c.type === 'date') ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
  });
  for (const row of opts.rows) {
    ws.addRow(opts.columns.map((c) => cellValue(row[c.key], c.type)));
  }
  if (opts.totals) {
    const tr = ws.addRow(opts.columns.map((c, i) => (i === 0 ? 'Total' : cellValue(opts.totals![c.key], c.type) ?? '')));
    tr.font = { bold: true };
    tr.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
  }
  ws.views = [{ state: 'frozen', ySplit: r }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellValue(v: unknown, type?: Column['type']) {
  if (v === null || v === undefined) return null;
  if (type === 'date') return v instanceof Date ? v : new Date(String(v));
  if (type === 'money' || type === 'number' || type === 'percent') return typeof v === 'number' ? v : Number(v) || 0;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export function toCsv(columns: Column[], rows: Record<string, unknown>[], totals?: Record<string, unknown>) {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(r[c.key])).join(','));
  if (totals) lines.push(columns.map((c, i) => esc(i === 0 ? 'Total' : totals[c.key])).join(','));
  return '﻿' + lines.join('\n');
}

/** Reads the first sheet of an .xlsx or .csv into objects keyed by the header row. */
export async function parseSheet(buffer: Buffer, filename: string): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) {
    const { Readable } = await import('node:stream');
    // Keep every value as typed: the default reader turns "0902" into 902 and "00123" into 123, losing
    // the leading zeros of HSN codes, item codes and phone numbers
    await wb.csv.read(Readable.from(buffer.toString('utf8').replace(/^﻿/, '')), { map: (value: string) => value });
  } else {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cell.text ?? '').trim();
  });
  const out: Record<string, string>[] = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const obj: Record<string, string> = {};
    let any = false;
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const h = headers[col];
      if (!h) return;
      const text = String(cell.text ?? '').trim();
      if (text) any = true;
      obj[h] = text;
    });
    if (any) out.push(obj);
  });
  return out;
}

/** An import template: bold headers, sample rows, and `textColumns` formatted as text so Excel keeps leading zeros. */
export async function templateXlsx(sheet: string, headers: string[], sample: (string | number)[][], textColumns: string[] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers).font = { bold: true };
  headers.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = 22;
    if (textColumns.includes(h)) col.numFmt = '@';
  });
  for (const s of sample) ws.addRow(s);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
