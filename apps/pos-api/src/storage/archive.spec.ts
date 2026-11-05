import fs from 'fs';
import path from 'path';
import { ARCHIVED_SHEETS } from '@dhaba/shared';
import { seededData, tempDir } from '../../test/fixtures';
import { addClosedOrders } from '../../test/support/month-rows';
import { Commit, MonthlyArchiver, isLastDayOfMonth, listArchiveParts, monthsToArchive, selectMonth } from './archive';
import { counterKeys } from './repository';
import { StorageService, WORKBOOK_FILE } from './storage.service';
import { WorkbookData, emptyData } from './workbook-codec';
import { ArchiveReadOnlyError, readWorkbookFile, writeWorkbookFile } from './workbook-file';
import { WorkbookStore } from './workbook-store';
import { Tx } from './write-queue';

const NOW = '2026-11-05T23:00:00.000+05:30';

async function openWith(data: WorkbookData): Promise<StorageService> {
  const dir = tempDir();
  await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
  const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
  await s.open();
  return s;
}

const archive = (s: StorageService, month: string) =>
  s.queue.exclusive((commit) => new MonthlyArchiver(s).archiveMonth(commit, month, 'ADM-1', NOW));

describe('monthly archive workbooks (REQ-108)', () => {
  const open: StorageService[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });
  const track = (s: StorageService) => (open.push(s), s);

  it('REQ-108: month end is the last calendar day; earlier months are always due', () => {
    expect(isLastDayOfMonth('2026-11-30')).toBe(true);
    expect(isLastDayOfMonth('2026-11-29')).toBe(false);
    expect(isLastDayOfMonth('2028-02-29')).toBe(true);
    const data = seededData(); // November orders and audit rows
    addClosedOrders(data, '2026-10-12', 1);
    const store = new WorkbookStore(data);
    expect(monthsToArchive(store, '2026-11-05')).toEqual(['2026-10']);
    expect(monthsToArchive(store, '2026-11-30')).toEqual(['2026-10', '2026-11']);
  });

  it('REQ-108: moves the month into a read-only archive/YYYY-MM.xlsx, verifies counts, then removes the rows from live', async () => {
    const data = seededData();
    const octIds = addClosedOrders(data, '2026-10-12', 3);
    const s = track(await openWith(data));
    const before = selectMonth(s.store, '2026-10');
    const result = await archive(s, '2026-10');

    expect(result.status).toBe('ARCHIVED');
    expect(result.pruned).toEqual({ orders: 3, kots: 3, order_items: 9, payments: 3, exceptions: 3, audit_log: 3 });
    const file = path.join(s.archiveDir, '2026-10.xlsx');
    expect(result.files).toEqual([file]);
    expect(fs.statSync(file).mode & 0o222).toBe(0);
    const archived = await readWorkbookFile(file);
    for (const sheet of ARCHIVED_SHEETS) expect(archived[sheet].length).toBe(before[sheet].length);
    expect(archived.orders.map((o) => o.id).sort()).toEqual(octIds.sort());
    // Gone from live, November untouched; an ARCHIVE audit row records it.
    for (const id of octIds) expect(s.store.get('orders', id)).toBeUndefined();
    expect(s.store.get('orders', 'ORD-20261105-0001')).toBeDefined();
    expect(s.store.all('audit_log').find((a) => a.action === 'ARCHIVE')?.entity_id).toBe('2026-10');
  });

  it('REQ-108: an attempt by the application to write to an archived month\'s file fails', async () => {
    const data = seededData();
    addClosedOrders(data, '2026-10-12', 1);
    const s = track(await openWith(data));
    await archive(s, '2026-10');
    const file = path.join(s.archiveDir, '2026-10.xlsx');
    const bytes = fs.readFileSync(file);
    await expect(writeWorkbookFile(file, s.store.toData(), 'x')).rejects.toBeInstanceOf(ArchiveReadOnlyError);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    // Even a read-only copy outside archive/ is refused.
    const copy = path.join(s.archiveDir, '..', 'copy.xlsx');
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o444);
    await expect(writeWorkbookFile(copy, s.store.toData(), 'x')).rejects.toBeInstanceOf(ArchiveReadOnlyError);
  });

  it('REQ-108: the prune is journaled, so a restart without a save keeps the rows out of live', async () => {
    const data = seededData();
    const ids = addClosedOrders(data, '2026-10-12', 2);
    const s = await openWith(data);
    const dir = path.dirname(s.workbookPath);
    await archive(s, '2026-10');
    s.close(); // no save: the live file still holds October
    const again = track(new StorageService({ dataDir: dir, sheetPassword: 'x' }));
    await again.open();
    expect(again.replayed).toBe(1);
    for (const id of ids) expect(again.store.get('orders', id)).toBeUndefined();
  });

  it('REQ-108: resumable — a run interrupted after the file is written prunes on the next run without rewriting', async () => {
    const data = seededData();
    const ids = addClosedOrders(data, '2026-10-12', 2);
    const s = track(await openWith(data));
    const archiver = new MonthlyArchiver(s);
    const crash: Commit = () => {
      throw new Error('power cut');
    };
    await expect(archiver.archiveMonth(crash, '2026-10', 'ADM-1', NOW)).rejects.toThrow('power cut');
    expect(s.store.get('orders', ids[0])).toBeDefined();
    const written = fs.statSync(path.join(s.archiveDir, '2026-10.xlsx')).mtimeMs;

    const result = await archive(s, '2026-10');
    expect(result.status).toBe('ARCHIVED');
    expect(result.files).toEqual([]);
    expect(result.pruned.orders).toBe(2);
    expect(listArchiveParts(s.archiveDir, '2026-10').map((p) => p.name)).toEqual(['2026-10.xlsx']);
    expect(fs.statSync(path.join(s.archiveDir, '2026-10.xlsx')).mtimeMs).toBe(written);
    expect(s.store.get('orders', ids[0])).toBeUndefined();
  });

  it('REQ-108: rows of a month that arrive after its archive go into the next part', async () => {
    const data = seededData();
    addClosedOrders(data, '2026-10-30', 1);
    const s = track(await openWith(data));
    await archive(s, '2026-10');
    const late = emptyData();
    const [lateId] = addClosedOrders(late, '2026-10-31', 1);
    await s.queue.run((tx) => {
      for (const sheet of ARCHIVED_SHEETS) for (const r of late[sheet]) tx.insert(sheet, r as never);
    });
    const result = await archive(s, '2026-10');
    expect(result.files.map((f) => path.basename(f))).toEqual(['2026-10-2.xlsx']);
    expect((await readWorkbookFile(result.files[0])).orders.map((o) => o.id)).toEqual([lateId]);
    expect(await archive(s, '2026-10')).toMatchObject({ status: 'NOTHING_TO_ARCHIVE', files: [] });
  });

  it('REQ-108: after a month-end archive the live workbook is under 15 MB and holds none of the month', async () => {
    const data = seededData();
    addClosedOrders(data, '2026-10-15', 1500, 4);
    const s = track(await openWith(data));
    const sizeBefore = fs.statSync(s.workbookPath).size;
    await archive(s, '2026-10');
    await s.save();
    const sizeAfter = fs.statSync(s.workbookPath).size;
    expect(sizeAfter).toBeLessThan(15 * 1024 * 1024);
    expect(sizeAfter).toBeLessThan(sizeBefore / 5);
    const live = await readWorkbookFile(s.workbookPath);
    expect(live.orders.some((o) => o.business_date.startsWith('2026-10'))).toBe(false);
    expect((await readWorkbookFile(path.join(s.archiveDir, '2026-10.xlsx'))).order_items.length).toBe(6000);
  }, 60_000);
});

describe('business-day counters (REQ-096)', () => {
  it('REQ-096: KOT numbers restart at 1 after the cut-off', () => {
    const data = seededData(); // KOT:2026-11-05 already at 2
    const store = new WorkbookStore(data);
    const before = new Tx(store, '2026-11-06T03:59:00.000+05:30');
    expect(before.nextCounter(counterKeys.kot(before.businessDate()))).toBe(2);
    const after = new Tx(store, '2026-11-06T04:01:00.000+05:30');
    expect(after.businessDate()).toBe('2026-11-06');
    expect(after.nextCounter(counterKeys.kot(after.businessDate()))).toBe(1);
    expect(after.nextCounter(counterKeys.token(after.businessDate()))).toBe(1);
  });
});
