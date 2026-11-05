// Reading and atomically writing the live workbook file.
import fs, { promises as fsp } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { WorkbookData, buildWorkbook, parseWorkbook } from './workbook-codec';

/** Reads and validates a workbook file. Throws WorkbookValidationError on a bad file. */
export async function readWorkbookFile(file: string): Promise<WorkbookData> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return parseWorkbook(wb);
}

/** Folder of the read-only monthly archives (REQ-108), inside DATA_DIR. */
export const ARCHIVE_FOLDER_NAME = 'archive';
/** `2026-11.xlsx`, then `2026-11-2.xlsx`… for rows of that month archived by a later close. */
export const ARCHIVE_FILE_RE = /^(\d{4}-\d{2})(?:-(\d+))?\.xlsx$/;

/** Raised when anything tries to (re)write a read-only archive workbook. */
export class ArchiveReadOnlyError extends Error {
  constructor(file: string) {
    super(`${path.basename(file)} is a read-only archive workbook and cannot be written`);
    this.name = 'ArchiveReadOnlyError';
  }
}

function isReadOnly(file: string): boolean {
  const inArchive = path.basename(path.dirname(path.resolve(file))) === ARCHIVE_FOLDER_NAME;
  if (inArchive && ARCHIVE_FILE_RE.test(path.basename(file))) return true;
  try {
    return (fs.statSync(file).mode & 0o222) === 0;
  } catch {
    return false;
  }
}

/** Builds the workbook into a fsync'd temp file next to `file`; returns the temp path. */
async function writeTemp(file: string, data: WorkbookData, password: string): Promise<string> {
  const wb = await buildWorkbook(data, password);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } catch (err) {
    // Disk full or similar: never leave a partial temp file behind; the target is untouched.
    await handle.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  return tmp;
}

/**
 * Writes a new archive workbook once: refuses an existing file, and the file is
 * made read-only (mode 0444) before it appears under its name. After that every
 * application write to it fails with ArchiveReadOnlyError.
 */
export async function writeArchiveFile(file: string, data: WorkbookData, password: string): Promise<void> {
  if (fs.existsSync(file)) throw new ArchiveReadOnlyError(file);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = await writeTemp(file, data, password);
  try {
    await fsp.chmod(tmp, 0o444);
    // link() fails if the name exists, so an archive is never replaced.
    await fsp.link(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/**
 * Writes the workbook through a temp file in the same folder, fsyncs it and
 * renames it over the target, so a crash never leaves a half-written file.
 */
export async function writeWorkbookFile(file: string, data: WorkbookData, password: string): Promise<void> {
  // Archives are read-only (REQ-108): a rename over them would otherwise succeed.
  if (isReadOnly(file)) throw new ArchiveReadOnlyError(file);
  const tmp = await writeTemp(file, data, password);
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
