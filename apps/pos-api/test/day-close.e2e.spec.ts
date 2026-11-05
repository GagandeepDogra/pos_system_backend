// HTTP checks of the day-close summary and the close itself (WI-016): cash total,
// unsettled orders, snapshot, availability reset, retention and month archive.
import fs from 'fs';
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { snapshotName } from '../src/storage/backup-folder';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { ArchiveReadOnlyError, readWorkbookFile, writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, tempDir } from './fixtures';
import { addClosedOrders } from './support/month-rows';
import { TAKEAWAY_ORDER, sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const CLOCK = Date.parse('2026-11-05T22:00:00.000+05:30');
const DAY_MS = 24 * 60 * 60_000;

describe('day close over HTTP (WI-016)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let octoberIds: string[];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  const backupNames = () => storage.backups.folder.list().map((s) => s.name);

  beforeAll(async () => {
    const dir = tempDir();
    const data = sampleSessionData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    // ₹300 CASH SUCCESS is in the sample session; add a ₹100 CASH that was VOIDED and an older day's cash.
    data.payments.push({
      ...data.payments[0], id: 'PAY-000009', amount: '100.00', status: 'VOIDED', void_reason: 'Wrong table', voided_by: 'ADM-1', idempotency_key: 'key-void',
    }, { ...data.payments[0], id: 'PAY-000010', business_date: '2026-11-04', idempotency_key: 'key-old' });
    // One item marked out of stock today (still active).
    data.items[0] = { ...data.items[0], available_today: false, updated_at: '2026-11-05T19:00:00.000+05:30' };
    // Only the takeaway T-003 stays unsettled.
    data.orders = data.orders.map((o) => (o.id === TAKEAWAY_ORDER ? o : { ...o, status: o.status === 'OPEN' ? 'PAID' : o.status }));
    octoberIds = addClosedOrders(data, '2026-10-20', 4);
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    if (storage.state !== 'ready') throw new Error(JSON.stringify(storage.recoveryOffer?.errors.slice(0, 5)));
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => CLOCK });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    tokens.KITCHEN = await login('USR-K', '9012');
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  it('REQ-096: only an Admin sees or runs day close', async () => {
    await http().get('/api/v1/admin/day-close').set(as('CASHIER')).expect(403);
    await http().get('/api/v1/admin/day-close').set(as('KITCHEN')).expect(403);
    await http().post('/api/v1/admin/day-close').set(as('CASHIER')).set('Idempotency-Key', 'k-c').expect(403);
  });

  it('REQ-096: with ₹300 cash SUCCESS and ₹100 cash VOIDED payments, the cash total shows ₹300; open orders are listed in red', async () => {
    const body = (await http().get('/api/v1/admin/day-close').set(as('ADMIN')).expect(200)).body;
    expect(body.business_date).toBe('2026-11-05');
    expect(body.cash_total).toBe('300.00');
    expect(body.cash_payment_count).toBe(1);
    expect(body.can_close).toBe(false);
    expect(body.open_orders).toEqual([expect.objectContaining({ id: TAKEAWAY_ORDER, label: 'T-003', status: 'OPEN', highlight: true })]);
  });

  it('REQ-096: closing is refused (409) while an OPEN or BILLED order remains, and nothing changes', async () => {
    const snapshots = backupNames();
    const res = await http().post('/api/v1/admin/day-close').set(as('ADMIN')).set('Idempotency-Key', 'close-1').expect(409);
    expect(res.body.code).toBe('OPEN_ORDERS_REMAIN');
    expect(res.body.details.orders.map((o: { id: string }) => o.id)).toEqual([TAKEAWAY_ORDER]);
    expect(backupNames()).toEqual(snapshots);
    expect(storage.store.get('items', 'ITM-1')!.available_today).toBe(false);
    await http().post('/api/v1/admin/day-close').set(as('ADMIN')).expect(400); // Idempotency-Key required
  });

  it('REQ-096/REQ-109/REQ-074/REQ-108: completing day close snapshots, resets availability, prunes old snapshots and archives the finished month', async () => {
    // Settle the takeaway (closed by exception in the real flow).
    await storage.queue.run((tx) => tx.update('orders', tx.get('orders', TAKEAWAY_ORDER)!, { status: 'CLOSED_EXCEPTION' }, 'ADM-1'));
    // Old snapshots: two on one day 40 days ago (only the day-close one is kept), one older than a year.
    fs.mkdirSync(storage.backupDir, { recursive: true });
    const now = Date.now();
    const old = [
      snapshotName(new Date(now - 40 * DAY_MS), 'auto'),
      snapshotName(new Date(now - 40 * DAY_MS + 60_000), 'day-close'),
      snapshotName(new Date(now - 400 * DAY_MS), 'day-close'),
    ];
    for (const name of old) fs.copyFileSync(storage.workbookPath, path.join(storage.backupDir, name));
    const before = backupNames();
    const itemBefore = storage.store.get('items', 'ITM-1')!;

    const res = await http().post('/api/v1/admin/day-close').set(as('ADMIN')).set('Idempotency-Key', 'close-1').expect(201);
    const body = res.body;
    expect(body.business_date).toBe('2026-11-05');
    expect(body.cash_total).toBe('300.00');

    // A new day-close snapshot is in the backup list, and it is a valid workbook.
    expect(body.snapshot.reason).toBe('day-close');
    expect(before).not.toContain(body.snapshot.name);
    expect(body.snapshots).toContain(body.snapshot.name);
    expect(backupNames()).toContain(body.snapshot.name);
    await readWorkbookFile(path.join(storage.backupDir, body.snapshot.name));

    // Retention: older than 30 days → one per day (day-close preferred); older than a year → removed.
    expect(backupNames()).not.toContain(old[0]);
    expect(backupNames()).toContain(old[1]);
    expect(backupNames()).not.toContain(old[2]);

    // available_today back to TRUE; is_active untouched.
    expect(body.availability_reset).toEqual(['ITM-1']);
    const item = storage.store.get('items', 'ITM-1')!;
    expect(item.available_today).toBe(true);
    expect(item.is_active).toBe(itemBefore.is_active);
    expect(storage.store.all('audit_log').some((a) => a.action === 'DAY_CLOSE' && a.entity_id === '2026-11-05')).toBe(true);

    // October (a finished month) moved to archive/2026-10.xlsx and out of live; November stays.
    expect(body.archives).toEqual([expect.objectContaining({ month: '2026-10', status: 'ARCHIVED' })]);
    expect(body.archives[0].pruned.orders).toBe(4);
    const archiveFile = path.join(storage.archiveDir, '2026-10.xlsx');
    expect((await readWorkbookFile(archiveFile)).orders.map((o) => o.id).sort()).toEqual([...octoberIds].sort());
    for (const id of octoberIds) expect(storage.store.get('orders', id)).toBeUndefined();
    const live = await readWorkbookFile(storage.workbookPath);
    expect(live.orders.some((o) => octoberIds.includes(o.id))).toBe(false);
    expect(live.orders.some((o) => o.id === TAKEAWAY_ORDER)).toBe(true);
    expect(fs.statSync(storage.workbookPath).size).toBeLessThan(15 * 1024 * 1024);
    await expect(writeWorkbookFile(archiveFile, live, 'x')).rejects.toBeInstanceOf(ArchiveReadOnlyError);
  });

  it('REQ-112: repeating the close with the same Idempotency-Key answers 200 with the same result', async () => {
    const count = backupNames().length;
    const first = (await http().post('/api/v1/admin/day-close').set(as('ADMIN')).set('Idempotency-Key', 'close-1').expect(200)).body;
    expect(first.snapshot.reason).toBe('day-close');
    expect(backupNames().length).toBe(count);
  });

  it('REQ-074: toggling availability does not change is_active', async () => {
    const item = storage.store.get('items', 'ITM-1')!;
    const res = await http().patch('/api/v1/items/ITM-1/availability').set(as('CASHIER')).set('If-Match', String(item.row_version))
      .send({ available_today: false }).expect(200);
    expect(res.body.available_today).toBe(false);
    expect(storage.store.get('items', 'ITM-1')!.is_active).toBe(true);
  });
});
