import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parseSheet, templateXlsx, toCsv, toXlsx } from '../src/services/excel.js';

test('CSV import keeps codes and phone numbers exactly as typed', async () => {
  const csv = '﻿Item Name*,Item Code,HSN,Phone,Sale Price\nAssam Tea 1kg,00123,0902,02212345678,0450.00\nNotebook,1e3,4820,  ,60\n';
  const rows = await parseSheet(Buffer.from(csv), 'items.csv');
  assert.deepEqual(rows[0], { 'Item Name*': 'Assam Tea 1kg', 'Item Code': '00123', HSN: '0902', Phone: '02212345678', 'Sale Price': '0450.00' });
  assert.equal(rows[1]['Item Code'], '1e3');
  assert.equal(rows[1].Phone, '');
});

test('CSV export reads back through the import: quotes, commas, line breaks and Hindi text', async () => {
  const columns = [{ key: 'name', label: 'Party Name*' }, { key: 'notes', label: 'Notes' }, { key: 'balance', label: 'Opening Balance', type: 'money' as const }];
  const csv = toCsv(columns, [
    { name: 'Mehta "Electronics"', notes: 'Shop 4, MG Road\nPune', balance: 12500 },
    { name: 'रमेश किराना', notes: '', balance: -300.5 },
  ]);
  const rows = await parseSheet(Buffer.from(csv), 'parties.csv');
  assert.deepEqual(rows, [
    { 'Party Name*': 'Mehta "Electronics"', Notes: 'Shop 4, MG Road\nPune', 'Opening Balance': '12500' },
    { 'Party Name*': 'रमेश किराना', Notes: '', 'Opening Balance': '-300.5' },
  ]);
});

test('import templates format code columns as text and read back as sample rows', async () => {
  const buf = await templateXlsx('Items', ['Item Name*', 'HSN', 'Sale Price'], [['Assam Tea 1kg', '0902', 450]], ['HSN']);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  assert.equal(ws.getColumn(2).numFmt, '@');
  assert.notEqual(ws.getColumn(3).numFmt, '@');
  assert.deepEqual(await parseSheet(buf, 'items-import-template.xlsx'), [{ 'Item Name*': 'Assam Tea 1kg', HSN: '0902', 'Sale Price': '450' }]);
});

test('report Excel files carry the title, headers, number formats and totals', async () => {
  const buf = await toXlsx({
    title: 'Sale Report',
    subtitle: '01/10/2026 to 31/10/2026',
    columns: [{ key: 'no', label: 'Invoice No' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'amount', label: 'Amount', type: 'money' }],
    rows: [{ no: 'INV-1', date: new Date('2026-10-05T00:00:00Z'), amount: 1180 }, { no: 'INV-2', date: '2026-10-06', amount: 590.5 }],
    totals: { amount: 1770.5 },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Sale Report');
  assert.equal(ws.getCell('A1').value, 'Sale Report');
  assert.equal(ws.getCell('A2').value, '01/10/2026 to 31/10/2026');
  assert.deepEqual([ws.getCell('A4').value, ws.getCell('B4').value, ws.getCell('C4').value], ['Invoice No', 'Date', 'Amount']);
  assert.equal(ws.getCell('C5').value, 1180);
  assert.equal(ws.getCell('C5').numFmt, '#,##0.00');
  assert.equal((ws.getCell('B6').value as Date).toISOString().slice(0, 10), '2026-10-06');
  assert.deepEqual([ws.getCell('A7').value, ws.getCell('C7').value], ['Total', 1770.5]);
});

// package.json overrides move exceljs's zip and CSV helpers to supported versions; this keeps its streaming API covered
test('large workbooks stream out and back in', async () => {
  const file = path.join(os.tmpdir(), `sumon-trade-excel-${process.pid}.xlsx`);
  try {
    const writer = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: true });
    const sheet = writer.addWorksheet('Items');
    for (let i = 1; i <= 3000; i++) sheet.addRow([i, `Item ${i}`, i * 1.5]).commit();
    await writer.commit();
    let count = 0;
    let last: unknown[] = [];
    for await (const ws of new ExcelJS.stream.xlsx.WorkbookReader(file, { sharedStrings: 'cache' })) {
      for await (const row of ws) {
        count++;
        last = row.values as unknown[];
      }
    }
    assert.equal(count, 3000);
    assert.deepEqual(last.slice(1), [3000, 'Item 3000', 4500]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
