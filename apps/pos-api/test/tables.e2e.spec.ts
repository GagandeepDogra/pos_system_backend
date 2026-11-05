import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DiningTable, Order, Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { computeTotals } from '../src/billing/totals';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { TxEvent } from '../src/storage/write-queue';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, seededData, tempDir } from './fixtures';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const table = (id: string, table_number: string, area: string | null, extra: Partial<DiningTable> = {}): DiningTable =>
  ({ id, table_number, area, seats: 4, is_active: true, ...audit, ...extra });

describe('tables, dine-in sessions, order view, move and merge (WI-006)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let auth: AuthService;
  const clock = Date.parse('2026-11-05T12:30:00+05:30');
  const events: TxEvent[] = [];
  const tokens = {} as Record<Role | 'CASHIER2', string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role | 'CASHIER2') => ({ Authorization: `Bearer ${tokens[who]}` });
  const cards = async (who: Role | 'CASHIER2' = 'CASHIER', query = '') => (await http().get(`/api/v1/tables${query}`).set(as(who)).expect(200)).body;
  const card = async (id: string, who: Role | 'CASHIER2' = 'CASHIER') => (await cards(who)).find((c: { id: string }) => c.id === id);
  let keyN = 0;
  const open = (table_id: string, body: Record<string, unknown> = {}, key = `open-${++keyN}`, who: Role | 'CASHIER2' = 'CASHIER') =>
    http().post('/api/v1/orders/dine-in').set(as(who)).set('Idempotency-Key', key).send({ table_id, ...body });
  const setOrder = (id: string, patch: Partial<Order>) => storage.queue.run((tx) => tx.update('orders', tx.get('orders', id)!, patch, 'SYSTEM'));
  /** Sends one KOT with the given number and lines straight through the queue (the send-to-kitchen route comes later). */
  const sendKot = (orderId: string, kotNumber: number, lines: { variant: string; qty: number; price: string; name: string }[]) =>
    storage.queue.run((tx) => {
      const kotId = `KOT-T-${orderId.slice(-4)}-${kotNumber}`;
      tx.create('kots', { id: kotId, kot_number: kotNumber, business_date: '2026-11-05', order_id: orderId, status: 'NEW', idempotency_key: kotId, sent_at: tx.now, served_at: null, hide_after: null }, 'USR-C');
      lines.forEach((l, i) => tx.create('order_items', {
        id: `${kotId}-L${i}`, order_id: orderId, kot_id: kotId, variant_id: l.variant, item_name_snapshot: l.name, item_name_hi_snapshot: l.name,
        variant_name_snapshot: 'Std', food_type_snapshot: 'VEG', unit_price: l.price, quantity: l.qty,
        line_total: (Number(l.price) * l.qty).toFixed(2), note: null, status: 'ACTIVE', cancel_reason: null,
      }, 'USR-C'));
      const order = tx.get('orders', orderId)!;
      tx.update('orders', order, computeTotals(order, tx.findBy('order_items', 'order_id', orderId), tx.findBy('payments', 'order_id', orderId)), 'USR-C');
      return kotId;
    });

  beforeAll(async () => {
    const dir = tempDir();
    const data = seededData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'),
      await mk('USR-C2', 'Cashier Meena', 'CASHIER', '2468'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    data.tables.push(
      table('TBL-2', 'T2', 'Hall'), table('TBL-3', 'T3', 'Family Room'), table('TBL-4', 'T4', null),
      table('TBL-5', 'T5', 'Hall', { is_active: false }), table('TBL-10', 'T10', 'Outside'),
      table('TBL-6', 'T6', 'Outside'), table('TBL-7', 'T7', 'Outside'), table('TBL-8', 'T8', 'Outside'), table('TBL-9', 'T9', 'Outside'),
    );
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    storage.queue.onCommit((_, evs) => events.push(...evs));
    auth = new AuthService(storage, { jwtSecret: SECRET, now: () => clock });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    tokens.CASHIER2 = await login('USR-C2', '2468');
    tokens.KITCHEN = await login('USR-K', '9012');
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  describe('GET /tables', () => {
    it('REQ-032/REQ-033: lists active tables in number order with derived status, running bill and minutes open', async () => {
      const list = await cards();
      expect(list.map((c: { table_number: string }) => c.table_number)).toEqual(['T1', 'T2', 'T3', 'T4', 'T6', 'T7', 'T8', 'T9', 'T10']);
      expect(list[0]).toMatchObject({ id: 'TBL-1', status: 'OCCUPIED', order_id: 'ORD-20261105-0001', running_total: '120.00', minutes_open: 30, guest_count: 2 });
      expect(list[1]).toMatchObject({ id: 'TBL-2', status: 'AVAILABLE', order_id: null, running_total: null, minutes_open: null });
    });

    it('REQ-032: deactivating a table removes its card from the grid', async () => {
      expect(await card('TBL-9')).toBeDefined();
      await storage.queue.run((tx) => tx.update('tables', tx.get('tables', 'TBL-9')!, { is_active: false }, 'ADM-1'));
      expect(await card('TBL-9')).toBeUndefined();
    });

    it('REQ-036: an area tab shows only that area; a table with no area is listed only under All', async () => {
      const hall = await cards('CASHIER', '?area=Hall');
      expect(hall.map((c: { id: string }) => c.id)).toEqual(['TBL-1', 'TBL-2']);
      const family = await cards('CASHIER', `?area=${encodeURIComponent('Family Room')}`);
      expect(family.map((c: { id: string }) => c.id)).toEqual(['TBL-3']);
      const all = await cards();
      expect(all.map((c: { id: string }) => c.id)).toContain('TBL-4');
      for (const area of ['Hall', 'Family Room', 'Outside']) {
        const tab = await cards('CASHIER', `?area=${encodeURIComponent(area)}`);
        expect(tab.map((c: { id: string }) => c.id)).not.toContain('TBL-4');
      }
    });

    it('REQ-029: ?status=OCCUPIED filters; an unknown status is a 400', async () => {
      const occupied = await cards('ADMIN', '?status=OCCUPIED');
      expect(occupied.every((c: { status: string }) => c.status === 'OCCUPIED')).toBe(true);
      expect(occupied.map((c: { id: string }) => c.id)).toContain('TBL-1');
      await http().get('/api/v1/tables?status=BUSY').set(as('CASHIER')).expect(400);
    });

    it('REQ-021: Kitchen sees statuses but no amounts', async () => {
      const list = await cards('KITCHEN');
      expect(list[0]).toMatchObject({ id: 'TBL-1', status: 'OCCUPIED' });
      for (const c of list) {
        expect(c).not.toHaveProperty('running_total');
        expect(c).not.toHaveProperty('balance_due');
      }
      expect(JSON.stringify(list)).not.toContain('120.00');
    });

    it('REQ-033: BILLED is Ready to Close; new items reopen it to Occupied; settling it frees the table and drops the running total', async () => {
      await setOrder('ORD-20261105-0001', { status: 'BILLED', bill_no: 'B-20261105-001' });
      expect(await card('TBL-1')).toMatchObject({ status: 'READY_TO_CLOSE', bill_no: 'B-20261105-001' });
      // Sending more food (WI-008) reopens a printed bill: BILLED → OPEN turns the card red again.
      await setOrder('ORD-20261105-0001', { status: 'OPEN' });
      expect(await card('TBL-1')).toMatchObject({ status: 'OCCUPIED' });
      await setOrder('ORD-20261105-0001', { status: 'BILLED' });
      // Paying the balance to zero (WI-010) makes the order PAID.
      await setOrder('ORD-20261105-0001', { status: 'PAID', paid_amount: '120.00', balance_due: '0.00' });
      const c = await card('TBL-1');
      expect(c).toMatchObject({ status: 'AVAILABLE', running_total: null, minutes_open: null, order_id: null });
    });
  });

  describe('POST /orders/dine-in', () => {
    it('REQ-034: opens a session on an Available table (201), turns it Occupied and emits table.status_changed', async () => {
      events.length = 0;
      const res = await open('TBL-2', { guest_count: 3 }, 'open-t2').expect(201);
      expect(res.body).toMatchObject({ order_type: 'DINE_IN', table_id: 'TBL-2', table_label_snapshot: 'T2', status: 'OPEN', guest_count: 3, client_request_id: 'open-t2', created_by: 'USR-C', subtotal: '0.00' });
      expect(res.body.id).toMatch(/^ORD-\d{8}-\d{4}$/);
      expect(res.body.business_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(events).toContainEqual({ event: 'table.status_changed', payload: { table_id: 'TBL-2', status: 'OCCUPIED', order_id: res.body.id } });
      expect(await card('TBL-2')).toMatchObject({ status: 'OCCUPIED', order_id: res.body.id });
      const auditRow = storage.store.findBy('audit_log', 'entity_id', res.body.id).find((a) => a.action === 'CREATE');
      expect(auditRow).toMatchObject({ user_id: 'USR-C', entity_type: 'orders' });
    });

    it('REQ-112: the same Idempotency-Key returns the original order with 200 and creates no second order', async () => {
      const before = storage.store.all('orders').length;
      const res = await open('TBL-2', { guest_count: 3 }, 'open-t2').expect(200);
      expect(res.body.client_request_id).toBe('open-t2');
      expect(storage.store.all('orders').length).toBe(before);
    });

    it('REQ-034: opening a table another phone already opened is 409 TABLE_BUSY with the existing order', async () => {
      const existing = storage.store.findUnique('orders', 'client_request_id', 'open-t2')!;
      const res = await open('TBL-2', {}, 'other-phone', 'CASHIER2').expect(409);
      expect(res.body.code).toBe('TABLE_BUSY');
      expect(res.body.details.order).toMatchObject({ id: existing.id, table_id: 'TBL-2' });
    });

    it('REQ-106: two phones racing for one table: exactly one wins', async () => {
      const [a, b] = await Promise.all([open('TBL-6', {}, 'race-a'), open('TBL-6', {}, 'race-b', 'CASHIER2')]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('REQ-034: skipping the guest count still opens the session', async () => {
      const res = await open('TBL-3').expect(201);
      expect(res.body.guest_count).toBeNull();
    });

    it('REQ-112/REQ-111: a missing key or an unknown field is 400; Kitchen is 403; unknown table 404; inactive table 409', async () => {
      await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).send({ table_id: 'TBL-4' }).expect(400);
      const unknown = await open('TBL-4', { status: 'PAID' }).expect(400);
      expect(unknown.body.code).toBe('VALIDATION_FAILED');
      await open('TBL-4', { id: 'ORD-X' }).expect(400);
      await open('TBL-4', { guest_count: 0 }).expect(400);
      expect((await open('TBL-4', {}, undefined, 'KITCHEN').expect(403)).body.code).toBe('ACCESS_DENIED');
      await open('TBL-404').expect(404);
      expect((await open('TBL-5').expect(409)).body.code).toBe('TABLE_INACTIVE');
    });
  });

  describe('GET /orders/:id', () => {
    let orderId: string;
    beforeAll(async () => {
      orderId = (await open('TBL-7', { guest_count: 2 }).expect(201)).body.id;
      await sendKot(orderId, 11, [{ variant: 'VAR-1', qty: 1, price: '220.00', name: 'Butter Chicken' }]);
      await sendKot(orderId, 14, [{ variant: 'VAR-2', qty: 2, price: '20.00', name: 'Tandoori Roti' }, { variant: 'VAR-2', qty: 1, price: '20.00', name: 'Tandoori Roti' }]);
    });

    it('REQ-035: lists each sent item under its own KOT number, oldest first, with payments and server totals', async () => {
      const res = await http().get(`/api/v1/orders/${orderId}`).set(as('CASHIER')).expect(200);
      expect(res.body.kots.map((k: { kot_number: number }) => k.kot_number)).toEqual([11, 14]);
      expect(res.body.kots[0].lines.map((l: { item_name_snapshot: string }) => l.item_name_snapshot)).toEqual(['Butter Chicken']);
      expect(res.body.kots[1].lines).toHaveLength(2);
      expect(res.body.kots[1].lines.every((l: { kot_id: string }) => l.kot_id === res.body.kots[1].id)).toBe(true);
      expect(res.body).toMatchObject({ subtotal: '280.00', grand_total: '280.00', balance_due: '280.00', payments: [] });
    });

    it('REQ-035: a Ready to Close (BILLED) order also opens in the order view', async () => {
      await setOrder(orderId, { status: 'BILLED' });
      const res = await http().get(`/api/v1/orders/${orderId}`).set(as('CASHIER2')).expect(200);
      expect(res.body.status).toBe('BILLED');
      expect(res.body.kots).toHaveLength(2);
      await setOrder(orderId, { status: 'OPEN' });
    });

    it('REQ-020/REQ-021: Kitchen is 403; an unknown order is 404', async () => {
      await http().get(`/api/v1/orders/${orderId}`).set(as('KITCHEN')).expect(403);
      expect((await http().get('/api/v1/orders/ORD-NOPE').set(as('CASHIER')).expect(404)).body.code).toBe('NOT_FOUND');
    });

    it("REQ-020: a Cashier asking for another cashier's closed order from today is refused; own and Admin are fine", async () => {
      const mine = (await open('TBL-8', {}, undefined, 'CASHIER2').expect(201)).body.id;
      await setOrder(mine, { status: 'PAID' });
      const refused = await http().get(`/api/v1/orders/${mine}`).set(as('CASHIER')).expect(403);
      expect(refused.body.code).toBe('ORDER_NOT_VISIBLE');
      await http().get(`/api/v1/orders/${mine}`).set(as('CASHIER2')).expect(200);
      await http().get(`/api/v1/orders/${mine}`).set(as('ADMIN')).expect(200);
    });
  });

  describe('POST /orders/:id/move', () => {
    it('REQ-037: moves the session to a free table, frees the old one and writes a MOVE audit row', async () => {
      const order = (await open('TBL-10', {}, 'move-src').expect(201)).body;
      events.length = 0;
      const res = await http().post(`/api/v1/orders/${order.id}/move`).set(as('CASHIER')).set('If-Match', String(order.row_version)).send({ table_id: 'TBL-4' }).expect(200);
      expect(res.body).toMatchObject({ id: order.id, table_id: 'TBL-4', table_label_snapshot: 'T4', row_version: order.row_version + 1 });
      expect(await card('TBL-10')).toMatchObject({ status: 'AVAILABLE' });
      expect(await card('TBL-4')).toMatchObject({ status: 'OCCUPIED', order_id: order.id });
      const row = storage.store.findBy('audit_log', 'entity_id', order.id).find((a) => a.action === 'MOVE');
      expect(row).toMatchObject({ user_id: 'USR-C', before_json: { table_id: 'TBL-10' }, after_json: { table_id: 'TBL-4' } });
      expect(events.filter((e) => e.event === 'table.status_changed').map((e) => e.payload.table_id)).toEqual(['TBL-10', 'TBL-4']);
    });

    it('REQ-037: moving to an occupied table is 409 TABLE_BUSY and changes nothing', async () => {
      const order = storage.store.findUnique('orders', 'client_request_id', 'move-src')!;
      const audits = storage.store.all('audit_log').length;
      const res = await http().post(`/api/v1/orders/${order.id}/move`).set(as('CASHIER')).set('If-Match', String(order.row_version)).send({ table_id: 'TBL-2' }).expect(409);
      expect(res.body.code).toBe('TABLE_BUSY');
      expect(storage.store.get('orders', order.id)!.table_id).toBe('TBL-4');
      expect(storage.store.all('audit_log').length).toBe(audits);
    });

    it('REQ-113: a stale If-Match is 409 ROW_VERSION_CONFLICT; a missing one is 428; Kitchen is 403', async () => {
      const order = storage.store.findUnique('orders', 'client_request_id', 'move-src')!;
      const stale = await http().post(`/api/v1/orders/${order.id}/move`).set(as('ADMIN')).set('If-Match', '1').send({ table_id: 'TBL-10' }).expect(409);
      expect(stale.body.code).toBe('ROW_VERSION_CONFLICT');
      await http().post(`/api/v1/orders/${order.id}/move`).set(as('ADMIN')).send({ table_id: 'TBL-10' }).expect(428);
      await http().post(`/api/v1/orders/${order.id}/move`).set(as('KITCHEN')).set('If-Match', String(order.row_version)).send({ table_id: 'TBL-10' }).expect(403);
    });
  });

  describe('POST /orders/:id/merge', () => {
    it('REQ-037: the bill includes both tables\' items, the source is closed with merged_into_order_id and a MERGE audit row is written', async () => {
      const target = storage.store.findUnique('orders', 'client_request_id', 'open-t2')!;
      const source = storage.store.findUnique('orders', 'client_request_id', 'move-src')!;
      await sendKot(target.id, 21, [{ variant: 'VAR-1', qty: 1, price: '220.00', name: 'Butter Chicken' }]);
      await sendKot(source.id, 22, [{ variant: 'VAR-2', qty: 2, price: '20.00', name: 'Tandoori Roti' }]);
      await setOrder(target.id, { status: 'BILLED', bill_no: 'B-20261105-002' });
      const current = storage.store.get('orders', target.id)!;
      const res = await http().post(`/api/v1/orders/${target.id}/merge`).set(as('CASHIER')).set('If-Match', String(current.row_version)).send({ source_order_id: source.id }).expect(200);
      expect(res.body).toMatchObject({ id: target.id, subtotal: '260.00', grand_total: '260.00', balance_due: '260.00', status: 'OPEN', bill_no: 'B-20261105-002' });
      const names = res.body.kots.flatMap((k: { lines: { item_name_snapshot: string }[] }) => k.lines.map((l) => l.item_name_snapshot));
      expect(names.sort()).toEqual(['Butter Chicken', 'Tandoori Roti']);
      expect(res.body.kots.map((k: { kot_number: number }) => k.kot_number)).toEqual([21, 22]);
      expect(storage.store.get('orders', source.id)).toMatchObject({ status: 'CANCELLED', merged_into_order_id: target.id, grand_total: '0.00' });
      expect(await card('TBL-4')).toMatchObject({ status: 'AVAILABLE' });
      expect(await card('TBL-2')).toMatchObject({ status: 'OCCUPIED', running_total: '260.00' });
      const row = storage.store.findBy('audit_log', 'entity_id', target.id).find((a) => a.action === 'MERGE');
      expect(row).toMatchObject({ user_id: 'USR-C', before_json: { source_order_id: source.id } });
      expect(storage.store.findBy('exceptions', 'order_id', target.id)).toEqual([expect.objectContaining({ exception_type: 'BILL_REOPEN', reason_code: 'MERGE' })]);
    });

    it('REQ-037: a source with a payment is 409 SOURCE_HAS_PAYMENTS; stale If-Match is 409; merging into itself is 409', async () => {
      const target = storage.store.findUnique('orders', 'client_request_id', 'open-t2')!;
      const source = (await open('TBL-10', {}, 'merge-paid').expect(201)).body;
      await storage.queue.run((tx) => tx.create('payments', {
        id: 'PAY-T1', order_id: source.id, business_date: '2026-11-05', method: 'CASH', amount: '10.00', tendered_amount: null,
        upi_ref: null, status: 'SUCCESS', void_reason: null, voided_by: null, idempotency_key: 'pay-t1',
      }, 'USR-C'));
      const merge = (id: string, version: number, source_order_id: string) =>
        http().post(`/api/v1/orders/${id}/merge`).set(as('ADMIN')).set('If-Match', String(version)).send({ source_order_id });
      expect((await merge(target.id, target.row_version, source.id).expect(409)).body.code).toBe('SOURCE_HAS_PAYMENTS');
      expect((await merge(target.id, target.row_version - 1, source.id).expect(409)).body.code).toBe('ROW_VERSION_CONFLICT');
      expect((await merge(target.id, target.row_version, target.id).expect(409)).body.code).toBe('SAME_ORDER');
      expect(storage.store.get('orders', source.id)!.status).toBe('OPEN');
    });
  });
});
