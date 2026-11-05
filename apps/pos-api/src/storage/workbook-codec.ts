// Converts between in-memory rows and an ExcelJS workbook.
// Writing adds the hand-edit guards (dropdowns, frozen bold headers, locked ID
// columns, sheet password). Reading re-validates everything: the backend, not
// Excel, is the real validator.
import ExcelJS from 'exceljs';
import { SheetName, WorkbookRows } from '@dhaba/shared';
import { ColumnDef, SCHEMA_VERSION, SHEETS, SHEET_NAMES, isIdColumn, sheetDef } from './schema';

export type Row = Record<string, unknown>;
export type WorkbookData = { [S in SheetName]: WorkbookRows[S][] };
type RawData = Record<SheetName, Row[]>;

export class WorkbookValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Workbook failed validation: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ' …' : ''}`);
    this.name = 'WorkbookValidationError';
  }
}

/** Spare blank rows below the data that still get dropdown validation. */
const VALIDATION_SPARE_ROWS = 2000;
/** Low spin count: the password only stops casual hand edits, and 100k (the default) costs ~150 ms per sheet. */
const PROTECT_SPIN_COUNT = 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

export function emptyData(): WorkbookData {
  return Object.fromEntries(SHEET_NAMES.map((n) => [n, []])) as unknown as WorkbookData;
}

function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function toCell(c: ColumnDef, v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  switch (c.type) {
    case 'decimal':
      return Math.round(Number(v) * 100) / 100;
    case 'json':
      return JSON.stringify(v);
    default:
      return v as ExcelJS.CellValue;
  }
}

/** Builds a protected, validated ExcelJS workbook from in-memory rows. */
export async function buildWorkbook(data: WorkbookData, password: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'pos-api';
  for (const def of SHEETS) {
    const ws = wb.addWorksheet(def.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = def.columns.map((c) => ({
      header: c.name,
      key: c.name,
      width: Math.min(Math.max(c.name.length + 2, (c.maxLength ?? 12) + 2), 40),
    }));
    const header = ws.getRow(1);
    header.font = { bold: true };

    for (const row of (data as unknown as RawData)[def.name] ?? []) {
      ws.addRow(def.columns.map((c) => toCell(c, row[c.name])));
    }

    // Unlock editable columns (including future blank rows); ID columns stay locked.
    def.columns.forEach((c, i) => {
      const column = ws.getColumn(i + 1);
      const locked = isIdColumn(c);
      column.protection = { locked };
      column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
        // A fresh style object per cell: ExcelJS shares style objects between cells.
        cell.style = { ...cell.style, protection: { locked: rowNumber === 1 ? true : locked } };
      });
      if (c.enum) {
        const letter = columnLetter(i + 1);
        (ws as unknown as { dataValidations: { add(a: string, v: ExcelJS.DataValidation): void } }).dataValidations.add(
          `${letter}2:${letter}${ws.rowCount + VALIDATION_SPARE_ROWS}`,
          {
            type: 'list',
            allowBlank: c.nullable,
            formulae: [`"${c.enum.join(',')}"`],
            showErrorMessage: true,
            errorStyle: 'stop',
            errorTitle: 'Invalid value',
            error: `Choose one of: ${c.enum.join(', ')}`,
          },
        );
      }
    });

    await ws.protect(password, {
      spinCount: PROTECT_SPIN_COUNT,
      selectLockedCells: true,
      selectUnlockedCells: true,
      formatColumns: true,
      sort: false,
      autoFilter: true,
      insertRows: false,
      deleteRows: false,
    });
  }
  return wb;
}

function cellText(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    const o = value as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('formula' in o || 'sharedFormula' in o) return { formula: true };
    if ('text' in o) return o.text;
    if ('error' in o) return { formula: true };
  }
  return value;
}

function parseCell(c: ColumnDef, raw: ExcelJS.CellValue, where: string, errors: string[]): unknown {
  const v = cellText(raw);
  if (v === null || v === '') {
    // Excel cannot tell an empty string from a blank cell: required text reads as ''.
    if (!c.nullable && c.type === 'string') return '';
    if (!c.nullable) errors.push(`${where}: ${c.name} is required`);
    return null;
  }
  if (typeof v === 'object' && v !== null && 'formula' in v) {
    errors.push(`${where}: ${c.name} must not hold a formula`);
    return null;
  }
  const bad = (what: string): null => {
    errors.push(`${where}: ${c.name} ${what}`);
    return null;
  };
  switch (c.type) {
    case 'int': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isInteger(n) ? n : bad(`must be a whole number, got ${String(v)}`);
    }
    case 'decimal': {
      const str = typeof v === 'number' ? String(v) : String(v).trim();
      if (!DECIMAL_RE.test(str)) return bad(`must be a number with at most 2 decimals, got ${str}`);
      return Number(str).toFixed(2);
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'TRUE' || v === 'true') return true;
      if (v === 'FALSE' || v === 'false') return false;
      return bad(`must be TRUE or FALSE, got ${String(v)}`);
    case 'date': {
      const str = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
      return DATE_RE.test(str) ? str : bad(`must be a YYYY-MM-DD date, got ${str}`);
    }
    case 'timestamp': {
      const str = v instanceof Date ? v.toISOString() : String(v);
      return TIMESTAMP_RE.test(str) ? str : bad(`must be an ISO 8601 timestamp, got ${str}`);
    }
    case 'json':
      try {
        return JSON.parse(String(v));
      } catch {
        return bad('must be valid JSON');
      }
    default: {
      const str = v instanceof Date ? v.toISOString() : String(v);
      if (c.maxLength !== undefined && str.length > c.maxLength) {
        return bad(`is longer than ${c.maxLength} characters`);
      }
      if (c.enum && !c.enum.includes(str)) {
        return bad(`has invalid value "${str}" (allowed: ${c.enum.join(', ')})`);
      }
      return str;
    }
  }
}

/**
 * Reads and validates a workbook against the v1 schema: exactly the 15 sheets,
 * the expected header columns, types, enums, unique values, references and the
 * Meta schema version. Throws WorkbookValidationError listing every problem.
 */
export function parseWorkbook(wb: ExcelJS.Workbook): WorkbookData {
  const errors: string[] = [];
  const names = wb.worksheets.map((w) => w.name);
  for (const n of names) {
    if (!SHEET_NAMES.includes(n as SheetName)) errors.push(`unexpected sheet "${n}"`);
  }
  for (const n of SHEET_NAMES) {
    if (!names.includes(n)) errors.push(`missing sheet "${n}"`);
  }
  if (names.length !== SHEET_NAMES.length && errors.length === 0) {
    errors.push(`expected ${SHEET_NAMES.length} sheets, found ${names.length}`);
  }
  if (errors.length) throw new WorkbookValidationError(errors);

  const data = emptyData() as unknown as RawData;
  for (const def of SHEETS) {
    const ws = wb.getWorksheet(def.name)!;
    const header = ws.getRow(1);
    const positions = new Map<string, number>();
    header.eachCell((cell, colNumber) => positions.set(String(cellText(cell.value)), colNumber));
    const missing = def.columns.filter((c) => !positions.has(c.name)).map((c) => c.name);
    if (missing.length) {
      errors.push(`${def.name}: missing columns ${missing.join(', ')}`);
      continue;
    }
    const uniques = new Map<string, Set<unknown>>(
      def.columns.filter((c) => c.unique).map((c) => [c.name, new Set()]),
    );
    ws.eachRow({ includeEmpty: false }, (r, rowNumber) => {
      if (rowNumber === 1) return;
      const values = def.columns.map((c) => cellText(r.getCell(positions.get(c.name)!).value));
      if (values.every((v) => v === null || v === '')) return;
      const where = `${def.name} row ${rowNumber}`;
      const row: Row = {};
      for (const c of def.columns) {
        const value = parseCell(c, r.getCell(positions.get(c.name)!).value, where, errors);
        row[c.name] = value;
        const seen = uniques.get(c.name);
        if (seen && value !== null) {
          if (seen.has(value)) errors.push(`${where}: duplicate ${c.name} "${String(value)}"`);
          seen.add(value);
        }
      }
      data[def.name].push(row);
    });
  }

  // References between sheets.
  if (!errors.length) {
    for (const def of SHEETS) {
      for (const c of def.columns.filter((x) => x.ref)) {
        const ids = new Set(data[c.ref!].map((r) => r.id));
        data[def.name].forEach((row, i) => {
          const v = row[c.name];
          if (v !== null && !ids.has(v)) {
            errors.push(`${def.name} row ${i + 2}: ${c.name} "${String(v)}" does not exist in ${c.ref}`);
          }
        });
      }
    }
    const meta = data.meta;
    if (meta.length !== 1) errors.push(`meta: expected exactly 1 row, found ${meta.length}`);
    else if (meta[0].schema_version !== SCHEMA_VERSION) {
      errors.push(`meta: schema_version ${String(meta[0].schema_version)} is not supported (expected ${SCHEMA_VERSION})`);
    }
  }

  if (errors.length) throw new WorkbookValidationError(errors);
  return data as unknown as WorkbookData;
}

export { sheetDef };
