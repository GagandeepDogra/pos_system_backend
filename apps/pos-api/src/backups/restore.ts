// Backup download and validated restore (REQ-079, REQ-110, REQ-123, REQ-131).
// Preview: the uploaded file is validated with parseWorkbook (schema version,
// exactly the 15 sheets, columns, types, 2-dp decimals, enums, unique ids,
// references) plus "has an active Admin", then staged in restore-staging/.
// Confirm: inside queue.exclusive (queued writes wait) → RESTORE audit in the old
// data → pre-restore snapshot → re-validate the staged file → swap it in as the
// live workbook → RESTORE audit in the new data + app.reload to every device.
import crypto from 'crypto';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { SheetName } from '@dhaba/shared';
import { SHEET_NAMES } from '../storage/schema';
import { writeAudit } from '../audit/audit';
import { ApiError } from '../common/errors';
import { parseSnapshotName } from '../storage/backup-folder';
import type { StorageService } from '../storage/storage.service';
import { WorkbookData, WorkbookValidationError, parseWorkbook } from '../storage/workbook-codec';
import { readWorkbookFile } from '../storage/workbook-file';

/** A staged upload stays confirmable this long. */
export const RESTORE_TTL_MS = 30 * 60_000;

export interface RestorePreview {
  restore_id: string;
  file_name: string | null;
  /** When the uploaded workbook was last saved (its Meta.updated_at). */
  file_date: string;
  schema_version: number;
  order_count: number;
  payment_count: number;
  counts: Record<SheetName, number>;
  expires_at: string;
}

export interface RestoreResult {
  restore_id: string;
  restored: true;
  pre_restore_snapshot: string;
  file_date: string;
  order_count: number;
  payment_count: number;
}

interface Staged {
  preview: RestorePreview;
  file: string;
  userId: string;
  expiresMs: number;
}

export class RestoreInvalidError extends ApiError {
  constructor(errors: string[]) {
    super(422, 'RESTORE_INVALID', 'This backup file cannot be restored', 'यह बैकअप फ़ाइल रिस्टोर नहीं हो सकती', {
      errors: errors.slice(0, 50),
      error_count: errors.length,
    });
  }
}

/** Parses and validates an uploaded workbook; throws RestoreInvalidError (422) listing the problems. */
export async function validateUpload(buffer: Buffer): Promise<WorkbookData> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new RestoreInvalidError(['the file is not an .xlsx workbook']);
  }
  let data: WorkbookData;
  try {
    data = parseWorkbook(wb);
  } catch (err) {
    if (err instanceof WorkbookValidationError) throw new RestoreInvalidError(err.errors);
    throw new RestoreInvalidError([(err as Error).message]);
  }
  // Restoring a file nobody can log in to as Admin would lock the owner out.
  if (!data.users.some((u) => u.role === 'ADMIN' && u.is_active)) {
    throw new RestoreInvalidError(['users: the file has no active Admin']);
  }
  return data;
}

function countRows(data: WorkbookData): Record<SheetName, number> {
  return Object.fromEntries(SHEET_NAMES.map((s) => [s, data[s].length])) as Record<SheetName, number>;
}

/** Resolves the file a download names: the live workbook, or a snapshot listed in backups/. */
export function downloadTarget(storage: StorageService, snapshot: string | undefined): { file: string; name: string; live: boolean } {
  if (!snapshot) return { file: storage.workbookPath, name: 'dhaba-pos.xlsx', live: true };
  const found = parseSnapshotName(snapshot) ? storage.backups.folder.list().find((s) => s.name === snapshot) : undefined;
  if (!found) {
    throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', 'No such backup snapshot', 'ऐसा कोई बैकअप नहीं है', { snapshot });
  }
  return { file: found.file, name: found.name, live: false };
}

export class RestoreService {
  private readonly staged = new Map<string, Staged>();

  constructor(
    private readonly storage: StorageService,
    private readonly clock: () => number = () => Date.now(),
  ) {
    // Uploads staged by an earlier run can no longer be confirmed.
    fs.rmSync(storage.restoreStagingDir, { recursive: true, force: true });
  }

  private sweep(): void {
    const now = this.clock();
    for (const [id, s] of this.staged) {
      if (s.expiresMs <= now) {
        this.staged.delete(id);
        fs.rmSync(s.file, { force: true });
      }
    }
  }

  /** Validates and stages an upload (POST /admin/restores). */
  async preview(buffer: Buffer, fileName: string | null, userId: string): Promise<RestorePreview> {
    this.sweep();
    const data = await validateUpload(buffer);
    const id = `RST-${crypto.randomBytes(8).toString('hex')}`;
    const dir = this.storage.restoreStagingDir;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.xlsx`);
    await fsp.writeFile(file, buffer, { mode: 0o600 });
    const expiresMs = this.clock() + RESTORE_TTL_MS;
    const counts = countRows(data);
    const preview: RestorePreview = {
      restore_id: id,
      file_name: fileName,
      file_date: data.meta[0].updated_at,
      schema_version: data.meta[0].schema_version,
      order_count: counts.orders,
      payment_count: counts.payments,
      counts,
      expires_at: new Date(expiresMs).toISOString(),
    };
    this.staged.set(id, { preview, file, userId, expiresMs });
    return preview;
  }

  /** The staged restore, or 404 RESTORE_NOT_FOUND when unknown or expired. */
  get(id: string): Staged {
    this.sweep();
    const s = this.staged.get(id);
    if (!s) {
      throw new ApiError(404, 'RESTORE_NOT_FOUND', 'Restore not found or expired; upload the file again', 'रिस्टोर नहीं मिला या समय समाप्त; फ़ाइल फिर से अपलोड करें', { restore_id: id });
    }
    return s;
  }

  /**
   * The swap (POST /admin/restores/:id/confirm), after the PINs were checked.
   * Runs with the write queue held, so writes arriving meanwhile wait and then
   * apply to the restored data.
   */
  confirm(id: string, userId: string): Promise<RestoreResult> {
    this.get(id);
    const { storage } = this;
    return storage.queue.exclusive(async (commit) => {
      const staged = this.get(id);
      const { preview } = staged;
      commit((tx) =>
        writeAudit(tx, {
          action: 'RESTORE',
          entity_type: 'meta',
          entity_id: 'META',
          user_id: userId,
          before_json: { live_journal_seq: storage.journal.lastSeq },
          after_json: { restore_id: id, file_name: preview.file_name, file_date: preview.file_date },
        }),
      );
      let snapshotName: string;
      try {
        snapshotName = (await storage.backups.snapshot('pre-restore')).name;
      } catch (err) {
        throw new ApiError(503, 'SNAPSHOT_FAILED', 'Could not save the pre-restore backup; nothing was restored', 'रिस्टोर से पहले बैकअप सेव नहीं हुआ; कुछ नहीं बदला', {
          reason: (err as Error).message,
        });
      }
      let data: WorkbookData;
      try {
        data = await readWorkbookFile(staged.file);
      } catch (err) {
        throw new RestoreInvalidError(err instanceof WorkbookValidationError ? err.errors : [(err as Error).message]);
      }
      await storage.replaceWorkbook(data);
      commit((tx) => {
        writeAudit(tx, {
          action: 'RESTORE',
          entity_type: 'meta',
          entity_id: 'META',
          user_id: userId,
          after_json: { restore_id: id, file_name: preview.file_name, file_date: preview.file_date, pre_restore_snapshot: snapshotName },
        });
        tx.emit('app.reload', { reason: 'RESTORE', restore_id: id });
        tx.emit('dashboard.updated', {});
      });
      // A snapshot of the restored data, so crash recovery (newest valid backup + journal) starts from it.
      await storage.backups.snapshot('auto').catch(() => undefined);
      this.staged.delete(id);
      fs.rmSync(staged.file, { force: true });
      return {
        restore_id: id,
        restored: true,
        pre_restore_snapshot: snapshotName,
        file_date: preview.file_date,
        order_count: preview.order_count,
        payment_count: preview.payment_count,
      };
    });
  }
}
