// Reading and atomically writing the live workbook file.
import { promises as fsp } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { WorkbookData, buildWorkbook, parseWorkbook } from './workbook-codec';

/** Reads and validates a workbook file. Throws WorkbookValidationError on a bad file. */
export async function readWorkbookFile(file: string): Promise<WorkbookData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return parseWorkbook(wb);
}

/**
 * Writes the workbook through a temp file in the same folder, fsyncs it and
 * renames it over the target, so a crash never leaves a half-written file.
 */
export async function writeWorkbookFile(file: string, data: WorkbookData, password: string): Promise<void> {
  const wb = await buildWorkbook(data, password);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
