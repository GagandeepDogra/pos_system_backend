import fs from 'fs';
import path from 'path';
import { sampleData, seededData, tempDir } from '../../test/fixtures';
import { openTakeaway, recordPayment, sendKot } from '../../test/support/pos-ops';
import { RowVersionConflictError, WritesBlockedError } from '../common/errors';
import { JOURNAL_FILE, Journal, JournalCorruptError, JournalWriteError, encodeEntry, readJournal } from './journal';
import { migrateWorkbook, readSchemaVersion } from './migrations';
import { BACKUP_DIR, StorageService, WORKBOOK_FILE } from './storage.service';
import { writeWorkbookFile } from './workbook-file';
import { buildWorkbook } from './workbook-codec';
import ExcelJS from 'exceljs';

const seeded = seededData;

async function openSample(dir = tempDir()): Promise<StorageService> {
  if (!fs.existsSync(path.join(dir, WORKBOOK_FILE))) await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seeded(), 'x');
  const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
  await s.open();
  return s;
}

/** Simulates a crash: drop memory and the lock without saving the workbook. */
function crash(s: StorageService): string {
  const dir = path.dirname(s.workbookPath);
  s.close();
  return dir;
}

afterEach(() => jest.restoreAllMocks());

describe('write journal (REQ-106, REQ-129)', () => {
  it('appends fsynced lines and reads them back in order', () => {
    const file = path.join(tempDir(), JOURNAL_FILE);
    const j = new Journal(file);
    expect(j.open(5)).toEqual([]);
    const e = j.append([{ t: 'i', s: 'categories', r: { id: 'C' } }], 'now');
    expect(e.seq).toBe(6);
    j.append([], 'now');
    j.close();
    expect(readJournal(file).entries.map((x) => x.seq)).toEqual([6, 7]);
  });

  it('REQ-129: a torn last line (power cut mid-write) is dropped and cut off', () => {
    const file = path.join(tempDir(), JOURNAL_FILE);
    const whole = encodeEntry({ seq: 1, at: 'a', ops: [] });
    const torn = encodeEntry({ seq: 2, at: 'b', ops: [] });
    fs.writeFileSync(file, whole + torn.slice(0, 20));
    const j = new Journal(file);
    expect(j.open(0).map((e) => e.seq)).toEqual([1]);
    expect(fs.statSync(file).size).toBe(Buffer.byteLength(whole));
    expect(j.append([], 'c').seq).toBe(2);
    j.close();
    expect(readJournal(file).entries.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('refuses a journal damaged in the middle or out of order', () => {
    const file = path.join(tempDir(), JOURNAL_FILE);
    const a = encodeEntry({ seq: 1, at: 'a', ops: [] });
    fs.writeFileSync(file, a.replace('"at":"a"', '"at":"x"') + encodeEntry({ seq: 2, at: 'b', ops: [] }));
    expect(() => readJournal(file)).toThrow(JournalCorruptError);
    fs.writeFileSync(file, encodeEntry({ seq: 2, at: 'b', ops: [] }) + a);
    expect(() => readJournal(file)).toThrow(JournalCorruptError);
  });

  it('compacts entries up to a sequence and keeps numbering', () => {
    const file = path.join(tempDir(), JOURNAL_FILE);
    const j = new Journal(file);
    j.open(0);
    for (let i = 0; i < 3; i++) j.append([], 'now');
    j.compact(2);
    expect(readJournal(file).entries.map((e) => e.seq)).toEqual([3]);
    expect(j.append([], 'now').seq).toBe(4);
    j.close();
    expect(() => j.append([], 'now')).toThrow(JournalWriteError);
  });
});

describe('write queue (REQ-106, REQ-065)', () => {
  it('REQ-106: runs one change at a time, in order', async () => {
    const s = await openSample();
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((k) =>
        s.queue.run((tx) => {
          seen.push(`start ${k}`);
          tx.nextCounter('X');
          seen.push(`end ${k}`);
        }),
      ),
    );
    expect(seen).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
    expect(s.store.findUnique('counters', 'counter_key', 'X')!.next_value).toBe(4);
    s.close();
  });

  it('REQ-106: success is returned only after the journal line is fsynced to disk', async () => {
    const s = await openSample();
    const calls: string[] = [];
    const fsync = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => void calls.push('fsync'));
    const p = await openTakeaway(s.queue, 'k-fsync').then((r) => {
      calls.push('reply');
      return r;
    });
    fsync.mockRestore();
    expect(calls).toEqual(['fsync', 'reply']);
    const onDisk = readJournal(s.journal.file).entries.at(-1)!;
    expect(onDisk.ops.find((o) => o.s === 'orders')!.r.id).toBe(p.row.id);
    s.close();
  });

  it('REQ-117: a failed journal write changes nothing, answers 503 and turns health red', async () => {
    const s = await openSample();
    const before = s.store.count('orders');
    const write = jest.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    await expect(openTakeaway(s.queue, 'k-full')).rejects.toMatchObject({ status: 503 });
    write.mockRestore();
    expect(s.store.count('orders')).toBe(before);
    expect(s.store.findUnique('counters', 'counter_key', 'ORDER')!.next_value).toBe(2);
    expect(s.lastJournalError).toMatch(/ENOSPC/);
    await openTakeaway(s.queue, 'k-after');
    expect(s.lastJournalError).toBeNull();
    s.close();
  });

  it('rolls back every row of a change that throws, and refuses async changes', async () => {
    const s = await openSample();
    const cat = s.store.get('categories', 'CAT-1')!;
    await expect(
      s.queue.run((tx) => {
        tx.replace('categories', { ...cat, name_en: 'Changed' });
        tx.nextCounter('Y');
        throw new Error('rule failed');
      }),
    ).rejects.toThrow('rule failed');
    expect(s.store.get('categories', 'CAT-1')!.name_en).toBe('Main Course');
    expect(s.store.findUnique('counters', 'counter_key', 'Y')).toBeUndefined();
    await expect(s.queue.run(async () => 1)).rejects.toThrow(/synchronous/);
    expect(s.journal.lastSeq).toBe(0);
    s.close();
  });

  it('REQ-113: a row_version mismatch is a 409 carrying the current row', async () => {
    const s = await openSample();
    const err = (await s.queue
      .run((tx) => tx.expectVersion('orders', 'ORD-20261105-0001', 7))
      .catch((e: unknown) => e)) as RowVersionConflictError;
    expect(err).toBeInstanceOf(RowVersionConflictError);
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as { details: { current: { row_version: number } } }).details.current.row_version).toBe(1);
    await expect(s.queue.run((tx) => tx.expectVersion('orders', 'nope', 1))).rejects.toMatchObject({ status: 404 });
    await expect(s.queue.run((tx) => tx.replace('orders', { id: 'nope' } as never))).rejects.toMatchObject({ status: 404 });
    s.close();
  });

  it('REQ-065: a repeated idempotency key returns the stored row without enqueuing', async () => {
    const s = await openSample();
    const first = await openTakeaway(s.queue, 'k-1');
    expect(first.replayed).toBe(false);
    const run = jest.spyOn(s.queue, 'run');
    const again = await openTakeaway(s.queue, 'k-1');
    expect(run).not.toHaveBeenCalled();
    expect(again).toEqual({ replayed: true, row: first.row });
    s.close();
  });

  it('REQ-065: two requests with the same key create one Payments row; the repeat gets the original', async () => {
    const s = await openSample();
    const [a, b] = await Promise.all([
      recordPayment(s.queue, 'ORD-20261105-0001', 'pay-1', '50.00'),
      recordPayment(s.queue, 'ORD-20261105-0001', 'pay-1', '50.00'),
    ]);
    expect(s.store.all('payments')).toHaveLength(1);
    expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect(b.row).toEqual(a.row);
    expect(s.store.get('orders', 'ORD-20261105-0001')!.balance_due).toBe('70.00');
    s.close();
  });

  it('refuses writes while loading or with a corrupt workbook', async () => {
    const s = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await expect(s.queue.run(() => 1)).rejects.toBeInstanceOf(WritesBlockedError);
    expect(() => s.store).toThrow('not loaded');
  });
});

describe('startup replay (REQ-105, REQ-129)', () => {
  it('REQ-105: journalled changes not yet saved appear after a crash and restart', async () => {
    const s = await openSample();
    const order = await openTakeaway(s.queue, 'k-crash');
    await sendKot(s.queue, order.row.id, 'kot-crash', [{ variantId: 'VAR-1', qty: 2 }]);
    const pay = await recordPayment(s.queue, order.row.id, 'pay-crash', '440.00');
    const dir = crash(s);

    const again = await openSample(dir);
    expect(again.replayed).toBe(3);
    expect(again.store.get('payments', pay.row.id)).toEqual(pay.row);
    expect(again.store.get('orders', order.row.id)!.status).toBe('PAID');
    // The replay was saved, so the workbook now includes seq 3 and nothing replays twice.
    expect(again.store.get('meta', 'META')!.last_journal_seq).toBe(3);
    const third = await openSample(crash(again));
    expect(third.replayed).toBe(0);
    expect(third.store.all('payments')).toHaveLength(1);
    expect(third.journal.lastSeq).toBe(3);
    third.close();
  });

  it('REQ-129: a power cut during a payment write leaves the payment fully present or absent', async () => {
    const s = await openSample();
    await recordPayment(s.queue, 'ORD-20261105-0001', 'pay-ok', '20.00');
    const dir = crash(s);
    const journalFile = path.join(dir, JOURNAL_FILE);
    const full = fs.readFileSync(journalFile);
    // Every possible cut point inside the last line: the payment is either whole or missing.
    const lastStart = full.lastIndexOf(0x0a, full.length - 2) + 1;
    for (const cut of [lastStart, lastStart + 10, Math.floor((lastStart + full.length) / 2), full.length - 1, full.length]) {
      fs.writeFileSync(journalFile, full.subarray(0, cut));
      const r = await openSample(dir);
      const pays = r.store.all('payments');
      const order = r.store.get('orders', 'ORD-20261105-0001')!;
      if (cut === full.length) {
        expect(pays).toHaveLength(1);
        expect(order.paid_amount).toBe('20.00');
      } else {
        expect(pays).toHaveLength(0);
        expect(order.paid_amount).toBe('0.00');
      }
      r.close();
      await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seeded(), 'x');
    }
  });

  it('save records the journal sequence; compaction keeps numbering past it', async () => {
    const s = await openSample();
    await openTakeaway(s.queue, 'k-s1');
    await s.save();
    s.journal.compact(s.journal.lastSeq);
    const dir = crash(s);
    const again = await openSample(dir);
    expect(again.journal.lastSeq).toBe(1);
    expect((await openTakeaway(again.queue, 'k-s2')).row.id).toBe('ORD-20261105-0003');
    expect(again.journal.lastSeq).toBe(2);
    again.close();
  });

  it('refuses to start with a journal damaged in the middle, releasing the lock', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, JOURNAL_FILE), 'garbage\n' + encodeEntry({ seq: 1, at: 'a', ops: [] }));
    const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await expect(s.open()).rejects.toThrow(JournalCorruptError);
    expect(fs.existsSync(path.join(dir, '.pos-api.lock'))).toBe(false);
  });
});

describe('corrupt workbook (REQ-105, REQ-110)', () => {
  it('blocks writes and offers the newest valid backup plus journal replay', async () => {
    const s = await openSample();
    await openTakeaway(s.queue, 'k-before-backup');
    await s.save();
    fs.mkdirSync(path.join(s.backupDir), { recursive: true });
    fs.copyFileSync(s.workbookPath, path.join(s.backupDir, 'snap-1.xlsx'));
    fs.writeFileSync(path.join(s.backupDir, 'snap-2-broken.xlsx'), 'not a zip');
    fs.utimesSync(path.join(s.backupDir, 'snap-2-broken.xlsx'), new Date(), new Date(Date.now() + 1000));
    const after = await openTakeaway(s.queue, 'k-after-backup');
    const pay = await recordPayment(s.queue, 'ORD-20261105-0001', 'pay-after-backup', '10.00');
    const dir = crash(s);
    fs.writeFileSync(path.join(dir, WORKBOOK_FILE), 'this is not an xlsx');

    const broken = await openSample(dir);
    expect(broken.state).toBe('corrupt');
    expect(broken.loaded).toBe(false);
    expect(broken.recoveryOffer).toMatchObject({
      backup: path.join(dir, BACKUP_DIR, 'snap-1.xlsx'),
      backup_journal_seq: 1,
      journal_entries_to_replay: 2,
    });
    await expect(openTakeaway(broken.queue, 'k-blocked')).rejects.toBeInstanceOf(WritesBlockedError);

    const r = await broken.recoverFromBackup();
    expect(r.replayed).toBe(2);
    expect(fs.existsSync(r.corruptCopy!)).toBe(true);
    expect(broken.store.get('orders', after.row.id)).toBeDefined();
    expect(broken.store.get('payments', pay.row.id)).toEqual(pay.row);
    await expect(broken.recoverFromBackup()).rejects.toThrow('not corrupt');
    const reopened = await openSample(crash(broken));
    expect(reopened.state).toBe('ready');
    expect(reopened.store.count('orders')).toBe(3);
    reopened.close();
  });

  it('treats an invalid workbook or a missing one with journal entries as corrupt', async () => {
    const dir = tempDir();
    const bad = sampleData();
    bad.orders[0].status = 'DONE' as never;
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), bad, 'x');
    const s = await openSample(dir);
    expect(s.state).toBe('corrupt');
    expect(s.recoveryOffer!.backup).toBeNull();
    await expect(s.recoverFromBackup()).rejects.toThrow('no valid backup');
    s.close();

    const dir2 = tempDir();
    fs.writeFileSync(path.join(dir2, JOURNAL_FILE), encodeEntry({ seq: 1, at: 'a', ops: [] }));
    const s2 = new StorageService({ dataDir: dir2, sheetPassword: 'x' });
    await s2.open();
    expect(s2.state).toBe('corrupt');
    expect(s2.recoveryOffer!.journal_entries_to_replay).toBe(1);
    s2.close();
  });
});

describe('startup migration (REQ-105)', () => {
  async function v0File(dir: string): Promise<void> {
    const data = sampleData();
    data.meta[0].schema_version = 0;
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
  }

  it('runs pending migrations on a copy, keeps the original in backups/ and saves the result', async () => {
    const dir = tempDir();
    await v0File(dir);
    const step = jest.fn();
    const s = new StorageService({ dataDir: dir, sheetPassword: 'x', migrations: { 0: step } });
    await s.open();
    expect(step).toHaveBeenCalledTimes(1);
    expect(s.state).toBe('ready');
    expect(s.migratedFrom).toBe(0);
    const backups = fs.readdirSync(path.join(dir, BACKUP_DIR));
    expect(backups).toEqual([expect.stringMatching(/^pre-migration-v0-.*\.xlsx$/)]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(s.workbookPath);
    expect(readSchemaVersion(wb)).toBe(1);
    s.close();
  });

  it('refuses a version with no migration path or a newer file, leaving the file untouched', async () => {
    const dir = tempDir();
    await v0File(dir);
    const before = fs.readFileSync(path.join(dir, WORKBOOK_FILE));
    const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await s.open();
    expect(s.state).toBe('corrupt');
    expect(s.recoveryOffer!.errors[0]).toMatch(/no migration from schema_version 0/);
    expect(fs.readFileSync(path.join(dir, WORKBOOK_FILE)).equals(before)).toBe(true);
    s.close();

    const data = sampleData();
    data.meta[0].schema_version = 9;
    const wb = await buildWorkbook(data, 'x');
    expect(() => migrateWorkbook(wb)).toThrow(/newer than this server/);
  });
});
