// Owns the live workbook: takes the folder lock, loads (or creates) the file
// into memory and saves it atomically. Request handlers read from `store` only.
import fs from 'fs';
import path from 'path';
import { nowIst } from '../common/time';
import { FolderLock } from './folder-lock';
import { SCHEMA_VERSION } from './schema';
import { WorkbookData, emptyData } from './workbook-codec';
import { readWorkbookFile, writeWorkbookFile } from './workbook-file';
import { WorkbookStore } from './workbook-store';

export const WORKBOOK_FILE = 'dhaba-pos.xlsx';

export interface StorageOptions {
  dataDir: string;
  sheetPassword: string;
}

export function initialData(now: string = nowIst()): WorkbookData {
  const data = emptyData();
  data.meta.push({ id: 'META', schema_version: SCHEMA_VERSION, last_journal_seq: 0, updated_at: now });
  data.settings.push({
    id: 'SETTINGS',
    dhaba_name: 'My Dhaba',
    address: '',
    phone: '',
    gst_number: null,
    gst_rate_percent: null,
    receipt_footer: 'Thank you! Visit again.',
    token_reset_time: '04:00',
    shift_end_time: null,
    late_kot_minutes: 15,
    discount_limit_amount: '100.00',
    kitchen_print_enabled: false,
    created_at: now,
    created_by: 'SYSTEM',
    updated_at: now,
    updated_by: 'SYSTEM',
    row_version: 1,
  });
  return data;
}

export class StorageService {
  readonly workbookPath: string;
  private readonly lock: FolderLock;
  private storeRef: WorkbookStore | null = null;

  constructor(private readonly options: StorageOptions) {
    this.workbookPath = path.join(options.dataDir, WORKBOOK_FILE);
    this.lock = new FolderLock(options.dataDir);
  }

  get store(): WorkbookStore {
    if (!this.storeRef) throw new Error('Workbook not loaded');
    return this.storeRef;
  }

  get loaded(): boolean {
    return this.storeRef !== null;
  }

  /** Locks the folder, then loads the workbook, creating a fresh one if none exists. */
  async open(): Promise<void> {
    this.lock.acquire();
    try {
      if (!fs.existsSync(this.workbookPath)) {
        await writeWorkbookFile(this.workbookPath, initialData(), this.options.sheetPassword);
      }
      this.storeRef = new WorkbookStore(await readWorkbookFile(this.workbookPath));
    } catch (err) {
      this.lock.release();
      throw err;
    }
  }

  /** Atomic temp-file-and-rename save of the in-memory workbook. */
  async save(): Promise<void> {
    await writeWorkbookFile(this.workbookPath, this.store.toData(), this.options.sheetPassword);
  }

  close(): void {
    this.storeRef = null;
    this.lock.release();
  }
}
