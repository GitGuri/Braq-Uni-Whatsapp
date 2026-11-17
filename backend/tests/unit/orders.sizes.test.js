import './_setup.js';
import { describe, test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { src, makeFakeDb, mockPool } from './_setup.js';

// sizes.service backs POST /api/orders/:id/sizes/upload and GET /api/orders/:id/sizes.
const db = makeFakeDb();
let svc, ExcelJS, HttpError;
before(async () => {
  mockPool(db);
  svc = await import(src('modules/orders/sizes.js'));
  ({ HttpError } = await import(src('core/errors.js')));
  ExcelJS = (await import('exceljs')).default;
});
beforeEach(() => db.reset());

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function xlsx(rows, { sheets = 1 } = {}) {
  const wb = new ExcelJS.Workbook();
  for (let s = 0; s < sheets; s++) {
    const ws = wb.addWorksheet(`S${s}`);
    if (s === 0) for (const r of rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const is400 = (e) => e instanceof HttpError && e.status === 400;

// ── CSV ───────────────────────────────────────────────────────────────────────
describe('parseSizeFile — CSV', () => {
  test('case-insensitive, whitespace-tolerant headers; trims values; empty notes → null', async () => {
    const csv = ' NAME , Size ,Notes\n  Ann Smith , M , long sleeves \nBob,XL,\n\n';
    const rows = await svc.parseSizeFile(Buffer.from(csv), 'text/csv');
    assert.deepEqual(rows, [
      { personName: 'Ann Smith', size: 'M', notes: 'long sleeves' },
      { personName: 'Bob', size: 'XL', notes: null },
    ]);
  });

  test('CSV detected by application/csv mimetype and by .csv filename', async () => {
    const buf = Buffer.from('name,size\nA,S\n');
    assert.equal((await svc.parseSizeFile(buf, 'application/csv')).length, 1);
    assert.equal((await svc.parseSizeFile(buf, 'application/vnd.ms-excel', 'roster.csv')).length, 1);
  });

  test('UTF-8 BOM (Excel "CSV UTF-8") and unicode names', async () => {
    const rows = await svc.parseSizeFile(Buffer.from('﻿Name,Size\nZoë Ñandú,2XL\n李雷,S\n'), 'text/csv');
    assert.deepEqual(rows.map((r) => r.personName), ['Zoë Ñandú', '李雷']);
  });

  test('rows missing name or size are skipped; notes column optional', async () => {
    const rows = await svc.parseSizeFile(Buffer.from('Name,Size\n,M\nCarl,\nDee,L\n'), 'text/csv');
    assert.deepEqual(rows, [{ personName: 'Dee', size: 'L', notes: null }]);
  });

  test('quoted fields with commas', async () => {
    const rows = await svc.parseSizeFile(Buffer.from('Name,Size,Notes\n"Smith, Ann",M,"wide, short"\n'), 'text/csv');
    assert.deepEqual(rows[0], { personName: 'Smith, Ann', size: 'M', notes: 'wide, short' });
  });

  test('no valid rows / wrong headers / header only → 400', async () => {
    for (const csv of ['Name,Size\n', 'Full Name,Shirt\nA,M\n', '', 'Name,Size\n,\n']) {
      await assert.rejects(svc.parseSizeFile(Buffer.from(csv), 'text/csv'), is400, JSON.stringify(csv));
    }
  });

  test('ragged CSV (row with extra columns) is reported as a 400 HttpError, not an unhandled CsvError', async () => {
    await assert.rejects(svc.parseSizeFile(Buffer.from('Name,Size\nA,M,extra\n'), 'text/csv'), is400);
  });
});

// ── XLSX ──────────────────────────────────────────────────────────────────────
describe('parseSizeFile — XLSX', () => {
  test('reads Name/Size/Notes in any column order, numeric sizes stringified, skips blanks', async () => {
    const buf = await xlsx([
      ['Notes', ' size ', 'NAME'],
      ['tall', 'M', '  Ann  '],
      [null, 32, 'Bob'],
      ['x', null, 'NoSize'],
      ['y', 'L', null],
    ]);
    const rows = await svc.parseSizeFile(buf, XLSX, 'roster.xlsx');
    assert.deepEqual(rows, [
      { personName: 'Ann', size: 'M', notes: 'tall' },
      { personName: 'Bob', size: '32', notes: null },
    ]);
  });

  test('notes column absent → notes null', async () => {
    const rows = await svc.parseSizeFile(await xlsx([['Name', 'Size'], ['A', 'S']]), XLSX);
    assert.deepEqual(rows, [{ personName: 'A', size: 'S', notes: null }]);
  });

  test('missing Name or Size header → 400', async () => {
    await assert.rejects(svc.parseSizeFile(await xlsx([['Name', 'Shirt'], ['A', 'S']]), XLSX), is400);
    await assert.rejects(svc.parseSizeFile(await xlsx([['Person', 'Size'], ['A', 'S']]), XLSX), is400);
  });

  test('header only → 400 no valid rows', async () => {
    await assert.rejects(svc.parseSizeFile(await xlsx([['Name', 'Size']]), XLSX), (e) => is400(e) && /No valid rows/.test(e.message));
  });

  test('empty first sheet → 400 (header not found)', async () => {
    await assert.rejects(svc.parseSizeFile(await xlsx([], { sheets: 2 }), XLSX), is400);
  });

  test('workbook with no worksheets → 400', async () => {
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await assert.rejects(svc.parseSizeFile(buf, XLSX), is400);
  });

  test('rich-text / formula cells are read as text, not "[object Object]"', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['Name', 'Size']);
    ws.addRow([{ richText: [{ text: 'Ann ' }, { font: { bold: true }, text: 'Smith' }] }, { formula: '"M"', result: 'M' }]);
    const rows = await svc.parseSizeFile(Buffer.from(await wb.xlsx.writeBuffer()), XLSX);
    assert.deepEqual(rows, [{ personName: 'Ann Smith', size: 'M', notes: null }]);
  });

  test('corrupt / non-xlsx upload is reported as a 400 HttpError', async () => {
    await assert.rejects(svc.parseSizeFile(Buffer.from('definitely not a zip'), XLSX, 'x.xlsx'), is400);
  });
});

// ── DB helpers ────────────────────────────────────────────────────────────────
describe('bulkInsertSizeEntries / listSizeEntries', () => {
  test('inserts each row in order with the right params', async () => {
    db.on(/INSERT INTO order_size_entries/, (_t, p) => ({ rows: [{ id: p[1] }] }));
    const r = await svc.bulkInsertSizeEntries('o1', [
      { personName: 'A', size: 'S', notes: null },
      { personName: 'B', size: 'M', notes: 'n' },
    ]);
    assert.deepEqual(r, [{ id: 'A' }, { id: 'B' }]);
    assert.deepEqual(db.calls.map((c) => c.params), [['o1', 'A', 'S', null], ['o1', 'B', 'M', 'n']]);
  });

  test('all inserts run in one transaction; a failing row rolls the whole roster back', async () => {
    let n = 0;
    db.on(/INSERT INTO order_size_entries/, () => { if (++n === 2) throw new Error('boom'); return { rows: [{ id: n }] }; });
    await assert.rejects(svc.bulkInsertSizeEntries('o1', [
      { personName: 'A', size: 'S', notes: null },
      { personName: 'B', size: 'M', notes: null },
    ]), /boom/);
    assert.deepEqual(db.txLog, ['BEGIN', 'ROLLBACK']);
  });

  test('replace: true deletes the existing roster first, inside the same transaction', async () => {
    db.on(/INSERT INTO order_size_entries/, (_t, p) => ({ rows: [{ id: p[1] }] }));
    await svc.bulkInsertSizeEntries('o1', [{ personName: 'A', size: 'S', notes: null }], { replace: true });
    assert.deepEqual(db.txLog, ['BEGIN', 'COMMIT']);
    assert.match(db.calls[0].text, /DELETE FROM order_size_entries WHERE order_id = \$1/);
    assert.deepEqual(db.calls[0].params, ['o1']);
    assert.match(db.calls[1].text, /clock_timestamp\(\)/);
  });

  test('more than MAX_ROSTER_ROWS rows → 400', async () => {
    const csv = 'Name,Size\n' + Array.from({ length: svc.MAX_ROSTER_ROWS + 1 }, (_, i) => `P${i},M`).join('\n');
    await assert.rejects(svc.parseSizeFile(Buffer.from(csv), 'text/csv'), is400);
  });

  test('empty input → no queries', async () => {
    assert.deepEqual(await svc.bulkInsertSizeEntries('o1', []), []);
    assert.equal(db.calls.length, 0);
  });

  test('listSizeEntries', async () => {
    db.on(/FROM order_size_entries/, { rows: [{ id: 1 }] });
    assert.deepEqual(await svc.listSizeEntries('o1'), [{ id: 1 }]);
    assert.deepEqual(db.calls[0].params, ['o1']);
  });
});
