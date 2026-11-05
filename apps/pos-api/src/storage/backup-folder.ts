// The backups/ folder (REQ-109, REQ-130): snapshot files named by their IST
// time and reason, and the retention policy — keep every snapshot of the last
// 30 days, then one per day up to 1 year, then nothing. Only files named
// `snapshot-*.xlsx` are managed here; pre-migration copies are left alone.
import fs, { promises as fsp } from 'fs';
import path from 'path';
import { SNAPSHOT_REASONS, SnapshotReason } from '@dhaba/shared';

export type { SnapshotReason };

export const DAY_MS = 24 * 60 * 60_000;
/** Every snapshot younger than this is kept. */
export const KEEP_ALL_DAYS = 30;
/** Beyond KEEP_ALL_DAYS one snapshot per day is kept until this age. */
export const KEEP_DAILY_DAYS = 365;

export interface SnapshotFile {
  name: string;
  file: string;
  /** Moment the snapshot was taken. */
  at: Date;
  /** IST calendar day, YYYY-MM-DD. */
  day: string;
  reason: SnapshotReason;
}

const IST_OFFSET_MS = 330 * 60_000;
const NAME_RE = /^snapshot-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z-]+?)(?:-(\d+))?\.xlsx$/;

/** IST wall-clock parts of a moment. */
export function istParts(at: Date): { ymd: string; hms: string; day: string; minuteOfDay: number } {
  const iso = new Date(at.getTime() + IST_OFFSET_MS).toISOString(); // 2026-11-05T14:30:00.000Z in IST
  const day = iso.slice(0, 10);
  const hms = iso.slice(11, 19).replace(/:/g, '');
  return { ymd: day.replace(/-/g, ''), hms, day, minuteOfDay: Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) };
}

export function snapshotName(at: Date, reason: SnapshotReason, n = 1): string {
  const { ymd, hms } = istParts(at);
  return `snapshot-${ymd}-${hms}-${reason}${n > 1 ? `-${n}` : ''}.xlsx`;
}

/** Parses a snapshot file name; null for any other file. */
export function parseSnapshotName(name: string): Omit<SnapshotFile, 'file'> | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, reason] = m;
  if (!(SNAPSHOT_REASONS as readonly string[]).includes(reason)) return null;
  // The regex guarantees the shape; Date rejects impossible values like month 13.
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}+05:30`);
  if (Number.isNaN(at.getTime())) return null;
  return { name, at, day: `${y}-${mo}-${d}`, reason: reason as SnapshotReason };
}

export interface RetentionPlan {
  keep: SnapshotFile[];
  remove: SnapshotFile[];
}

/**
 * Decides which snapshots survive at `now`: all of the last 30 days; for older
 * days up to 1 year, one per IST day (that day's day-close snapshot, else its
 * newest); nothing older than 1 year.
 */
export function retentionPlan(snapshots: SnapshotFile[], now: Date): RetentionPlan {
  const keepAllFrom = now.getTime() - KEEP_ALL_DAYS * DAY_MS;
  const keepDailyFrom = now.getTime() - KEEP_DAILY_DAYS * DAY_MS;
  const keep: SnapshotFile[] = [];
  const remove: SnapshotFile[] = [];
  const byDay = new Map<string, SnapshotFile[]>();
  for (const s of snapshots) {
    const t = s.at.getTime();
    if (t >= keepAllFrom) keep.push(s);
    else if (t < keepDailyFrom) remove.push(s);
    else byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  }
  for (const group of byDay.values()) {
    const rank = (s: SnapshotFile) => (s.reason === 'day-close' ? 1 : 0);
    const best = group.reduce((a, b) => (rank(b) > rank(a) || (rank(b) === rank(a) && b.at > a.at) ? b : a));
    for (const s of group) (s === best ? keep : remove).push(s);
  }
  const byTime = (a: SnapshotFile, b: SnapshotFile) => a.at.getTime() - b.at.getTime() || a.name.localeCompare(b.name);
  return { keep: keep.sort(byTime), remove: remove.sort(byTime) };
}

export class BackupFolder {
  constructor(readonly dir: string) {}

  /** Snapshot files, oldest first. */
  list(): SnapshotFile[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: SnapshotFile[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      const parsed = parseSnapshotName(name);
      if (parsed) out.push({ ...parsed, file: path.join(this.dir, name) });
    }
    return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.name.localeCompare(b.name));
  }

  /**
   * Copies `source` into the folder as a new snapshot: copy to a temp name,
   * fsync, then rename, so a crash never leaves a half-copied snapshot.
   */
  async copyIn(source: string, at: Date, reason: SnapshotReason): Promise<SnapshotFile> {
    await fsp.mkdir(this.dir, { recursive: true });
    let n = 1;
    while (fs.existsSync(path.join(this.dir, snapshotName(at, reason, n)))) n++;
    const name = snapshotName(at, reason, n);
    const file = path.join(this.dir, name);
    const tmp = path.join(this.dir, `.${name}.${process.pid}.tmp`);
    try {
      await fsp.copyFile(source, tmp);
      const handle = await fsp.open(tmp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    return { ...parseSnapshotName(name)!, file };
  }

  /** Applies the retention policy; returns the removed snapshots. */
  async prune(now: Date): Promise<SnapshotFile[]> {
    const { remove } = retentionPlan(this.list(), now);
    for (const s of remove) await fsp.rm(s.file, { force: true });
    return remove;
  }
}
