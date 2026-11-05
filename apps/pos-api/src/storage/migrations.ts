// Startup schema migrations (REQ-105). A migration upgrades a workbook from
// version N to N+1 in memory; the live file is replaced only after the
// migrated copy validates, and the original is copied to backups/ first.
import ExcelJS from 'exceljs';
import { SCHEMA_VERSION } from './schema';
import { WorkbookValidationError } from './workbook-codec';

export type Migration = (wb: ExcelJS.Workbook) => void;

/** MIGRATIONS[n] upgrades a version-n workbook to n+1. None yet: v1 is the first schema. */
export const MIGRATIONS: Record<number, Migration> = {};

function metaColumn(wb: ExcelJS.Workbook, name: string): { ws: ExcelJS.Worksheet; col: number } | null {
  const ws = wb.getWorksheet('meta');
  if (!ws) return null;
  let col = 0;
  ws.getRow(1).eachCell((cell, n) => {
    if (cell.value === name) col = n;
  });
  return col ? { ws, col } : null;
}

/** schema_version from the meta sheet, or null when it cannot be read. */
export function readSchemaVersion(wb: ExcelJS.Workbook): number | null {
  const at = metaColumn(wb, 'schema_version');
  const v = at?.ws.getRow(2).getCell(at.col).value;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * Runs the pending migrations on the given (in-memory) workbook. Returns the
 * version it started from. Throws WorkbookValidationError for a newer file or
 * a version with no migration path.
 */
export function migrateWorkbook(wb: ExcelJS.Workbook, migrations: Record<number, Migration> = MIGRATIONS): number {
  const from = readSchemaVersion(wb);
  if (from === null || from === SCHEMA_VERSION) return from ?? SCHEMA_VERSION;
  if (from > SCHEMA_VERSION) {
    throw new WorkbookValidationError([`meta: schema_version ${from} is newer than this server (${SCHEMA_VERSION})`]);
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (!step) throw new WorkbookValidationError([`meta: no migration from schema_version ${v} to ${v + 1}`]);
    step(wb);
    const at = metaColumn(wb, 'schema_version')!;
    at.ws.getRow(2).getCell(at.col).value = v + 1;
  }
  return from;
}
