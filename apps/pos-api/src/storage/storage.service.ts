// Owns the live workbook and the write journal. Startup (REQ-105): lock the
// folder → read the workbook → run pending migrations on a copy → replay the
// journal past Meta.last_journal_seq → serve. Request handlers read from
// `store`; every change goes through `queue` (REQ-106).
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { WritesBlockedError } from '../common/errors';
import { nowIst } from '../common/time';
import { BackupService } from './backup.service';
import { FolderLock } from './folder-lock';
import { JOURNAL_FILE, Journal, JournalEntry, readJournal } from './journal';
import { MIGRATIONS, Migration, migrateWorkbook } from './migrations';
import { SCHEMA_VERSION } from './schema';
import { Row, WorkbookData, WorkbookValidationError, emptyData, parseWorkbook } from './workbook-codec';
import { readWorkbookFile, writeWorkbookFile } from './workbook-file';
import { WorkbookStore } from './workbook-store';
import { WriteQueue } from './write-queue';

export const WORKBOOK_FILE = 'dhaba-pos.xlsx';
export const BACKUP_DIR = 'backups';

export interface StorageOptions {
  dataDir: string;
  sheetPassword: string;
  /** Overridable for tests. */
  migrations?: Record<number, Migration>;
}

export type StorageState = 'loading' | 'ready' | 'corrupt';

/** What a corrupt live workbook offers: the newest valid backup plus the journal entries after it. */
export interface RecoveryOffer {
  errors: string[];
  backup: string | null;
  backup_journal_seq: number | null;
  journal_entries_to_replay: number;
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

/** Applies journal entries with seq > afterSeq onto the store. Returns how many were applied. */
export function replayJournal(store: WorkbookStore, entries: JournalEntry[], afterSeq: number): number {
  let applied = 0;
  for (const e of entries) {
    if (e.seq <= afterSeq) continue;
    for (const op of e.ops) {
      const id = op.r.id as string;
      if (store.get(op.s, id)) store.replace(op.s, op.r as never);
      else store.insert(op.s, op.r as never);
    }
    applied++;
  }
  return applied;
}

function stamp(): string {
  return nowIst().replace(/[:.]/g, '-').slice(0, 19);
}

export class StorageService {
  readonly workbookPath: string;
  readonly journal: Journal;
  readonly queue: WriteQueue;
  private readonly lock: FolderLock;
  private storeRef: WorkbookStore | null = null;
  private stateRef: StorageState = 'loading';
  private locked = false;
  private offer: RecoveryOffer | null = null;
  /** Result of the last journal write and the last save, for /health. */
  lastJournalError: string | null = null;
  lastSaveError: string | null = null;
  lastSavedAt: string | null = null;
  /** Journal sequence included in the live file on disk (-1 until known). */
  lastSavedSeq = -1;
  /** Snapshots into backups/ (REQ-109). */
  declare readonly backups: BackupService;
  /** Journal entries replayed at the last load. */
  replayed = 0;
  migratedFrom: number | null = null;

  constructor(private readonly options: StorageOptions) {
    this.workbookPath = path.join(options.dataDir, WORKBOOK_FILE);
    this.journal = new Journal(path.join(options.dataDir, JOURNAL_FILE));
    this.lock = new FolderLock(options.dataDir);
    const host = {
      journal: this.journal,
      assertWritable: () => this.assertWritable(),
      journalResult: (err: Error | null) => {
        this.lastJournalError = err ? err.message : null;
      },
    };
    // Non-enumerable, so serialising the service (Nest does for module tokens) never touches it.
    Object.defineProperty(host, 'store', { get: () => this.store, enumerable: false });
    this.queue = new WriteQueue(host as typeof host & { store: WorkbookStore });
    // Non-enumerable for the same reason as `store` (it points back at this service).
    Object.defineProperty(this, 'backups', { value: new BackupService(this), enumerable: false });
  }

  get store(): WorkbookStore {
    if (!this.storeRef) throw new Error('Workbook not loaded');
    return this.storeRef;
  }

  get loaded(): boolean {
    return this.stateRef === 'ready';
  }

  get state(): StorageState {
    return this.stateRef;
  }

  get recoveryOffer(): RecoveryOffer | null {
    return this.offer;
  }

  get backupDir(): string {
    return path.join(this.options.dataDir, BACKUP_DIR);
  }

  assertWritable(): void {
    if (this.stateRef === 'loading') throw new WritesBlockedError('starting');
    if (this.stateRef === 'corrupt') throw new WritesBlockedError('workbook is corrupt');
  }

  /** Locks the folder, then loads. Kept as one call for tests and tools. */
  async open(): Promise<void> {
    this.lockFolder();
    await this.load();
  }

  /** Takes the exclusive folder lock (fast; done before the HTTP port opens). */
  lockFolder(): void {
    this.lock.acquire();
    this.locked = true;
  }

  /**
   * Loads the workbook, migrates it and replays the journal. A workbook that
   * cannot be read leaves the service in the `corrupt` state (writes blocked,
   * recovery offered) instead of throwing. A damaged journal throws.
   */
  async load(): Promise<void> {
    try {
      const journalHasEntries = readJournal(this.journal.file).entries.length > 0;
      if (!fs.existsSync(this.workbookPath)) {
        if (journalHasEntries) {
          await this.enterCorrupt([`${WORKBOOK_FILE} is missing but the journal holds changes`]);
          return;
        }
        await writeWorkbookFile(this.workbookPath, initialData(), this.options.sheetPassword);
      }
      let data: WorkbookData;
      try {
        data = await this.readAndMigrate();
      } catch (err) {
        if (err instanceof WorkbookValidationError) await this.enterCorrupt(err.errors);
        else await this.enterCorrupt([`${WORKBOOK_FILE} cannot be read: ${(err as Error).message}`]);
        return;
      }
      const store = new WorkbookStore(data);
      const baseSeq = store.get('meta', 'META')!.last_journal_seq;
      this.lastSavedSeq = baseSeq;
      const entries = this.journal.open(baseSeq);
      this.replayed = replayJournal(store, entries, baseSeq);
      this.storeRef = store;
      this.stateRef = 'ready';
      if (this.replayed || this.migratedFrom !== null) await this.save();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private async readAndMigrate(): Promise<WorkbookData> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(this.workbookPath);
    const from = migrateWorkbook(wb, this.options.migrations ?? MIGRATIONS);
    const data = parseWorkbook(wb);
    if (from !== SCHEMA_VERSION) {
      // The original stays untouched in backups/ before the migrated copy replaces it.
      fs.mkdirSync(this.backupDir, { recursive: true });
      fs.copyFileSync(this.workbookPath, path.join(this.backupDir, `pre-migration-v${from}-${stamp()}.xlsx`));
      this.migratedFrom = from;
    }
    return data;
  }

  private async enterCorrupt(errors: string[]): Promise<void> {
    this.stateRef = 'corrupt';
    this.storeRef = null;
    const backup = await this.findNewestValidBackup();
    const entries = readJournal(this.journal.file).entries;
    this.offer = {
      errors,
      backup: backup?.file ?? null,
      backup_journal_seq: backup?.seq ?? null,
      journal_entries_to_replay: entries.filter((e) => e.seq > (backup?.seq ?? 0)).length,
    };
  }

  /** Finds the newest backup in backups/ that passes full validation. */
  async findNewestValidBackup(): Promise<{ file: string; seq: number; data: WorkbookData } | null> {
    if (!fs.existsSync(this.backupDir)) return null;
    const files = fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.xlsx'))
      .map((f) => path.join(this.backupDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
      try {
        const data = await readWorkbookFile(file);
        return { file, seq: data.meta[0].last_journal_seq, data };
      } catch {
        // Not a valid backup; try an older one.
      }
    }
    return null;
  }

  /**
   * Accepts the recovery offer: moves the corrupt file aside, loads the newest
   * valid backup, replays the journal past the backup's sequence and saves it
   * as the live workbook. Writes are allowed again afterwards.
   */
  async recoverFromBackup(): Promise<{ backup: string; replayed: number; corruptCopy: string | null }> {
    if (this.stateRef !== 'corrupt') throw new Error('the live workbook is not corrupt');
    const backup = await this.findNewestValidBackup();
    if (!backup) throw new Error('no valid backup found in backups/');
    let corruptCopy: string | null = null;
    if (fs.existsSync(this.workbookPath)) {
      corruptCopy = `${this.workbookPath}.corrupt-${stamp()}`;
      fs.renameSync(this.workbookPath, corruptCopy);
    }
    const store = new WorkbookStore(backup.data);
    const entries = this.journal.open(backup.seq);
    this.replayed = replayJournal(store, entries, backup.seq);
    this.storeRef = store;
    this.stateRef = 'ready';
    this.offer = null;
    await this.save();
    return { backup: backup.file, replayed: this.replayed, corruptCopy };
  }

  private saving: Promise<void> = Promise.resolve();

  /**
   * Atomic temp-file-and-rename save; records the journal sequence the file
   * includes. Saves never overlap: a call waits for the one in progress.
   */
  save(): Promise<void> {
    const next = this.saving.catch(() => undefined).then(() => this.saveNow());
    this.saving = next;
    return next;
  }

  private async saveNow(): Promise<void> {
    const store = this.store;
    const seq = this.journal.lastSeq;
    const meta = store.get('meta', 'META')!;
    const now = nowIst();
    store.replace('meta', { ...meta, last_journal_seq: seq, updated_at: now });
    try {
      await writeWorkbookFile(this.workbookPath, store.toData(), this.options.sheetPassword);
      this.lastSaveError = null;
      this.lastSavedAt = now;
      this.lastSavedSeq = seq;
    } catch (err) {
      this.lastSaveError = (err as Error).message;
      throw err;
    }
  }

  close(): void {
    this.backups.stopScheduler();
    this.journal.close();
    this.storeRef = null;
    if (this.stateRef === 'ready') this.stateRef = 'loading';
    if (this.locked) this.lock.release();
    this.locked = false;
  }
}

export type { Row };
