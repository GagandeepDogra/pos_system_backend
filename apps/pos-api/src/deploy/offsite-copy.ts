// Nightly off-server backup copy (REQ-015): once a day at OFFSITE_BACKUP_TIME
// (IST) take a fresh verified snapshot and copy it into OFFSITE_BACKUP_DIR, a
// folder mounted from another machine (rclone/sshfs/SMB). The off-server folder
// gets the same retention policy as backups/.
import fs from 'fs';
import { BackupFolder, SnapshotFile } from '../storage/backup-folder';
import { SchedulerClock, systemClock } from '../storage/snapshot-scheduler';

export const DAY_MINUTES = 24 * 60;

export interface SnapshotSource {
  snapshot(reason: 'auto', at?: Date): Promise<{ file: string }>;
}

export interface OffsiteCopyOptions {
  dir: string;
  /** IST HH:mm. */
  time: string;
  clock?: SchedulerClock;
  onError?: (err: Error) => void;
  onCopied?: (copy: SnapshotFile) => void;
}

const DAY_MS = DAY_MINUTES * 60_000;
const IST_OFFSET_MS = 330 * 60_000;

/** Milliseconds from `now` until the next IST `HH:mm` (a full day if it is exactly now). */
export function msUntilIst(time: string, now: Date): number {
  const [h, m] = time.split(':').map(Number);
  const ist = now.getTime() + IST_OFFSET_MS;
  let target = Math.floor(ist / DAY_MS) * DAY_MS + (h * 60 + m) * 60_000;
  if (target <= ist) target += DAY_MS;
  return target - ist;
}

export class OffsiteCopyScheduler {
  readonly folder: BackupFolder;
  private readonly clock: SchedulerClock;
  private timer: unknown = null;
  private running: Promise<void> = Promise.resolve();
  lastCopy: SnapshotFile | null = null;
  lastError: string | null = null;

  constructor(
    private readonly source: SnapshotSource,
    private readonly options: OffsiteCopyOptions,
  ) {
    this.folder = new BackupFolder(options.dir);
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    this.stop();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.running = this.copyNow().then(
        () => undefined,
        () => undefined,
      );
      this.start();
    }, msUntilIst(this.options.time, this.clock.now()));
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  whenIdle(): Promise<void> {
    return this.running;
  }

  /** Snapshot now and copy it off-server; rejects (and records lastError) on failure. */
  async copyNow(): Promise<SnapshotFile> {
    const at = this.clock.now();
    try {
      if (!fs.existsSync(this.options.dir)) throw new Error(`off-server backup folder is not mounted: ${this.options.dir}`);
      const snap = await this.source.snapshot('auto', at);
      const copy = await this.folder.copyIn(snap.file, at, 'auto');
      await this.folder.prune(at);
      this.lastCopy = copy;
      this.lastError = null;
      this.options.onCopied?.(copy);
      return copy;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.lastError = e.message;
      this.options.onError?.(e);
      throw e;
    }
  }
}
