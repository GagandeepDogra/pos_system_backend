import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { item, roti, rotiVariant, sampleData, tempDir } from '../../test/fixtures';
import { buildOrderLine } from '../billing/order-line';
import { hashPin, isValidPin, verifyPin } from '../auth/pin';
import { FolderLock, FolderLockedError, LOCK_FILE } from './folder-lock';
import { sheetDef } from './schema';
import { StorageService, WORKBOOK_FILE } from './storage.service';
import { WorkbookValidationError } from './workbook-codec';
import { writeWorkbookFile } from './workbook-file';
import { StoreConstraintError, WorkbookStore } from './workbook-store';

describe('in-memory workbook store (REQ-104)', () => {
  it('indexes rows by id, unique columns and foreign keys', () => {
    const store = new WorkbookStore(sampleData());
    expect(store.count('items')).toBe(2);
    expect(store.get('items', 'ITM-1')?.name_en).toBe('Butter Chicken');
    expect(store.findUnique('items', 'short_code', 'TR')?.id).toBe('ITM-2');
    expect(store.findUnique('orders', 'client_request_id', 'req-1')?.id).toBe('ORD-20261105-0001');
    expect(store.findUnique('orders', 'bill_no', 'B-1')).toBeUndefined();
    expect(store.findBy('variants', 'item_id', 'ITM-1').map((v) => v.id)).toEqual(['VAR-1']);
    expect(store.findBy('orders', 'status', 'OPEN')).toHaveLength(1);
    expect(store.findBy('order_items', 'order_id', 'nope')).toEqual([]);
    expect(() => store.findUnique('items', 'name_hi', 'x')).toThrow(/not a unique column/);
    expect(() => store.findBy('items', 'name_hi', 'x')).toThrow(/not an indexed column/);
  });

  it('rejects duplicate ids and unique values', () => {
    const store = new WorkbookStore(sampleData());
    expect(() => store.insert('items', { ...roti })).toThrow(StoreConstraintError);
    expect(() => store.insert('items', { ...roti, id: 'ITM-3' })).toThrow(/duplicate short_code "TR"/);
    expect(() => store.replace('items', { ...roti, id: 'ITM-9' })).toThrow(/no row ITM-9/);
    expect(() => store.replace('items', { ...roti, short_code: 'BC' })).toThrow(/duplicate short_code/);
  });

  it('keeps indexes in step when a row is replaced', () => {
    const store = new WorkbookStore(sampleData());
    const order = store.get('orders', 'ORD-20261105-0001')!;
    store.replace('orders', { ...order, status: 'BILLED', bill_no: 'B-20261105-001' });
    expect(store.findBy('orders', 'status', 'OPEN')).toEqual([]);
    expect(store.findBy('orders', 'status', 'BILLED')).toHaveLength(1);
    expect(store.findUnique('orders', 'bill_no', 'B-20261105-001')?.id).toBe(order.id);
    store.replace('items', { ...roti, short_code: 'RT' });
    expect(store.findUnique('items', 'short_code', 'TR')).toBeUndefined();
    expect(store.toData().items.find((i) => i.id === 'ITM-2')?.short_code).toBe('RT');
  });
});

describe('order line snapshots (REQ-099)', () => {
  const base = { id: 'OI-9', order_id: 'ORD-1', kot_id: 'KOT-1', note: null, user_id: 'USR-1', now: '2026-11-05T12:00:00.000+05:30' };

  it('REQ-099: a line with quantity 6 at unit price ₹20 stores line_total 120', () => {
    const line = buildOrderLine(roti, rotiVariant, { ...base, quantity: 6 });
    expect(line.unit_price).toBe('20.00');
    expect(line.line_total).toBe('120.00');
  });

  it('REQ-099: renaming an item does not change item_name_snapshot on past lines', () => {
    const store = new WorkbookStore(sampleData());
    const line = buildOrderLine(roti, rotiVariant, { ...base, quantity: 1 });
    store.insert('order_items', line);
    store.replace('items', { ...store.get('items', 'ITM-2')!, name_en: 'Butter Roti', name_hi: 'बटर रोटी', food_type: 'NON_VEG' });
    store.replace('variants', { ...store.get('variants', 'VAR-2')!, name: 'Large', price: '25.00' });
    const past = store.get('order_items', 'OI-9')!;
    expect(past).toMatchObject({
      item_name_snapshot: 'Tandoori Roti',
      item_name_hi_snapshot: 'तंदूरी रोटी',
      variant_name_snapshot: 'Plain',
      food_type_snapshot: 'VEG',
      unit_price: '20.00',
    });
    expect(store.get('order_items', 'OI-1')!.item_name_snapshot).toBe('Tandoori Roti');
  });

  it('refuses a variant of another item', () => {
    expect(() => buildOrderLine(item, rotiVariant, { ...base, quantity: 1 })).toThrow(/does not belong/);
  });
});

describe('PIN storage (REQ-119)', () => {
  it('REQ-119: a PIN is stored as a bcrypt hash that differs from the digits', async () => {
    const hash = await hashPin('4321');
    expect(hash).not.toBe('4321');
    expect(hash).not.toContain('4321');
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(hash.length).toBeLessThanOrEqual(sheetDef('users').columns.find((c) => c.name === 'pin_hash')!.maxLength!);
    expect(await verifyPin('4321', hash)).toBe(true);
    expect(await verifyPin('1234', hash)).toBe(false);
  });

  it('REQ-119: rejects PINs shorter than 4 digits', async () => {
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    await expect(hashPin('123')).rejects.toThrow(/at least 4 digits/);
  });
});

describe('folder lock (REQ-104)', () => {
  it('REQ-104: a second owner of the same data folder is refused', () => {
    const dir = tempDir();
    const first = new FolderLock(dir);
    first.acquire();
    expect(() => new FolderLock(dir).acquire()).toThrow(FolderLockedError);
    first.release();
    const again = new FolderLock(dir);
    again.acquire();
    again.release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });

  it('REQ-104: a lock held by another live process refuses startup', async () => {
    const dir = tempDir();
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      fs.writeFileSync(path.join(dir, LOCK_FILE), String(other.pid));
      const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
      await expect(storage.open()).rejects.toThrow(/already locked by another pos-api/);
      expect(fs.existsSync(path.join(dir, WORKBOOK_FILE))).toBe(false);
    } finally {
      other.kill();
    }
  });

  it('takes over a lock left behind by a dead process', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, LOCK_FILE), '999999999');
    const lock = new FolderLock(dir);
    lock.acquire();
    expect(fs.readFileSync(lock.file, 'utf8')).toBe(String(process.pid));
    lock.release();
    lock.release(); // idempotent
  });
});

describe('storage service (REQ-002, REQ-104)', () => {
  it('REQ-002: creates a fresh 15-sheet workbook in an empty folder, no database needed', async () => {
    const dir = tempDir();
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    expect(storage.loaded).toBe(false);
    expect(() => storage.store).toThrow(/not loaded/);
    await storage.open();
    expect(fs.existsSync(path.join(dir, WORKBOOK_FILE))).toBe(true);
    expect(storage.store.get('meta', 'META')?.schema_version).toBe(1);
    expect(storage.store.get('settings', 'SETTINGS')?.token_reset_time).toBe('04:00');
    storage.close();
  });

  it('REQ-104: reads keep working from memory while the file is locked or gone', async () => {
    const dir = tempDir();
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), sampleData(), 'x');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    fs.chmodSync(storage.workbookPath, 0o000);
    expect(storage.store.findBy('variants', 'item_id', 'ITM-2')[0].price).toBe('20.00');
    fs.chmodSync(storage.workbookPath, 0o644);
    fs.rmSync(storage.workbookPath);
    expect(storage.store.all('items')).toHaveLength(2);
    await storage.save();
    expect(fs.existsSync(storage.workbookPath)).toBe(true);
    storage.close();
  });

  it('REQ-110: an invalid workbook is not loaded; writes are blocked and the lock stays held', async () => {
    const dir = tempDir();
    const bad = sampleData();
    bad.orders[0].status = 'DONE' as never;
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), bad, 'x');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    expect(storage.state).toBe('corrupt');
    expect(storage.recoveryOffer!.errors.join()).toMatch(/DONE/);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(true);
    storage.close();
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });
});
