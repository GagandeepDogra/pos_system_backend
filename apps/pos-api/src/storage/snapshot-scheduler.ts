// The in-process snapshot timer (REQ-109, REQ-130). It checks 15 minutes
// after the last snapshot (or the last check) and takes a snapshot only when
// changes were committed since the previous one and the time is within open
// hours. So during open hours no change waits more than 15 minutes to reach
// backups/, and automatic snapshots are never closer than 15 minutes apart.
// Day close calls `snapshotNow('day-close')`, which always snapshots.
import { SnapshotReason, istParts } from './backup-folder';
import type { TakenSnapshot } from './backup.service';

export const SNAPSHOT_INTERVAL_MS = 15 * 60_000;

/** Time source and timers; tests pass a fake clock. */
export interface SchedulerClock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** What the scheduler snapshots (BackupService in production). */
export interface SnapshotTarget {
  /** Sequence of the newest committed change. */
  readonly changeSeq: number;
  snapshot(reason: SnapshotReason, at: Date): Promise<TakenSnapshot | unknown>;
}

/** Open hours as IST minutes of the day; `to` may be before `from` (past midnight). */
export interface OpenHours {
  from: number;
  to: number;
}

/** Parses "HH:mm-HH:mm" (IST). Empty → open all day. "10:00-02:00" runs past midnight. */
export function parseOpenHours(text: string | undefined): OpenHours | null {
  if (!text || !text.trim()) return null;
  const m = /^\s*(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})\s*$/.exec(text);
  if (!m) throw new Error(`open hours must look like 10:00-23:00, got "${text}"`);
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) throw new Error(`open hours out of range: "${text}"`);
  return { from: h1 * 60 + m1, to: h2 * 60 + m2 };
}

export function isOpen(hours: OpenHours | null, at: Date): boolean {
  if (!hours || hours.from === hours.to) return true;
  const t = istParts(at).minuteOfDay;
  return hours.from < hours.to ? t >= hours.from && t < hours.to : t >= hours.from || t < hours.to;
}

export interface SchedulerOptions {
  openHours?: OpenHours | null;
  intervalMs?: number;
  clock?: SchedulerClock;
  /** Told about failed automatic snapshots (they are retried at the next check). */
  onError?: (err: Error) => void;
}

export class SnapshotScheduler {
  private readonly clock: SchedulerClock;
  private readonly intervalMs: number;
  private readonly openHours: OpenHours | null;
  private timer: unknown = null;
  private running: Promise<void> = Promise.resolve();
  /** changeSeq covered by the last snapshot; -1 = take one at the first check if anything is unsaved. */
  private snapshotSeq: number;
  private started = false;

  constructor(
    private readonly target: SnapshotTarget,
    private readonly options: SchedulerOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.intervalMs = options.intervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.openHours = options.openHours ?? null;
    this.snapshotSeq = target.changeSeq;
  }

  /**
   * Starts the timer. `pendingChanges` (e.g. journal entries replayed at
   * startup) makes the first check snapshot even before any new change.
   */
  start(pendingChanges = false): void {
    if (this.started) return;
    this.started = true;
    if (pendingChanges) this.snapshotSeq = -1;
    this.arm();
  }

  stop(): void {
    this.started = false;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves when no check or snapshot is running. */
  whenIdle(): Promise<void> {
    return this.running;
  }

  /** Changes committed since the last snapshot. */
  get dirty(): boolean {
    return this.target.changeSeq !== this.snapshotSeq;
  }

  /** Takes a snapshot now regardless of changes (day close) and restarts the 15-minute wait. */
  async snapshotNow(reason: SnapshotReason): Promise<unknown> {
    const seq = this.target.changeSeq;
    const result = await this.target.snapshot(reason, this.clock.now());
    this.snapshotSeq = seq;
    if (this.started) this.arm();
    return result;
  }

  private arm(delayMs = this.intervalMs): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.running = this.check();
    }, Math.max(0, delayMs));
  }

  private async check(): Promise<void> {
    const now = this.clock.now();
    try {
      if (this.dirty && isOpen(this.openHours, now)) {
        const seq = this.target.changeSeq;
        await this.target.snapshot('auto', now);
        this.snapshotSeq = seq;
      }
    } catch (err) {
      this.options.onError?.(err as Error);
    } finally {
      // Measured from the check itself, so a slow save never stretches the 15 minutes.
      if (this.started && this.timer === null) this.arm(this.intervalMs - (this.clock.now().getTime() - now.getTime()));
    }
  }
}
