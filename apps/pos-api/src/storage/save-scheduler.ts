// Coalesced workbook save (REQ-107): at most one save every 2 seconds, and
// always within 2 seconds of the last change. The first commit of a burst arms
// one 2 s timer; every commit that lands while it is armed rides along. A
// commit during a running save re-arms after it. A failed save keeps the previous live
// file (temp file + rename), turns /health red and is retried 2 s later.
import { SchedulerClock, systemClock } from './snapshot-scheduler';

export const SAVE_INTERVAL_MS = 2000;

export interface SaveTarget {
  save(): Promise<void>;
  /** Journal seq already in the live file, and the newest journal seq. */
  readonly lastSavedSeq: number;
  readonly changeSeq: number;
}

export class SaveScheduler {
  private timer: unknown = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Number of saves started (for tests and the benchmark). */
  saves = 0;

  constructor(
    private readonly target: SaveTarget,
    private readonly clock: SchedulerClock = systemClock,
    private readonly intervalMs = SAVE_INTERVAL_MS,
    private readonly onError: (err: Error) => void = () => undefined,
  ) {}

  /** Called after every committed change. */
  changed(): void {
    if (this.stopped || this.timer !== null) return;
    // The first change of a burst arms the timer; the rest ride along. Saves
    // start at least intervalMs apart because the timer is only armed again
    // after the previous save started.
    this.timer = this.clock.setTimeout(() => this.fire(), this.intervalMs);
  }

  private fire(): void {
    this.timer = null;
    if (this.stopped) return;
    this.saves++;
    this.running = this.target.save().then(
      () => {
        // Changes committed during the save are not in the file yet.
        if (this.target.lastSavedSeq < this.target.changeSeq) this.changed();
      },
      (err: Error) => {
        this.onError(err);
        this.changed();
      },
    );
  }

  /** Resolves when no save is running (tests). */
  whenIdle(): Promise<void> {
    return this.running;
  }

  /** Saves now if anything is unsaved (shutdown, day close). */
  async flush(): Promise<void> {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    if (this.target.lastSavedSeq < this.target.changeSeq) {
      this.saves++;
      this.running = this.target.save();
      await this.running;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
