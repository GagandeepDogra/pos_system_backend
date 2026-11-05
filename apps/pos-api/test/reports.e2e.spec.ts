// HTTP checks of the sales report and order history search (WI-015): totals equal
// SUCCESS payments, a void lowers them, archived months are included, bill search.
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { fromPaise, toPaise } from '../src/billing/money';
import { MonthlyArchiver, listArchiveParts } from '../src/storage/archive';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { monthsBetween, normalizeToken } from '../src/reports/reports';
import { NOW, tempDir } from './fixtures';
import { addClosedOrders } from './support/month-rows';
import { TABLE5_ORDER, TAKEAWAY_ORDER, sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const CLOCK = Date.parse('2026-11-05T22:00:00.000+05:30');

describe('sales reports and order search (WI-015)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let octoberIds: string[];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  const report = async (from: string, to: string) =>
    (await http().get('/api/v1/admin/reports/sales').query({ from, to }).set(as('ADMIN')).expect(200)).body;
  const successSum = (from: string, to: string, extra: { amount: string; status: string; business_date: string }[] = []) =>
    fromPaise([...storage.store.all('payments'), ...extra]
      .filter((p) => p.status === 'SUCCESS' && p.business_date >= from && p.business_date <= to)
      .reduce((s, p) => s + toPaise(p.amount), 0));

  beforeAll(async () => {
    const dir = tempDir();
    const data = sampleSessionData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    octoberIds = addClosedOrders(data, '2026-10-20', 4);
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    if (storage.state !== 'ready') throw new Error(JSON.stringify(storage.recoveryOffer?.errors.slice(0, 5)));
    // Archive October the way day close does (rows leave live, archive/2026-10.xlsx is written).
    await storage.queue.exclusive((commit) => new MonthlyArchiver(storage).archiveDue(commit, '2026-11-05', 'ADM-1', NOW));
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

  it('REQ-077/REQ-078: only an Admin reads reports or searches orders', async () => {
    for (const who of ['CASHIER', 'KITCHEN'] as Role[]) {
      await http().get('/api/v1/admin/reports/sales').query({ from: '2026-11-05', to: '2026-11-05' }).set(as(who)).expect(403);
      await http().get('/api/v1/admin/orders').set(as(who)).expect(403);
    }
  });

  it('REQ-077: from after to is 400; missing or malformed dates are 400', async () => {
    const res = await http().get('/api/v1/admin/reports/sales').query({ from: '2026-11-06', to: '2026-11-05' }).set(as('ADMIN')).expect(400);
    expect(res.body.code).toBe('INVALID_DATE_RANGE');
    await http().get('/api/v1/admin/reports/sales').query({ from: '2026-11-05' }).set(as('ADMIN')).expect(400);
    await http().get('/api/v1/admin/reports/sales').query({ from: '05-11-2026', to: '2026-11-05' }).set(as('ADMIN')).expect(400);
  });

  it('REQ-077: the daily total equals the sum of SUCCESS payments to the rupee, split by method and category', async () => {
    const body = await report('2026-11-05', '2026-11-05');
    expect(body.total_sales).toBe(successSum('2026-11-05', '2026-11-05'));
    expect(body.total_sales).toBe('520.00');
    expect(body.by_method.CASH).toEqual({ count: 1, amount: '300.00' });
    expect(body.by_method.UPI).toEqual({ count: 1, amount: '220.00' });
    expect(body.by_method.CARD).toEqual({ count: 0, amount: '0.00' });
    expect(body.by_day).toEqual([{ business_date: '2026-11-05', total: '520.00', payment_count: 2 }]);
    // Category totals are the ACTIVE snapshot lines of the day's non-cancelled orders (Table 5 = 520, T-003 = 260, ...).
    const categorySum = body.by_category.reduce((s: number, c: { amount: string }) => s + toPaise(c.amount), 0);
    const dayOrders = new Set(storage.store.all('orders').filter((o) => o.business_date === '2026-11-05' && o.status !== 'CANCELLED').map((o) => o.id));
    const activeLines = storage.store.all('order_items').filter((l) => l.status === 'ACTIVE' && dayOrders.has(l.order_id));
    expect(categorySum).toBe(activeLines.reduce((s, l) => s + toPaise(l.line_total), 0));
    expect(categorySum).toBeGreaterThanOrEqual(toPaise('780.00'));
    expect(body.top_items.length).toBeGreaterThan(0);
    expect(body.top_items.find((i: { name_en: string }) => i.name_en === 'Sweet Lassi')).toBeUndefined(); // cancelled only
    expect(body.cancelled_items.lines.map((l: { item_name: string }) => l.item_name)).toEqual(expect.arrayContaining(['Sweet Lassi']));
    expect(body.archive_files).toEqual([]);
  });

  it('REQ-077/REQ-068: voiding a ₹300 payment lowers that day\'s total by ₹300', async () => {
    const before = await report('2026-11-05', '2026-11-05');
    const cash = storage.store.all('payments').find((p) => p.order_id === TABLE5_ORDER && p.method === 'CASH' && p.amount === '300.00')!;
    await http().post(`/api/v1/payments/${cash.id}/void`).set(as('ADMIN')).set('If-Match', String(cash.row_version)).send({ void_reason: 'Wrong table' }).expect(200);
    const after = await report('2026-11-05', '2026-11-05');
    expect(toPaise(before.total_sales) - toPaise(after.total_sales)).toBe(30000);
    expect(after.total_sales).toBe('220.00');
    expect(after.by_method.CASH).toEqual({ count: 0, amount: '0.00' });
    expect(after.voided_payments).toEqual({ count: 1, amount: '300.00' });
    expect(after.exceptions.by_type.PAYMENT_VOID.count).toBe(1);
  });

  it('REQ-077/REQ-108: a range spanning an archived month includes the archive rows', async () => {
    expect(listArchiveParts(storage.archiveDir, '2026-10').map((p) => p.name)).toEqual(['2026-10.xlsx']);
    expect(storage.store.get('orders', octoberIds[0])).toBeUndefined(); // pruned from live
    const october = await report('2026-10-01', '2026-10-31');
    expect(october.total_sales).toBe('1760.00'); // 4 × ₹440 CASH SUCCESS
    expect(october.orders.count).toBe(4);
    expect(october.cancelled_items.count).toBe(8);
    expect(october.exceptions.by_type.CANCEL_AFTER_START.count).toBe(4);
    expect(october.archive_files).toEqual(['2026-10.xlsx']);
    const both = await report('2026-10-15', '2026-11-05');
    expect(both.total_sales).toBe(fromPaise(toPaise('1760.00') + toPaise(successSum('2026-11-05', '2026-11-05'))));
    expect(both.by_day.map((d: { business_date: string }) => d.business_date)).toEqual(['2026-10-20', '2026-11-05']);
    const empty = await report('2026-09-01', '2026-09-30');
    expect(empty.total_sales).toBe('0.00');
    expect(empty.orders.count).toBe(0);
  });

  it('REQ-078: searching an existing bill number returns that order; an unknown one returns an empty list', async () => {
    const hit = (await http().get('/api/v1/admin/orders').query({ bill_no: 'B-20261105-001' }).set(as('ADMIN')).expect(200)).body;
    expect(hit.map((o: { id: string }) => o.id)).toEqual([TABLE5_ORDER]);
    expect(hit[0].archived).toBe(false);
    const lower = (await http().get('/api/v1/admin/orders').query({ bill_no: 'b-20261105-001' }).set(as('ADMIN')).expect(200)).body;
    expect(lower.map((o: { id: string }) => o.id)).toEqual([TABLE5_ORDER]);
    const none = (await http().get('/api/v1/admin/orders').query({ bill_no: 'B-20261105-999' }).set(as('ADMIN')).expect(200)).body;
    expect(none).toEqual([]);
  });

  it('REQ-078: search by date, table and token; archived orders are found by date or bill number', async () => {
    const byDate = (await http().get('/api/v1/admin/orders').query({ date: '2026-11-05' }).set(as('ADMIN')).expect(200)).body;
    expect(byDate.map((o: { id: string }) => o.id)).toEqual(expect.arrayContaining([TABLE5_ORDER, TAKEAWAY_ORDER]));
    const byTable = (await http().get('/api/v1/admin/orders').query({ table: '5' }).set(as('ADMIN')).expect(200)).body;
    expect(byTable.map((o: { id: string }) => o.id)).toEqual([TABLE5_ORDER]);
    const byToken = (await http().get('/api/v1/admin/orders').query({ token: '3', date: '2026-11-05' }).set(as('ADMIN')).expect(200)).body;
    expect(byToken.map((o: { id: string }) => o.id)).toEqual([TAKEAWAY_ORDER]);
    const archived = (await http().get('/api/v1/admin/orders').query({ date: '2026-10-20' }).set(as('ADMIN')).expect(200)).body;
    expect(archived.map((o: { id: string }) => o.id).sort()).toEqual([...octoberIds].sort());
    expect(archived.every((o: { archived: boolean }) => o.archived)).toBe(true);
    const archivedBill = archived[0].bill_no as string;
    const byBill = (await http().get('/api/v1/admin/orders').query({ bill_no: archivedBill }).set(as('ADMIN')).expect(200)).body;
    expect(byBill.map((o: { bill_no: string }) => o.bill_no)).toEqual([archivedBill]);
    await http().get('/api/v1/admin/orders').query({ date: 'yesterday' }).set(as('ADMIN')).expect(400);
  });

  it('REQ-078: helpers normalise tokens and list the months of a range', () => {
    expect(['3', '003', 't-3', 'T-003'].map(normalizeToken)).toEqual(['T-003', 'T-003', 'T-003', 'T-003']);
    expect(monthsBetween('2026-11-20', '2027-02-01')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });
});
