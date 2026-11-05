import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DiningTable, Order, Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { addMinutes, kitchenBoard } from '../src/kitchen/kots';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { TxEvent } from '../src/storage/write-queue';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, seededData, tempDir } from './fixtures';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const table = (id: string, table_number: string): DiningTable => ({ id, table_number, area: 'Hall', seats: 4, is_active: true, ...audit });
const MIN = 60_000;

/** Every leaf value of a JSON payload. */
function leaves(v: unknown): unknown[] {
  if (v && typeof v === 'object') return Object.values(v as object).flatMap(leaves);
  return [v];
}

describe('send to kitchen, kitchen board, KOT lifecycle and item cancel (WI-008)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let clock = Date.now();
  const events: TxEvent[] = [];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  let keyN = 0;
  const key = (p = 'k') => `${p}-${++keyN}`;
  const openTable = async (table_id: string): Promise<Order> =>
    (await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).set('Idempotency-Key', key('open')).send({ table_id }).expect(201)).body;
  const send = (orderId: string, lines: unknown[], k = key('send'), who: Role = 'CASHIER') =>
    http().post(`/api/v1/orders/${orderId}/kots`).set(as(who)).set('Idempotency-Key', k).send({ lines });
  const board = async (who: Role = 'KITCHEN') => (await http().get('/api/v1/kitchen/kots').set(as(who)).expect(200)).body;
  const status = (id: string, version: number, to: string, who: Role = 'KITCHEN') =>
    http().patch(`/api/v1/kots/${id}/status`).set(as(who)).set('If-Match', String(version)).send({ status: to });
  const cancel = (lineId: string, body: Record<string, unknown>, headers: Record<string, string> = {}, who: Role = 'CASHIER') => {
    const version = storage.store.get('order_items', lineId)!.row_version;
    return http().post(`/api/v1/order-items/${lineId}/cancel`).set(as(who)).set('If-Match', String(version)).set(headers).send(body);
  };
  const order = (id: string) => storage.store.get('orders', id)!;
  const tableCard = async (id: string) => (await http().get('/api/v1/tables').set(as('CASHIER')).expect(200)).body.find((c: { id: string }) => c.id === id);
  const bc = (quantity = 1, note?: string) => ({ variant_id: 'VAR-1', quantity, ...(note !== undefined ? { note } : {}) });
  const roti = (quantity = 1, note?: string) => ({ variant_id: 'VAR-2', quantity, ...(note !== undefined ? { note } : {}) });

  beforeAll(async () => {
    const dir = tempDir();
    const data = seededData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    for (let i = 2; i <= 9; i++) data.tables.push(table(`TBL-${i}`, `T${i}`));
    // A third item to make unavailable.
    data.items.push({ ...data.items[1], id: 'ITM-3', name_en: 'Paneer Tikka', name_hi: 'पनीर टिक्का', short_code: 'PT' });
    data.variants.push({ ...data.variants[1], id: 'VAR-3', item_id: 'ITM-3', name: 'Full', price: '180.00' });
    // The fixture's KOT is old news; keep it off the board.
    data.kots[0].hide_after = NOW;
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    storage.queue.onCommit((_, evs) => events.push(...evs));
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => clock });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    tokens.KITCHEN = await login('USR-K', '9012');
  });

  beforeEach(() => {
    clock = Date.now();
    events.length = 0;
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  describe('POST /orders/:id/kots', () => {
    it('REQ-049: 3 items to a new table make one OPEN order, one NEW KOT and 3 lines; the next send holds only the new lines', async () => {
      const o = await openTable('TBL-2');
      const first = await send(o.id, [bc(1), roti(2), roti(1, 'No onion')]).expect(201);
      expect(first.body).toMatchObject({ order_id: o.id, status: 'NEW', business_date: expect.any(String) });
      expect(first.body.kot_number).toBeGreaterThan(0);
      expect(first.body.id).toMatch(/^KOT-\d{8}-\d{4}$/);
      expect(first.body.lines).toHaveLength(3);
      expect(order(o.id)).toMatchObject({ status: 'OPEN', subtotal: '280.00', grand_total: '280.00', balance_due: '280.00' });
      expect(storage.store.findBy('kots', 'order_id', o.id)).toHaveLength(1);

      const second = await send(o.id, [bc(1), roti(1)]).expect(201);
      expect(second.body.kot_number).toBe(first.body.kot_number + 1);
      expect(second.body.order_id).toBe(o.id);
      expect(second.body.lines.map((l: { variant_id: string }) => l.variant_id)).toEqual(['VAR-1', 'VAR-2']);
      expect(storage.store.findBy('order_items', 'kot_id', second.body.id)).toHaveLength(2);
      expect(storage.store.findBy('order_items', 'order_id', o.id)).toHaveLength(5);

      // REQ-047: the order view lists sent lines under their KOTs.
      const view = (await http().get(`/api/v1/orders/${o.id}`).set(as('CASHIER')).expect(200)).body;
      expect(view.kots.map((k: { lines: unknown[] }) => k.lines.length)).toEqual([3, 2]);
      expect(view.subtotal).toBe('520.00');
    });

    it('REQ-114: prices and names come from the menu; a client-sent price is ignored', async () => {
      const o = await openTable('TBL-3');
      const res = await send(o.id, [{ variant_id: 'VAR-1', quantity: 2, unit_price: '1.00', line_total: '2.00' }]).expect(201);
      expect(res.body.lines[0]).toMatchObject({ unit_price: '220.00', line_total: '440.00', item_name_snapshot: 'Butter Chicken', variant_name_snapshot: 'Half', status: 'ACTIVE' });
    });

    it('REQ-049/REQ-112: five quick taps with one key write exactly one KOT; repeats answer 200 with the same KOT', async () => {
      const o = await openTable('TBL-4');
      const k = key('tap');
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => send(o.id, [roti(1)], k)));
      expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(storage.store.findBy('kots', 'order_id', o.id)).toHaveLength(1);
      expect(storage.store.findBy('order_items', 'order_id', o.id)).toHaveLength(1);
    });

    it('REQ-049/REQ-047/REQ-048: empty cart, qty 0 or 100, note over 80 chars, missing key and the Kitchen role are rejected', async () => {
      const o = await openTable('TBL-5');
      expect((await send(o.id, []).expect(400)).body.code).toBe('EMPTY_CART');
      await send(o.id, [bc(100)]).expect(400);
      await send(o.id, [bc(0)]).expect(400);
      await send(o.id, [bc(1, 'x'.repeat(81))]).expect(400);
      await send(o.id, [{ ...bc(1), id: 'OI-X' }]).expect(400);
      await http().post(`/api/v1/orders/${o.id}/kots`).set(as('CASHIER')).send({ lines: [bc(1)] }).expect(400);
      await send(o.id, [bc(1)], key(), 'KITCHEN').expect(403);
      await send('ORD-NOPE', [bc(1)]).expect(404);
      expect(storage.store.findBy('kots', 'order_id', o.id)).toHaveLength(0);
      await send(o.id, [bc(99, 'x'.repeat(80))]).expect(201);
    });

    it('REQ-045: an item that became unavailable rejects only its line; the others can be sent', async () => {
      const o = await openTable('TBL-6');
      await storage.queue.run((tx) => tx.update('items', tx.get('items', 'ITM-3')!, { available_today: false }, 'USR-K'));
      events.length = 0;
      const res = await send(o.id, [bc(1), { variant_id: 'VAR-3', quantity: 2 }, roti(1)]).expect(422);
      expect(res.body.code).toBe('ITEM_UNAVAILABLE');
      expect(res.body.details.lines).toEqual([{ index: 1, variant_id: 'VAR-3', item_id: 'ITM-3', name_en: 'Paneer Tikka', name_hi: 'पनीर टिक्का', reason: 'NOT_AVAILABLE_TODAY' }]);
      expect(storage.store.findBy('kots', 'order_id', o.id)).toHaveLength(0);
      expect(events).toHaveLength(0);
      // The cart keeps the others; sending them works.
      const ok = await send(o.id, [bc(1), roti(1)]).expect(201);
      expect(ok.body.lines).toHaveLength(2);
      await storage.queue.run((tx) => tx.update('items', tx.get('items', 'ITM-3')!, { available_today: true }, 'USR-K'));
    });

    it('REQ-060: sending on a BILLED order reopens it to OPEN, turns the table Occupied and writes a BILL_REOPEN exception', async () => {
      const o = await openTable('TBL-7');
      await send(o.id, [roti(2)]).expect(201);
      await storage.queue.run((tx) => tx.update('orders', tx.get('orders', o.id)!, { status: 'BILLED', bill_no: 'B-20261105-901' }, 'USR-C'));
      expect(await tableCard('TBL-7')).toMatchObject({ status: 'READY_TO_CLOSE' });
      await send(o.id, [bc(1)]).expect(201);
      expect(order(o.id)).toMatchObject({ status: 'OPEN', bill_no: 'B-20261105-901', subtotal: '260.00' });
      expect(await tableCard('TBL-7')).toMatchObject({ status: 'OCCUPIED' });
      const exc = storage.store.findBy('exceptions', 'order_id', o.id);
      expect(exc).toEqual([expect.objectContaining({ exception_type: 'BILL_REOPEN', requested_by: 'USR-C', amount: null, approved_by: null })]);
      expect(storage.store.all('audit_log').some((a) => a.action === 'BILL_REOPEN' && a.entity_id === o.id)).toBe(true);
    });

    it('REQ-127: a send emits kot.created with the money-free card, table.status_changed and dashboard.updated', async () => {
      const o = await openTable('TBL-8');
      events.length = 0;
      const res = await send(o.id, [bc(1, 'No onion')]).expect(201);
      const names = events.map((e) => e.event);
      expect(names).toEqual(expect.arrayContaining(['kot.created', 'table.status_changed', 'order.updated', 'dashboard.updated']));
      const created = events.find((e) => e.event === 'kot.created')!.payload.kot as Record<string, unknown>;
      expect(created).toMatchObject({ id: res.body.id, table_label: 'T8', status: 'NEW', lines: [expect.objectContaining({ item_name: 'Butter Chicken', note: 'No onion' })] });
      expect(leaves(created)).not.toContain('220.00');
    });
  });

  describe('GET /kitchen/kots', () => {
    it('REQ-021: a Kitchen fetch of a KOT with a ₹220 Butter Chicken line carries no 220 anywhere', async () => {
      const list = await board('KITCHEN');
      const withBc = list.filter((k: { lines: { item_name: string }[] }) => k.lines.some((l) => l.item_name === 'Butter Chicken'));
      expect(withBc.length).toBeGreaterThan(0);
      for (const v of leaves(list)) expect([220, '220', '220.00']).not.toContain(v);
      const text = JSON.stringify(list);
      for (const field of ['price', 'line_total', 'subtotal', 'grand_total', 'balance_due', 'amount']) expect(text).not.toContain(`"${field}`);
    });

    it('REQ-051/REQ-048: oldest first, with table, names, variant, qty and notes', async () => {
      const list = await board();
      const sent = list.map((k: { sent_at: string }) => Date.parse(k.sent_at));
      expect([...sent].sort((a, b) => a - b)).toEqual(sent);
      const t8 = list.find((k: { table_label: string }) => k.table_label === 'T8');
      expect(t8.lines[0]).toEqual({ id: expect.any(String), item_name: 'Butter Chicken', item_name_hi: 'बटर चिकन', variant_name: 'Half', food_type: 'NON_VEG', quantity: 1, note: 'No onion', cancelled: false });
    });

    it('REQ-055: with the default limit, 16 minutes waiting is Late and 14 is not', async () => {
      const o = await openTable('TBL-9');
      const res = await send(o.id, [roti(1)]).expect(201);
      const sentAt = Date.parse(res.body.sent_at);
      clock = sentAt + 14 * MIN;
      let card = (await board()).find((k: { id: string }) => k.id === res.body.id);
      expect(card).toMatchObject({ minutes_waiting: 14, late: false });
      clock = sentAt + 16 * MIN;
      card = (await board()).find((k: { id: string }) => k.id === res.body.id);
      expect(card).toMatchObject({ minutes_waiting: 16, late: true });
    });
  });

  describe('PATCH /kots/:id/status', () => {
    let kotId: string;
    let orderId: string;

    beforeAll(async () => {
      const o = storage.store.all('orders').find((x) => x.table_id === 'TBL-9' && x.status === 'OPEN')!;
      orderId = o.id;
      kotId = storage.store.findBy('kots', 'order_id', o.id)[0].id;
    });

    it('REQ-052: NEW → READY is rejected; If-Match missing is 428; a stale version is 409 with the KOT', async () => {
      const res = await status(kotId, 1, 'READY').expect(422);
      expect(res.body).toMatchObject({ code: 'ILLEGAL_TRANSITION', details: { from: 'NEW', to: 'READY', allowed: ['PREPARING'] } });
      await http().patch(`/api/v1/kots/${kotId}/status`).set(as('KITCHEN')).send({ status: 'PREPARING' }).expect(428);
      const stale = await status(kotId, 7, 'PREPARING').expect(409);
      expect(stale.body.details.current).toMatchObject({ id: kotId, status: 'NEW' });
      await status(kotId, 1, 'CANCELLED').expect(400);
    });

    it('REQ-052/REQ-081/REQ-095: START PREPARING then MARK READY; Ready leaves the order unpaid and the table not Available', async () => {
      await status(kotId, 1, 'PREPARING').expect(200);
      const ready = await status(kotId, 2, 'READY').expect(200);
      expect(ready.body).toMatchObject({ status: 'READY', hide_after: null });
      const ev = events.filter((e) => e.event === 'kot.status_changed').pop()!;
      expect(ev.payload).toMatchObject({ kot_id: kotId, status: 'READY', order_id: orderId, table_id: 'TBL-9' });
      expect(order(orderId)).toMatchObject({ status: 'OPEN', balance_due: '20.00' });
      expect(await tableCard('TBL-9')).toMatchObject({ status: 'OCCUPIED' });
      const rows = storage.store.all('audit_log').filter((a) => a.entity_id === kotId && a.action === 'STATUS_CHANGE');
      expect(rows.map((a) => [a.before_json, (a.after_json as { status: string }).status])).toEqual([[{ status: 'NEW' }, 'PREPARING'], [{ status: 'PREPARING' }, 'READY']]);
    });

    it('REQ-054: a Ready KOT unserved and unpaid stays on the board after 30 minutes', async () => {
      clock = Date.now() + 30 * MIN;
      expect((await board()).map((k: { id: string }) => k.id)).toContain(kotId);
    });

    it('REQ-054/REQ-095: SERVED sets served_at and hide_after; the card is gone 10 minutes later; the table stays Occupied with balance due', async () => {
      const served = await status(kotId, 3, 'SERVED', 'CASHIER').expect(200);
      expect(served.body.served_at).toBeTruthy();
      expect(served.body.hide_after).toBe(addMinutes(served.body.served_at, 10));
      clock = Date.parse(served.body.served_at) + 9 * MIN;
      expect((await board()).map((k: { id: string }) => k.id)).toContain(kotId);
      clock = Date.parse(served.body.served_at) + 10 * MIN + 1000;
      expect((await board()).map((k: { id: string }) => k.id)).not.toContain(kotId);
      expect(await tableCard('TBL-9')).toMatchObject({ status: 'OCCUPIED' });
      await status(kotId, 4, 'PREPARING').expect(422);
    });
  });

  describe('POST /order-items/:id/cancel', () => {
    it('REQ-083: a reason is required', async () => {
      const o = await openTable('TBL-3').catch(() => null);
      const orderId = o?.id ?? storage.store.all('orders').find((x) => x.table_id === 'TBL-3' && x.status === 'OPEN')!.id;
      const line = storage.store.findBy('order_items', 'order_id', orderId)[0];
      expect((await cancel(line.id, {}).expect(400)).body.code).toBe('REASON_REQUIRED');
      await cancel(line.id, { cancel_reason: '   ' }).expect(400);
      await cancel(line.id, { cancel_reason: 'x', price: '1' }).expect(400);
    });

    it('REQ-083/REQ-051: cancelling on a NEW KOT needs no PIN, keeps the row and strikes it through on the kitchen card', async () => {
      const o = await openTable('TBL-2').catch(() => null);
      const orderId = o?.id ?? storage.store.all('orders').find((x) => x.table_id === 'TBL-2' && x.status === 'OPEN')!.id;
      const kot = (await send(orderId, [bc(1), roti(3)]).expect(201)).body;
      const before = order(orderId).subtotal;
      const res = await cancel(kot.lines[1].id, { cancel_reason: 'Customer changed mind' }).expect(200);
      expect(res.body.subtotal).toBe((Number(before) - 60).toFixed(2));
      expect(storage.store.get('order_items', kot.lines[1].id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Customer changed mind' });
      const card = (await board()).find((k: { id: string }) => k.id === kot.id);
      expect(card.status).toBe('NEW');
      expect(card.lines.map((l: { cancelled: boolean }) => l.cancelled)).toEqual([false, true]);
      expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['kot.status_changed', 'order.updated']));
      expect(storage.store.findBy('exceptions', 'order_id', orderId).filter((e) => e.exception_type === 'CANCEL_AFTER_START')).toHaveLength(0);
      // REQ-113: the old version is stale now.
      await http().post(`/api/v1/order-items/${kot.lines[1].id}/cancel`).set(as('CASHIER')).set('If-Match', '1').send({ cancel_reason: 'again' }).expect(409);
    });

    it('REQ-083: cancelling every line of a NEW KOT cancels the KOT', async () => {
      const orderId = storage.store.all('orders').find((x) => x.table_id === 'TBL-2' && x.status === 'OPEN')!.id;
      const kot = (await send(orderId, [roti(1), roti(2)]).expect(201)).body;
      await cancel(kot.lines[0].id, { reason: 'wrong table' }).expect(200);
      expect(storage.store.get('kots', kot.id)!.status).toBe('NEW');
      await cancel(kot.lines[1].id, { reason: 'wrong table' }).expect(200);
      expect(storage.store.get('kots', kot.id)).toMatchObject({ status: 'CANCELLED', hide_after: expect.any(String) });
      expect(order(orderId).status).toBe('OPEN');
    });

    it('REQ-083/REQ-023: on a PREPARING KOT a Cashier needs an approval token; with one, both user ids and an exception are recorded', async () => {
      const orderId = storage.store.all('orders').find((x) => x.table_id === 'TBL-2' && x.status === 'OPEN')!.id;
      const kot = (await send(orderId, [bc(1), roti(1)]).expect(201)).body;
      await status(kot.id, 1, 'PREPARING').expect(200);
      const denied = await cancel(kot.lines[0].id, { cancel_reason: 'Burnt' }).expect(403);
      expect(denied.body.code).toBe('APPROVAL_INVALID');
      expect(storage.store.get('order_items', kot.lines[0].id)!.status).toBe('ACTIVE');
      await cancel(kot.lines[0].id, { cancel_reason: 'Burnt' }, { 'X-Approval-Token': 'bogus' }).expect(403);

      const approval = (await http().post('/api/v1/auth/approvals').set(as('CASHIER')).set('Idempotency-Key', key('appr')).send({ pin: '1234' }).expect(201)).body;
      await cancel(kot.lines[0].id, { cancel_reason: 'Burnt' }, { 'X-Approval-Token': approval.approval_token }).expect(200);
      const exc = storage.store.findBy('exceptions', 'order_id', orderId).filter((e) => e.exception_type === 'CANCEL_AFTER_START');
      expect(exc).toEqual([expect.objectContaining({ requested_by: 'USR-C', approved_by: 'ADM-1', amount: '220.00', reason_text: 'Burnt' })]);
      const row = storage.store.all('audit_log').find((a) => a.action === 'CANCEL' && a.entity_id === kot.lines[0].id)!;
      expect(row).toMatchObject({ user_id: 'USR-C', approver_id: 'ADM-1' });
      // Single use: the same token cannot cancel the other line.
      await cancel(kot.lines[1].id, { cancel_reason: 'Burnt' }, { 'X-Approval-Token': approval.approval_token }).expect(403);
      // An Admin acts without a token.
      await cancel(kot.lines[1].id, { cancel_reason: 'Burnt' }, {}, 'ADMIN').expect(200);
      expect(storage.store.get('kots', kot.id)!.status).toBe('CANCELLED');
    });

    it('REQ-083/REQ-033: cancelling every item of an OPEN order cancels the order and frees the table', async () => {
      const orderId = storage.store.all('orders').find((x) => x.table_id === 'TBL-5' && x.status === 'OPEN')!.id;
      const lines = storage.store.findBy('order_items', 'order_id', orderId).filter((l) => l.status === 'ACTIVE');
      for (const l of lines) await cancel(l.id, { cancel_reason: 'Guests left' }).expect(200);
      expect(order(orderId)).toMatchObject({ status: 'CANCELLED', subtotal: '0.00', balance_due: '0.00' });
      expect(await tableCard('TBL-5')).toMatchObject({ status: 'AVAILABLE' });
      expect(events.some((e) => e.event === 'table.status_changed' && e.payload.table_id === 'TBL-5' && e.payload.status === 'AVAILABLE')).toBe(true);
      await send(orderId, [roti(1)]).expect(409);
    });
  });

  it('REQ-051/REQ-054: kitchenBoard hides KOTs past hide_after and orders by sent_at', () => {
    const now = Date.parse('2026-11-05T13:00:00+05:30');
    const ids = kitchenBoard(storage.store, now).map((k) => k.id);
    expect(ids).not.toContain('KOT-20261105-0001');
  });
});
