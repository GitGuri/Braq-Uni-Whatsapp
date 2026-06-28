import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { query } from '../db/pool.js';
import { HttpError } from '../utils/httpError.js';

// ── Parse an uploaded roster into [{ personName, size, notes }] ──────────────
// Expected columns (header row, case-insensitive): Name, Size, Notes (optional)
export async function parseSizeFile(buffer, mimetype, filename = '') {
  const isCsv = mimetype === 'text/csv' || mimetype === 'application/csv' || filename.endsWith('.csv');
  return isCsv ? parseCsv(buffer) : parseXlsx(buffer);
}

function parseCsv(buffer) {
  const records = parse(buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  const rows = records.map(rowToEntry).filter(Boolean);
  if (!rows.length) throw new HttpError(400, 'No valid rows found — expected "Name" and "Size" columns');
  return rows;
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new HttpError(400, 'Uploaded file has no worksheets');

  const headerRow = sheet.getRow(1).values.map((v) => String(v || '').trim().toLowerCase());
  const nameIdx = headerRow.indexOf('name');
  const sizeIdx = headerRow.indexOf('size');
  const notesIdx = headerRow.indexOf('notes');
  if (nameIdx < 0 || sizeIdx < 0) throw new HttpError(400, 'Expected a "Name" and "Size" column');

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = row.values[nameIdx];
    const size = row.values[sizeIdx];
    if (!name || !size) return;
    rows.push({
      personName: String(name).trim(),
      size: String(size).trim(),
      notes: notesIdx >= 0 ? (row.values[notesIdx] ?? null) : null,
    });
  });
  if (!rows.length) throw new HttpError(400, 'No valid rows found — expected "Name" and "Size" columns');
  return rows;
}

function rowToEntry(record) {
  const normalized = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[key.trim().toLowerCase()] = typeof value === 'string' ? value.trim() : value;
  }
  if (!normalized.name || !normalized.size) return null;
  return { personName: normalized.name, size: normalized.size, notes: normalized.notes || null };
}

export async function bulkInsertSizeEntries(orderId, rows) {
  const inserted = [];
  for (const row of rows) {
    const { rows: result } = await query(
      `INSERT INTO order_size_entries (order_id, person_name, size, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [orderId, row.personName, row.size, row.notes]
    );
    inserted.push(result[0]);
  }
  return inserted;
}

export async function listSizeEntries(orderId) {
  const { rows } = await query(
    'SELECT * FROM order_size_entries WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId]
  );
  return rows;
}
