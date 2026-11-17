import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { query, withTransaction } from '../../core/db.js';
import { HttpError } from '../../core/errors.js';

// Upper bound on roster rows per upload (keeps one upload from flooding the DB).
export const MAX_ROSTER_ROWS = 5000;

const NO_ROWS_MSG = 'No valid rows found — expected "Name" and "Size" columns';

// ── Parse an uploaded roster into [{ personName, size, notes }] ──────────────
// Expected columns (header row, case-insensitive): Name, Size, Notes (optional)
// Any unreadable / malformed file is reported as HttpError(400).
export async function parseSizeFile(buffer, mimetype, filename = '') {
  const isCsv = mimetype === 'text/csv' || mimetype === 'application/csv' || /\.csv$/i.test(filename || '');
  const rows = isCsv ? parseCsv(buffer) : await parseXlsx(buffer);
  if (rows.length > MAX_ROSTER_ROWS) {
    throw new HttpError(400, `Roster has ${rows.length} rows — the maximum per upload is ${MAX_ROSTER_ROWS}`);
  }
  return rows;
}

function parseCsv(buffer) {
  let records;
  try {
    records = parse(buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw new HttpError(400, `Could not read CSV file: ${err.message}`);
  }
  const rows = records.map(rowToEntry).filter(Boolean);
  if (!rows.length) throw new HttpError(400, NO_ROWS_MSG);
  return rows;
}

/** Plain text of an ExcelJS cell value (rich text, formulas, hyperlinks, dates…). */
function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r?.text ?? '').join('');
    if ('result' in value || 'formula' in value || 'sharedFormula' in value) return cellText(value.result);
    if ('text' in value) return cellText(value.text);
    if ('error' in value) return '';
    return '';
  }
  return String(value);
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw new HttpError(400, 'Could not read the spreadsheet — upload a valid .xlsx or .csv file');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new HttpError(400, 'Uploaded file has no worksheets');

  const headerRow = (sheet.getRow(1).values || []).map((v) => cellText(v).trim().toLowerCase());
  const nameIdx = headerRow.indexOf('name');
  const sizeIdx = headerRow.indexOf('size');
  const notesIdx = headerRow.indexOf('notes');
  if (nameIdx < 0 || sizeIdx < 0) throw new HttpError(400, 'Expected a "Name" and "Size" column');

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = cellText(row.values[nameIdx]).trim();
    const size = cellText(row.values[sizeIdx]).trim();
    if (!name || !size) return;
    const notes = notesIdx >= 0 ? cellText(row.values[notesIdx]).trim() : '';
    rows.push({ personName: name, size, notes: notes || null });
  });
  if (!rows.length) throw new HttpError(400, NO_ROWS_MSG);
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

// ── Store roster rows (all-or-nothing) ───────────────────────────────────────
// replace: true deletes the order's existing entries first (re-upload of a
// corrected roster). Rows are stamped with clock_timestamp() so they list back
// in file order.
export async function bulkInsertSizeEntries(orderId, rows, { replace = false } = {}) {
  if (!rows.length && !replace) return [];
  return withTransaction(async (tx) => {
    // Serialise uploads for this order: two concurrent replacements must not both
    // survive merged into one roster (FIN-10).
    await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (replace) await tx.query('DELETE FROM order_size_entries WHERE order_id = $1', [orderId]);
    const inserted = [];
    for (const row of rows) {
      const { rows: result } = await tx.query(
        `INSERT INTO order_size_entries (order_id, person_name, size, notes, created_at)
         VALUES ($1,$2,$3,$4, clock_timestamp()) RETURNING *`,
        [orderId, row.personName, row.size, row.notes ?? null]
      );
      inserted.push(result[0]);
    }
    return inserted;
  });
}

export async function listSizeEntries(orderId) {
  const { rows } = await query(
    'SELECT * FROM order_size_entries WHERE order_id = $1 ORDER BY created_at ASC',
    [orderId]
  );
  return rows;
}
