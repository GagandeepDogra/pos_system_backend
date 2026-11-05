// Takes workbook snapshots into backups/ (REQ-109, REQ-130). A snapshot first
// flushes a save if the live file lags the journal, then copies the saved file,
// re-reads the copy to verify it, prunes by the retention policy and compacts
// the journal. Day close (and restore) call `snapshot()` directly; the
// SnapshotScheduler calls it every 15 minutes when changes occurred.
import fs from 'fs';
import { nowIst } from '../common/time';
import { BackupFolder, SnapshotFile, SnapshotReason } from './backup-folder';
import type { StorageService } from './storage.service';
import { SchedulerOptions, SnapshotScheduler } from './snapshot-scheduler';
import { readWorkbookFile } from './workbook-file';

export interface TakenSnapshot extends SnapshotFile {
  /** Meta.last_journal_seq inside the snapshot. */
  journal_seq: number;
}

export class BackupService {
  readonly folder: BackupFolder;
  lastSnapshot: TakenSnapshot | null = null;
  lastSnapshotError: string | null = null;
  /** Journal seq of the newest verified snapshot, and the one before it. */
  private verifiedSeqs: number[] = [];
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: StorageService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.folder = new BackupFolder(storage.backupDir);
  }

  /** Journal sequence of the newest committed change. */
  get changeSeq(): number {
    return this.storage.journal.lastSeq;
  }

  /** The 15-minute timer, once started. */
  scheduler: SnapshotScheduler | null = null;

  /** Starts the automatic snapshot timer (after the workbook is loaded). */
  startScheduler(options: SchedulerOptions = {}): SnapshotScheduler {
    if (!this.scheduler) {
      this.scheduler = new SnapshotScheduler(this, options);
      // Changes replayed from the journal at startup are not in any snapshot yet.
      this.scheduler.start(this.storage.replayed > 0);
    }
    return this.scheduler;
  }

  stopScheduler(): void {
    this.scheduler?.stop();
    this.scheduler = null;
  }

  /** The day-close snapshot: always taken, and it restarts the 15-minute wait. */
  dayCloseSnapshot(): Promise<TakenSnapshot> {
    if (this.scheduler) return this.scheduler.snapshotNow('day-close') as Promise<TakenSnapshot>;
    return this.snapshot('day-close');
  }

  /** Snapshots never overlap: a call waits for the one in progress. */
  snapshot(reason: SnapshotReason, at: Date = this.clock()): Promise<TakenSnapshot> {
    const next = this.running.catch(() => undefined).then(() => this.snapshotNow(reason, at));
    this.running = next;
    return next;
  }

  private async snapshotNow(reason: SnapshotReason, at: Date): Promise<TakenSnapshot> {
    const s = this.storage;
    try {
      if (!s.loaded) throw new Error(`workbook is ${s.state}`);
      if (s.lastSavedSeq !== s.journal.lastSeq || !fs.existsSync(s.workbookPath)) await s.save();
      const copy = await this.folder.copyIn(s.workbookPath, at, reason);
      let seq: number;
      try {
        seq = (await readWorkbookFile(copy.file)).meta[0].last_journal_seq;
      } catch (err) {
        fs.rmSync(copy.file, { force: true });
        throw new Error(`snapshot ${copy.name} failed verification: ${(err as Error).message}`);
      }
      const taken: TakenSnapshot = { ...copy, journal_seq: seq };
      this.lastSnapshot = taken;
      this.lastSnapshotError = null;
      await this.folder.prune(at);
      this.compactJournal(seq);
      return taken;
    } catch (err) {
      this.lastSnapshotError = `${nowIst(at)}: ${(err as Error).message}`;
      throw err;
    }
  }

  /**
   * Drops journal entries already inside the previous verified snapshot. One
   * snapshot of slack stays replayable, so recovery still works if the newest
   * snapshot is later found damaged.
   */
  private compactJournal(seq: number): void {
    this.verifiedSeqs = [...this.verifiedSeqs, seq].slice(-2);
    const upTo = this.verifiedSeqs.length === 2 ? this.verifiedSeqs[0] : 0;
    if (upTo > 0) this.storage.journal.compact(upTo);
  }
}
