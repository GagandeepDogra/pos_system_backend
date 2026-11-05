// HTTP and realtime checks of the dashboard tiles (WI-012).
import fs from 'fs';
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { Order, Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { readWorkbookFile, writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, tempDir } from './fixtures';
import { sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const NEW_TABLES = ['TBL-A', 'TBL-B', 'TBL-C', 'TBL-D'];

describe('dashboard tiles over HTTP and Socket.IO (WI-012)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let dir: string;
  let url: string;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  let keyN = 0;
  /** Sessions opened on TBL-A, TBL-B, TBL-C by the Active tables test. */
  const orders: Order[] = [];
  const dashboard = async (who: Role) => (await http().get('/api/v1/dashboard').set(as(who)).expect(200)).body;
  const openTable = async (table_id: string): Promise<Order> =>
    (await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).set('Idempotency-Key', `open-${++keyN}`).send({ table_id }).expect(201)).body;
  const sendKot = (orderId: string) =>
    http().post(`/api/v1/orders/${orderId}/kots`).set(as('CASHIER')).set('Idempotency-Key', `send-${++keyN}`)
      .send({ lines: [{ variant_id: 'VAR-1', quantity: 1 }] }).expect(201);

  const connect = async (): Promise<{ socket: Socket; seen: string[] }> => {
    const seen: string[] = [];
    const socket = io(url, { path: '/socket.io', transports: ['websocket'], forceNew: true });
    socket.onAny((name) => seen.push(name));
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    return { socket, seen };
  };
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeAll(async () => {
    dir = tempDir();
    const data = sampleSessionData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(
      await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'),
      await mk('USR-C2', 'Cashier Sita', 'CASHIER', '3456'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'),
    );
    NEW_TABLES.forEach((id, i) => data.tables.push({ id, table_number: `D${i + 1}`, area: 'Garden', seats: 2, is_active: true, ...audit }));
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    // Fixed clock on the fixture's business day (2026-11-05), so the fixture's ₹520 of payments is "today".
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => Date.parse(NOW) });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    tokens.KITCHEN = await login('USR-K', '9012');
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  describe('role shape (REQ-028, REQ-020, REQ-021)', () => {
    it('REQ-028: Admin sees all four buttons in 2×2 order; Cashier the four too; Kitchen only KITCHEN (no PAYMENT)', async () => {
      expect((await dashboard('ADMIN')).buttons).toEqual(['DINE_IN', 'TAKEAWAY', 'KITCHEN', 'PAYMENT']);
      expect((await dashboard('CASHIER')).buttons).toEqual(['DINE_IN', 'TAKEAWAY', 'KITCHEN', 'PAYMENT']);
      const kitchen = (await dashboard('KITCHEN')).buttons;
      expect(kitchen).toEqual(['KITCHEN']);
      expect(kitchen).not.toContain('PAYMENT');
    });

    it('REQ-029/REQ-020: Admin gets today\'s sales (SUCCESS payments of the business day); a Cashier on a day with sales gets counts but no sales field', async () => {
      const admin = await dashboard('ADMIN');
      expect(admin).toMatchObject({ business_date: '2026-11-05', role: 'ADMIN', tiles: { todays_sales: '520.00' }, alert: null });
      const cashier = await dashboard('CASHIER');
      expect(cashier.tiles).toEqual({
        active_tables: expect.any(Number), ready_to_close_tables: expect.any(Number), pending_kots: expect.any(Number), ready_orders: expect.any(Number),
      });
      expect(cashier.tiles).not.toHaveProperty('todays_sales');
      expect(cashier).not.toHaveProperty('alert');
      expect(JSON.stringify(cashier)).not.toContain('520');
    });

    it('REQ-021: a Kitchen user gets no sales figures from the dashboard, and the sales report is refused', async () => {
      const kitchen = await dashboard('KITCHEN');
      expect(kitchen.tiles).not.toHaveProperty('todays_sales');
      expect(kitchen).not.toHaveProperty('alert');
      const res = await http().get('/api/v1/admin/reports/sales?from=2026-11-05&to=2026-11-05').set(as('KITCHEN'));
      expect([403, 404]).toContain(res.status); // 403 once the reports route exists; never a body with sales
      expect(JSON.stringify(res.body)).not.toContain('520');
    });

    it('REQ-030: a missing token is a 401', async () => {
      await http().get('/api/v1/dashboard').expect(401);
    });
  });

  describe('tiles (REQ-029)', () => {
    it('REQ-029: with 3 tables Occupied the Active tables tile counts them and its list (GET /tables?status=OCCUPIED) holds exactly those 3', async () => {
      const before = await dashboard('CASHIER');
      const occupied = async (q = '') =>
        ((await http().get(`/api/v1/tables?status=OCCUPIED${q}`).set(as('CASHIER')).expect(200)).body as Array<{ id: string }>).map((t) => t.id).sort();
      expect(before.tiles.active_tables).toBe((await occupied()).length);
      orders.push(await openTable('TBL-A'), await openTable('TBL-B'), await openTable('TBL-C'));
      expect((await dashboard('CASHIER')).tiles.active_tables).toBe(before.tiles.active_tables + 3);
      // the Garden tables were all free before: the Active tables list there holds exactly the 3
      expect(await occupied('&area=Garden')).toEqual(['TBL-A', 'TBL-B', 'TBL-C']);
      expect((await occupied()).length).toBe(before.tiles.active_tables + 3);
      // a printed bill moves the table from Active to Ready to Close
      await sendKot(orders[2].id);
      await http().post(`/api/v1/orders/${orders[2].id}/bill`).set(as('CASHIER')).set('If-Match', String(storage.store.get('orders', orders[2].id)!.row_version)).expect(200);
      expect((await dashboard('CASHIER')).tiles).toMatchObject({ active_tables: before.tiles.active_tables + 2, ready_to_close_tables: before.tiles.ready_to_close_tables + 1 });
    });

    it('REQ-029: pending KOTs count NEW/PREPARING; a READY KOT moves to ready orders', async () => {
      const before = (await dashboard('KITCHEN')).tiles;
      const kot = (await sendKot(orders[0].id)).body;
      expect((await dashboard('KITCHEN')).tiles.pending_kots).toBe(before.pending_kots + 1);
      const step = (status: string) => http().patch(`/api/v1/kots/${kot.id}/status`).set(as('KITCHEN'))
        .set('If-Match', String(storage.store.get('kots', kot.id)!.row_version)).send({ status }).expect(200);
      await step('PREPARING');
      expect((await dashboard('KITCHEN')).tiles.pending_kots).toBe(before.pending_kots + 1);
      await step('READY');
      expect((await dashboard('KITCHEN')).tiles).toMatchObject({ pending_kots: before.pending_kots, ready_orders: before.ready_orders + 1 });
    });
  });

  describe('auto-refresh (REQ-030)', () => {
    it('REQ-030: after a KOT is sent, dashboard.updated arrives and the pending-KOT tile is updated within 3 s', async () => {
      const { socket, seen } = await connect();
      try {
        const before = (await dashboard('CASHIER')).tiles.pending_kots;
        const started = Date.now();
        await sendKot(orders[1].id);
        await waitFor(() => seen.includes('dashboard.updated'));
        expect((await dashboard('CASHIER')).tiles.pending_kots).toBe(before + 1);
        expect(Date.now() - started).toBeLessThan(3000);
      } finally {
        socket.close();
      }
    });

    it('REQ-030: a device disconnected while 2 KOTs were sent sees a pending count including both within 3 s of reconnecting', async () => {
      const { socket } = await connect();
      const before = (await dashboard('CASHIER')).tiles.pending_kots;
      socket.disconnect();
      await sendKot(orders[1].id);
      await sendKot(orders[1].id);
      const started = Date.now();
      socket.connect();
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      // on reconnect the client refetches its screen's GET endpoints
      expect((await dashboard('CASHIER')).tiles.pending_kots).toBe(before + 2);
      expect(Date.now() - started).toBeLessThan(3000);
      socket.close();
    });

    it('REQ-030: a KOT status change also pushes dashboard.updated', async () => {
      const { socket, seen } = await connect();
      try {
        const kot = storage.store.all('kots').find((k) => k.status === 'NEW')!;
        await http().patch(`/api/v1/kots/${kot.id}/status`).set(as('KITCHEN')).set('If-Match', String(kot.row_version)).send({ status: 'PREPARING' }).expect(200);
        await waitFor(() => seen.includes('dashboard.updated'));
      } finally {
        socket.close();
      }
    });
  });

  describe('role limits seen from the dashboard (REQ-020, REQ-021)', () => {
    it('REQ-020: a Cashier attempting a price change is rejected', async () => {
      const res = await http().post('/api/v1/admin/variants/VAR-1/price-changes').set(as('CASHIER'))
        .set('Idempotency-Key', 'pc-1').set('If-Match', '1').send({ new_price: '1.00', reason: 'OTHER' });
      expect([403, 404]).toContain(res.status); // 403 ACCESS_DENIED from the /admin default once the route exists
      expect(storage.store.get('variants', 'VAR-1')!.price).toBe('220.00');
    });

    it('REQ-020: a Cashier attempting to void a payment (without an Admin approval) is rejected', async () => {
      const pay = storage.store.all('payments').find((p) => p.status === 'SUCCESS')!;
      const res = await http().post(`/api/v1/payments/${pay.id}/void`).set(as('CASHIER')).set('If-Match', String(pay.row_version)).send({ reason: 'mistake' });
      expect(res.status).toBe(403);
      expect(storage.store.get('payments', pay.id)!.status).toBe('SUCCESS');
    });

    it('REQ-020: a Cashier requesting another cashier\'s closed order from today is refused', async () => {
      // Cashier Sita takes, sends and settles a takeaway today
      const sita = { Authorization: `Bearer ${(await http().post('/api/v1/auth/login').send({ user_id: 'USR-C2', pin: '3456' }).expect(200)).body.token}` };
      const other: Order = (await http().post('/api/v1/orders/takeaway').set(sita).set('Idempotency-Key', 'sita-ta').send({}).expect(201)).body;
      await http().post(`/api/v1/orders/${other.id}/kots`).set(sita).set('Idempotency-Key', 'sita-send').send({ lines: [{ variant_id: 'VAR-1', quantity: 1 }] }).expect(201);
      await http().post(`/api/v1/orders/${other.id}/payments`).set(sita).set('Idempotency-Key', 'sita-pay')
        .send({ method: 'CASH', amount: storage.store.get('orders', other.id)!.balance_due }).expect(201);
      expect(storage.store.get('orders', other.id)!.status).toBe('PAID');
      await http().get(`/api/v1/orders/${other.id}`).set(sita).expect(200);
      const res = await http().get(`/api/v1/orders/${other.id}`).set(as('CASHIER')).expect(403);
      expect(res.body.code).toBe('ORDER_NOT_VISIBLE');
    });

    it('REQ-021: the kitchen feed for a KOT holding a ₹220 Butter Chicken line carries no 220 anywhere', async () => {
      const board = (await http().get('/api/v1/kitchen/kots').set(as('KITCHEN')).expect(200)).body as unknown[];
      expect(board.length).toBeGreaterThan(0);
      expect(JSON.stringify(board)).not.toMatch(/220/);
    });
  });

  describe('write failure (REQ-117)', () => {
    it('REQ-117: a write failing on a full disk confirms nothing, leaves no partial row, and the Admin dashboard (only) shows the alert', async () => {
      await storage.save();
      const ordersInFile = (await readWorkbookFile(path.join(dir, WORKBOOK_FILE))).orders.length;
      const ordersInMemory = storage.store.all('orders').length;
      const spy = jest.spyOn(storage.journal, 'append').mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      });
      const res = await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).set('Idempotency-Key', 'full-disk').send({ table_id: 'TBL-D' });
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'SAVE_FAILED', message_en: expect.stringContaining('Saving problem, call owner') });
      expect(res.body).not.toHaveProperty('id');
      expect(storage.store.all('orders')).toHaveLength(ordersInMemory);
      expect(storage.store.findUnique('orders', 'client_request_id', 'full-disk')).toBeUndefined();
      await storage.save();
      expect((await readWorkbookFile(path.join(dir, WORKBOOK_FILE))).orders).toHaveLength(ordersInFile);

      // The failed journal write stays reported until the next good write.
      const admin = await dashboard('ADMIN');
      expect(admin.alert).toMatchObject({ code: 'SAVE_FAILED', message_en: 'Saving problem, call owner', message_hi: expect.any(String) });
      expect(await dashboard('CASHIER')).not.toHaveProperty('alert');

      await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).set('Idempotency-Key', 'full-disk').send({ table_id: 'TBL-D' }).expect(201);
      expect((await dashboard('ADMIN')).alert).toBeNull();
      expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
  });
});
