import fs from 'fs';
import path from 'path';
import { seededData, tempDir } from '../../test/fixtures';
import { FakeClock } from '../../test/support/fake-clock';
import { openTakeaway } from '../../test/support/pos-ops';
import { loadConfig } from '../config';
import { HealthController } from '../health/health.controller';
import {
  BackupFolder,
  DAY_MS,
  SnapshotFile,
  SnapshotReason,
  istParts,
  parseSnapshotName,
  retentionPlan,
  snapshotName,
} from './backup-folder';
import { readJournal } from './journal';
import { SNAPSHOT_INTERVAL_MS, SnapshotScheduler, SnapshotTarget, isOpen, parseOpenHours } from './snapshot-scheduler';
import { StorageService, WORKBOOK_FILE } from './storage.service';
import { writeWorkbookFile } from './workbook-file';

const MIN = 60_000;
const NOW = new Date('2026-11-05T23:30:00+05:30');

function snap(at: Date, reason: SnapshotReason = 'auto'): SnapshotFile {
  const name = snapshotName(at, reason);
  return { ...parseSnapshotName(name)!, file: name };
}

/** Auto snapshots every 15 minutes, 10:00–23:00 IST, plus a 23:15 day-close, for `days` days before NOW. */
function history(days: number): SnapshotFile[] {
  const out: SnapshotFile[] = [];
  for (let d = 0; d <= days; d++) {
    const day = new Date(new Date('2026-11-05T00:00:00+05:30').getTime() - d * DAY_MS);
    for (let m = 10 * 60; m <= 23 * 60; m += 15) out.push(snap(new Date(day.getTime() + m * MIN)));
    out.push(snap(new Date(day.getTime() + (23 * 60 + 15) * MIN), 'day-close'));
  }
  return out;
}

async function openStorage(dir = tempDir()): Promise<StorageService> {
  await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seededData(), 'x');
  const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
  await s.open();
  return s;
}

describe('snapshot file names (REQ-109)', () => {
  it('REQ-109: names carry the IST time and reason and parse back', () => {
    const at = new Date('2026-11-05T09:00:05Z'); // 14:30:05 IST
    expect(snapshotName(at, 'auto')).toBe('snapshot-20261105-143005-auto.xlsx');
    expect(snapshotName(at, 'day-close', 2)).toBe('snapshot-20261105-143005-day-close-2.xlsx');
    const parsed = parseSnapshotName('snapshot-20261105-143005-day-close-2.xlsx')!;
    expect(parsed.at.getTime()).toBe(at.getTime());
    expect(parsed).toMatchObject({ day: '2026-11-05', reason: 'day-close' });
    expect(istParts(at).minuteOfDay).toBe(14 * 60 + 30);
  });

  it('REQ-109: other files in backups/ are not snapshots', () => {
    expect(parseSnapshotName('pre-migration-v1-2026-11-05T10-00-00.xlsx')).toBeNull();
    expect(parseSnapshotName('snapshot-20261105-143005-weird.xlsx')).toBeNull();
    expect(parseSnapshotName('snapshot-20261399-143005-auto.xlsx')).toBeNull();
    expect(parseSnapshotName('.snapshot-20261105-143005-auto.xlsx.12.tmp')).toBeNull();
  });
});

describe('retention policy (REQ-109, REQ-130)', () => {
  const all = history(400);
  const plan = retentionPlan(all, NOW);
  const ageDays = (s: SnapshotFile) => (NOW.getTime() - s.at.getTime()) / DAY_MS;

  it('REQ-130: every snapshot of the last 30 days is kept, so one from 29 days ago is still available', () => {
    const recent = all.filter((s) => ageDays(s) <= 30);
    expect(recent.length).toBeGreaterThan(30 * 50);
    for (const s of recent) expect(plan.keep).toContain(s);
    const twentyNine = all.filter((s) => s.day === '2026-10-07');
    expect(twentyNine.length).toBe(54);
    expect(twentyNine.every((s) => plan.keep.includes(s))).toBe(true);
  });

  it('REQ-109: snapshots older than 30 days are pruned to one per day, preferring the day-close one', () => {
    const old = plan.keep.filter((s) => ageDays(s) > 30);
    const days = old.map((s) => s.day);
    expect(new Set(days).size).toBe(days.length);
    expect(old.every((s) => s.reason === 'day-close')).toBe(true);
    // Every day between 31 and 365 days old still has its one snapshot.
    const expectedDays = new Set(all.filter((s) => ageDays(s) > 30 && ageDays(s) <= 365).map((s) => s.day));
    expect(new Set(days)).toEqual(expectedDays);
  });

  it('REQ-109: without a day-close snapshot the newest of that day is kept', () => {
    const day = '2026-08-01';
    const autos = all.filter((s) => s.day === day && s.reason === 'auto');
    const p = retentionPlan(autos, NOW);
    expect(p.keep).toEqual([autos.at(-1)]);
    expect(p.remove).toHaveLength(autos.length - 1);
  });

  it('REQ-109: daily snapshots older than 1 year are removed', () => {
    expect(plan.keep.every((s) => ageDays(s) <= 365)).toBe(true);
    const ancient = all.filter((s) => ageDays(s) > 365);
    expect(ancient.length).toBeGreaterThan(0);
    for (const s of ancient) expect(plan.remove).toContain(s);
    expect(plan.keep.length + plan.remove.length).toBe(all.length);
  });

  it('REQ-109: pruning deletes only snapshot files from the folder', async () => {
    const dir = tempDir();
    const folder = new BackupFolder(dir);
    const files = [
      snap(new Date(NOW.getTime() - 29 * DAY_MS)),
      snap(new Date(NOW.getTime() - 40 * DAY_MS)),
      snap(new Date(NOW.getTime() - 40 * DAY_MS + 15 * MIN)),
      snap(new Date(NOW.getTime() - 400 * DAY_MS), 'day-close'),
    ];
    for (const f of files) fs.writeFileSync(path.join(dir, f.name), '');
    fs.writeFileSync(path.join(dir, 'pre-migration-v1-old.xlsx'), '');
    const removed = await folder.prune(NOW);
    expect(removed.map((s) => s.name).sort()).toEqual([files[1].name, files[3].name].sort());
    expect(fs.readdirSync(dir).sort()).toEqual([files[0].name, files[2].name, 'pre-migration-v1-old.xlsx'].sort());
    expect(new BackupFolder(path.join(dir, 'missing')).list()).toEqual([]);
  });
});

describe('open hours', () => {
  it('REQ-130: parses HH:mm-HH:mm in IST, including past midnight', () => {
    expect(parseOpenHours(undefined)).toBeNull();
    expect(parseOpenHours(' ')).toBeNull();
    const day = parseOpenHours('10:00-23:00')!;
    expect(isOpen(day, new Date('2026-11-05T09:59:00+05:30'))).toBe(false);
    expect(isOpen(day, new Date('2026-11-05T10:00:00+05:30'))).toBe(true);
    expect(isOpen(day, new Date('2026-11-05T23:00:00+05:30'))).toBe(false);
    const late = parseOpenHours('18:00-02:00')!;
    expect(isOpen(late, new Date('2026-11-06T01:30:00+05:30'))).toBe(true);
    expect(isOpen(late, new Date('2026-11-06T03:00:00+05:30'))).toBe(false);
    expect(isOpen(null, NOW)).toBe(true);
    expect(isOpen(parseOpenHours('00:00-00:00'), NOW)).toBe(true);
    expect(() => parseOpenHours('10-23')).toThrow(/look like/);
    expect(() => parseOpenHours('25:00-23:00')).toThrow(/out of range/);
    expect(loadConfig({ SNAPSHOT_OPEN_HOURS: '10:00-23:00' }).snapshotOpenHours).toEqual({ from: 600, to: 1380 });
    expect(loadConfig({}).snapshotOpenHours).toBeNull();
  });
});

class FakeTarget implements SnapshotTarget {
  changeSeq = 0;
  taken: { at: Date; reason: SnapshotReason; seq: number }[] = [];
  failNext = false;
  constructor(private readonly clock: FakeClock) {}
  async snapshot(reason: SnapshotReason, at: Date) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk full');
    }
    this.taken.push({ at, reason, seq: this.changeSeq });
    return { at };
  }
  commit() {
    this.changeSeq++;
    return { at: this.clock.now(), seq: this.changeSeq };
  }
}

describe('snapshot scheduler with a fake clock (REQ-109, REQ-130)', () => {
  it('REQ-130: during open hours with changes, the gap between snapshots never exceeds 15 minutes', async () => {
    const clock = new FakeClock('2026-11-05T10:00:00+05:30');
    const target = new FakeTarget(clock);
    const sched = new SnapshotScheduler(target, { clock, openHours: parseOpenHours('10:00-23:00') });
    sched.start();
    const settle = () => sched.whenIdle();
    const commits: { at: Date; seq: number }[] = [];
    // A lunch and dinner rush: a change every 1–4 minutes, 12:00–15:00 and 19:00–22:30.
    let rand = 7;
    const next = () => (rand = (rand * 48271) % 2147483647) % 4;
    await clock.advance(120 * MIN, settle);
    for (const [from, to] of [[12 * 60, 15 * 60], [19 * 60, 22 * 60 + 30]]) {
      let t = istParts(clock.now()).minuteOfDay;
      if (t < from) await clock.advance((from - t) * MIN, settle);
      while ((t = istParts(clock.now()).minuteOfDay) < to) {
        commits.push(target.commit());
        await clock.advance((1 + next()) * MIN, settle);
      }
    }
    await clock.advance(3 * 60 * MIN, settle); // past closing

    const times = target.taken.map((x) => x.at.getTime());
    expect(times.length).toBeGreaterThan(20);
    // Never closer than 15 minutes, and while changes keep coming exactly 15 apart.
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(SNAPSHOT_INTERVAL_MS);
    // Every change reaches a snapshot within 15 minutes.
    for (const c of commits) {
      const covering = target.taken.find((x) => x.seq >= c.seq)!;
      expect(covering).toBeDefined();
      expect(covering.at.getTime() - c.at.getTime()).toBeLessThanOrEqual(SNAPSHOT_INTERVAL_MS);
    }
    // Within a rush the gaps are exactly 15 minutes.
    const lunch = target.taken.filter((x) => istParts(x.at).minuteOfDay > 12 * 60 + 15 && istParts(x.at).minuteOfDay <= 15 * 60);
    for (let i = 1; i < lunch.length; i++) expect(lunch[i].at.getTime() - lunch[i - 1].at.getTime()).toBe(SNAPSHOT_INTERVAL_MS);
    // No snapshot while nothing changed (10:00–12:00) or after the last change was captured.
    expect(target.taken[0].at.getTime()).toBeGreaterThan(commits[0].at.getTime());
    expect(target.taken.at(-1)!.seq).toBe(target.changeSeq);
    expect(target.taken.filter((x) => x.seq === target.changeSeq)).toHaveLength(1);
    sched.stop();
  });

  it('REQ-130: outside open hours changes wait for the next check inside open hours', async () => {
    const clock = new FakeClock('2026-11-05T22:50:00+05:30');
    const target = new FakeTarget(clock);
    const sched = new SnapshotScheduler(target, { clock, openHours: parseOpenHours('10:00-23:00') });
    sched.start();
    target.commit();
    await clock.advance(12 * 60 * MIN, () => sched.whenIdle()); // until 10:50 next day
    expect(target.taken).toHaveLength(1);
    expect(istParts(target.taken[0].at)).toMatchObject({ day: '2026-11-06' });
    expect(istParts(target.taken[0].at).minuteOfDay).toBeGreaterThanOrEqual(10 * 60);
    expect(istParts(target.taken[0].at).minuteOfDay).toBeLessThan(10 * 60 + 15);
  });

  it('REQ-109: day close always snapshots, even without changes, and restarts the 15-minute wait', async () => {
    const clock = new FakeClock('2026-11-05T23:00:00+05:30');
    const target = new FakeTarget(clock);
    const sched = new SnapshotScheduler(target, { clock });
    sched.start();
    await sched.snapshotNow('day-close');
    expect(target.taken.map((x) => x.reason)).toEqual(['day-close']);
    await clock.advance(10 * MIN, () => sched.whenIdle());
    target.commit();
    await clock.advance(4 * MIN, () => sched.whenIdle());
    expect(target.taken).toHaveLength(1); // 14 min after day close: not yet
    await clock.advance(1 * MIN, () => sched.whenIdle());
    expect(target.taken.map((x) => x.reason)).toEqual(['day-close', 'auto']);
    expect(target.taken[1].at.getTime() - target.taken[0].at.getTime()).toBe(SNAPSHOT_INTERVAL_MS);
    sched.stop();
    await sched.snapshotNow('day-close'); // works when stopped too
    expect(target.taken).toHaveLength(3);
  });

  it('REQ-109: a failed snapshot is reported and retried at the next check', async () => {
    const clock = new FakeClock('2026-11-05T12:00:00+05:30');
    const target = new FakeTarget(clock);
    const errors: string[] = [];
    const sched = new SnapshotScheduler(target, { clock, onError: (e) => errors.push(e.message) });
    sched.start();
    sched.start(); // idempotent
    target.commit();
    target.failNext = true;
    await clock.advance(15 * MIN, () => sched.whenIdle());
    expect(errors).toEqual(['disk full']);
    expect(sched.dirty).toBe(true);
    await clock.advance(15 * MIN, () => sched.whenIdle());
    expect(target.taken).toHaveLength(1);
    expect(sched.dirty).toBe(false);
    sched.stop();
  });

  it('REQ-105: changes replayed at startup are snapshotted at the first check', async () => {
    const clock = new FakeClock('2026-11-05T12:00:00+05:30');
    const target = new FakeTarget(clock);
    target.changeSeq = 40;
    const sched = new SnapshotScheduler(target, { clock });
    sched.start(true);
    await clock.advance(15 * MIN, () => sched.whenIdle());
    expect(target.taken.map((x) => x.seq)).toEqual([40]);
    sched.stop();
  });
});

describe('backup service on a real data folder (REQ-109, REQ-130)', () => {
  it('REQ-109: snapshots copy the saved workbook, verify it and keep it findable for recovery', async () => {
    const s = await openStorage();
    await openTakeaway(s.queue, 'k1');
    expect(s.lastSavedSeq).toBe(0); // not saved yet: the snapshot must flush first
    const first = await s.backups.snapshot('auto', new Date('2026-11-05T12:15:00+05:30'));
    expect(first.name).toBe('snapshot-20261105-121500-auto.xlsx');
    expect(first.journal_seq).toBe(1);
    expect(s.lastSavedSeq).toBe(1);
    expect(fs.readdirSync(s.backupDir).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect((await s.findNewestValidBackup())!.file).toBe(first.file);

    // Same second twice gets a numbered name; no save is needed when nothing changed.
    const save = jest.spyOn(s, 'save');
    const again = await s.backups.snapshot('auto', new Date('2026-11-05T12:15:00+05:30'));
    expect(again.name).toBe('snapshot-20261105-121500-auto-2.xlsx');
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();

    const body = new HealthController(s).getHealth();
    expect(body.backups).toEqual({
      last_snapshot: again.name,
      last_snapshot_at: '2026-11-05T12:15:00.000+05:30',
      last_snapshot_error: null,
    });
    s.close();
  });

  it('REQ-109: the journal is compacted only up to the previous verified snapshot', async () => {
    const s = await openStorage();
    const journalSeqs = () => readJournal(s.journal.file).entries.map((e) => e.seq);
    await openTakeaway(s.queue, 'k1');
    await s.backups.snapshot('auto', new Date('2026-11-05T12:00:00+05:30'));
    await openTakeaway(s.queue, 'k2');
    expect(journalSeqs()).toEqual([1, 2]);
    await s.backups.snapshot('auto', new Date('2026-11-05T12:15:00+05:30'));
    expect(journalSeqs()).toEqual([2]); // seq 1 is in both snapshots; seq 2 stays as slack
    await openTakeaway(s.queue, 'k3');
    expect(journalSeqs()).toEqual([2, 3]);
    s.close();
  });

  it('REQ-109: a snapshot that fails verification is deleted and the error recorded', async () => {
    const s = await openStorage();
    jest.spyOn(s.backups.folder, 'copyIn').mockImplementationOnce(async (_src, at, reason) => {
      const name = snapshotName(at, reason);
      fs.mkdirSync(s.backupDir, { recursive: true });
      fs.writeFileSync(path.join(s.backupDir, name), 'not a workbook');
      return { ...parseSnapshotName(name)!, file: path.join(s.backupDir, name) };
    });
    await expect(s.backups.snapshot('auto', NOW)).rejects.toThrow(/failed verification/);
    expect(fs.readdirSync(s.backupDir)).toEqual([]);
    expect(s.backups.lastSnapshotError).toMatch(/failed verification/);
    expect(new HealthController(s).getHealth().status).toBe('green');
    s.close();
    await expect(s.backups.snapshot('auto', NOW)).rejects.toThrow(/workbook is loading/);
  });

  it('REQ-109: day close snapshots through the scheduler and prunes old snapshots', async () => {
    const s = await openStorage();
    const folder = s.backups.folder;
    fs.mkdirSync(folder.dir, { recursive: true });
    const old = [
      snap(new Date(NOW.getTime() - 29 * DAY_MS)),
      snap(new Date(NOW.getTime() - 45 * DAY_MS)),
      snap(new Date(NOW.getTime() - 45 * DAY_MS - 60 * MIN), 'day-close'), // same IST day, earlier
      snap(new Date(NOW.getTime() - 366 * DAY_MS), 'day-close'),
    ];
    for (const f of old) fs.writeFileSync(path.join(folder.dir, f.name), '');
    const clock = new FakeClock(NOW);
    const sched = s.backups.startScheduler({ clock });
    expect(s.backups.startScheduler()).toBe(sched);
    const taken = await s.backups.dayCloseSnapshot();
    expect(taken.reason).toBe('day-close');
    expect(folder.list().map((f) => f.name)).toEqual([old[2].name, old[0].name, taken.name]);
    s.close();
    expect(s.backups.scheduler).toBeNull();
    const s2 = await openStorage();
    const plain = await s2.backups.dayCloseSnapshot(); // without a scheduler
    expect(plain.reason).toBe('day-close');
    s2.close();
  });

  it('REQ-130: a simulated service hour with the real folder leaves a snapshot every 15 minutes', async () => {
    const s = await openStorage();
    const clock = new FakeClock('2026-11-05T13:00:00+05:30');
    const backups = new (s.backups.constructor as new (st: StorageService, c: () => Date) => typeof s.backups)(s, () => clock.now());
    const sched = backups.startScheduler({ clock });
    for (let i = 0; i < 12; i++) {
      await openTakeaway(s.queue, `rush-${i}`);
      await clock.advance(5 * MIN, () => sched.whenIdle());
    }
    const names = backups.folder.list().map((f) => f.name);
    expect(names).toEqual([
      'snapshot-20261105-131500-auto.xlsx',
      'snapshot-20261105-133000-auto.xlsx',
      'snapshot-20261105-134500-auto.xlsx',
      'snapshot-20261105-140000-auto.xlsx',
    ]);
    backups.stopScheduler();
    s.close();
  });
});
