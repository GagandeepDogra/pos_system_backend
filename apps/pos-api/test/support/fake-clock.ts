import { SchedulerClock } from '../../src/storage/snapshot-scheduler';

/** A manual clock for scheduler tests: time moves only through `advance`. */
export class FakeClock implements SchedulerClock {
  private t: number;
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private nextId = 1;

  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  /**
   * Moves time forward by `ms`, firing due timers in order. After each timer
   * `settle` is awaited (e.g. the scheduler's whenIdle) so async work started
   * by the timer finishes at that instant of fake time.
   */
  async advance(ms: number, settle: () => Promise<unknown> = async () => undefined): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
      await settle();
    }
    this.t = end;
  }
}
