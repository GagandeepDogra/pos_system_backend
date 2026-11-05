// HTTP checks of the open bills list, payments, voids, close-with-exception and
// the receipt print log (WI-010).
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Order, Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { TxEvent } from '../src/storage/write-queue';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, tempDir } from './fixtures';
import { sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
// VAR-1 ₹220, VAR-4 ₹60, VAR-5 ₹180 in the sample session.
const BILL_800 = [{ variant_id: 'VAR-1', quantity: 2 }, { variant_id: 'VAR-5', quantity: 2 }];
const BILL_300 = [{ variant_id: 'VAR-5', quantity: 1 }, { variant_id: 'VAR-4', quantity: 2 }];

describe('payments, voids and close with exception over HTTP (WI-010)', () => {
  let app: INestApplication;
  let storage: StorageService;
  const events: TxEvent[] = [];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  let keyN = 0;
  let tableN = 10;
  const order = (id: string): Order => storage.store.get('orders', id)!;
  const tableCard = async (tableId: string) =>
    (await http().get('/api/v1/tables').set(as('CASHIER')).expect(200)).body.find((c: { id: string }) => c.id === tableId);

  /** Opens a fresh table, sends `lines` and prints the bill; returns the BILLED order. */
  const billedTable = async (lines: object[]): Promise<Order> => {
    const table_id = `TBL-${++tableN}`;
    await storage.queue.run((tx) => tx.insert('tables', { id: table_id, table_number: String(tableN), area: 'Hall', seats: 4, is_active: true, ...audit }));
    const o: Order = (await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).set('Idempotency-Key', `open-${++keyN}`).send({ table_id }).expect(201)).body;
    await http().post(`/api/v1/orders/${o.id}/kots`).set(as('CASHIER')).set('Idempotency-Key', `send-${++keyN}`).send({ lines }).expect(201);
    return (await http().post(`/api/v1/orders/${o.id}/bill`).set(as('CASHIER')).set('If-Match', String(order(o.id).row_version)).expect(200)).body;
  };
  const pay = (id: string, body: object, key = `pay-${++keyN}`, who: Role = 'CASHIER') =>
    http().post(`/api/v1/orders/${id}/payments`).set(as(who)).set('Idempotency-Key', key).send(body);
  const voidPay = (id: string, body: object, headers: Record<string, string> = {}, who: Role = 'ADMIN') =>
    http().post(`/api/v1/payments/${id}/void`).set(as(who)).set('If-Match', String(storage.store.get('payments', id)!.row_version)).set(headers).send(body);
  const closeExc = (id: string, body: object, headers: Record<string, string> = {}, who: Role = 'ADMIN') =>
    http().post(`/api/v1/orders/${id}/close-exception`).set(as(who)).set('If-Match', String(order(id).row_version)).set(headers).send(body);
  const approval = async () =>
    (await http().post('/api/v1/auth/approvals').set(as('CASHIER')).set('Idempotency-Key', `appr-${++keyN}`).send({ pin: '1234' }).expect(201)).body.approval_token as string;
  const openBillIds = async (): Promise<string[]> =>
    (await http().get('/api/v1/bills/open').set(as('CASHIER')).expect(200)).body.map((b: Order) => b.id);

  beforeAll(async () => {
    const dir = tempDir();
    const data = sampleSessionData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    storage.queue.onCommit((_, evs) => events.push(...evs));
    const auth = new AuthService(storage, { jwtSecret: SECRET });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    tokens.KITCHEN = await login('USR-K', '9012');
  });

  beforeEach(() => { events.length = 0; });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  describe('open bills (REQ-062)', () => {
    it('REQ-062: lists OPEN/BILLED orders with a balance, label and Ready to Close badge; paying to zero removes the row', async () => {
      const o = await billedTable(BILL_300);
      const res = await http().get('/api/v1/bills/open').set(as('CASHIER')).expect(200);
      const row = res.body.find((b: Order) => b.id === o.id);
      expect(row).toMatchObject({ status: 'BILLED', balance_due: '300.00', ready_to_close: true, label: o.table_label_snapshot });
      expect(res.body.every((b: Order) => Number(b.balance_due) > 0 && ['OPEN', 'BILLED'].includes(b.status))).toBe(true);
      await pay(o.id, { method: 'CASH', amount: '300' }).expect(201);
      expect(await openBillIds()).not.toContain(o.id);
    });

    it('REQ-021: the Kitchen role gets 403', async () => {
      await http().get('/api/v1/bills/open').set(as('KITCHEN')).expect(403);
    });
  });

  describe('record payment (REQ-063..066)', () => {
    it('REQ-064/REQ-066: ₹500 UPI then ₹300 Cash on an ₹800 bill gives two Payments rows, a PAID order and an Available table', async () => {
      const o = await billedTable(BILL_800);
      expect(o.grand_total).toBe('800.00');
      const first = await pay(o.id, { method: 'UPI', amount: '500' }).expect(201);
      expect(first.body).toMatchObject({ order_id: o.id, method: 'UPI', amount: '500.00', status: 'SUCCESS', upi_ref: null });
      expect(order(o.id)).toMatchObject({ status: 'BILLED', paid_amount: '500.00', balance_due: '300.00' });
      expect(events).toContainEqual(expect.objectContaining({ event: 'payment.recorded', payload: expect.objectContaining({ payment_id: first.body.id, balance_due: '300.00' }) }));

      events.length = 0;
      await pay(o.id, { method: 'CASH', amount: '300', tendered_amount: '500' }).expect(201)
        .expect((r) => expect(r.body).toMatchObject({ amount: '300.00', tendered_amount: '500.00', change_due: '200.00' }));
      expect(storage.store.findBy('payments', 'order_id', o.id)).toHaveLength(2);
      expect(order(o.id)).toMatchObject({ status: 'PAID', paid_amount: '800.00', balance_due: '0.00' });
      expect((await tableCard(o.table_id!)).status).toBe('AVAILABLE');
      expect(events).toContainEqual(expect.objectContaining({ event: 'table.status_changed', payload: expect.objectContaining({ table_id: o.table_id, status: 'AVAILABLE' }) }));
      // REQ-054: the order's KOTs leave the kitchen board 10 minutes after payment.
      for (const k of storage.store.findBy('kots', 'order_id', o.id)) expect(k.hide_after).not.toBeNull();
    });

    it('REQ-063: a UPI payment without a UTR succeeds; a UTR is kept; tendered is ignored for non-cash', async () => {
      const o = await billedTable(BILL_300);
      await pay(o.id, { method: 'UPI', amount: '100' }).expect(201);
      const withRef = await pay(o.id, { method: 'UPI', amount: '100', upi_ref: '412345678901' }).expect(201);
      expect(withRef.body.upi_ref).toBe('412345678901');
      const card = await pay(o.id, { method: 'CARD', amount: '50', tendered_amount: '100' }).expect(201);
      expect(card.body).toMatchObject({ tendered_amount: null, change_due: null });
      expect(order(o.id).balance_due).toBe('50.00');
    });

    it('REQ-066: a payment above the balance is rejected with 422 OVERPAYMENT and records nothing', async () => {
      const o = await billedTable(BILL_300);
      events.length = 0;
      const res = await pay(o.id, { method: 'CASH', amount: '300.01' }).expect(422);
      expect(res.body).toMatchObject({ code: 'OVERPAYMENT', details: { amount: '300.01', balance_due: '300.00' } });
      expect(storage.store.findBy('payments', 'order_id', o.id)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    it('REQ-112: a missing key, a zero or negative amount, an unknown method or short cash tendered is 400', async () => {
      const o = await billedTable(BILL_300);
      await http().post(`/api/v1/orders/${o.id}/payments`).set(as('CASHIER')).send({ method: 'CASH', amount: '10' }).expect(400);
      await pay(o.id, { method: 'CASH', amount: '0' }).expect(400);
      await pay(o.id, { method: 'CASH', amount: '-5' }).expect(400);
      await pay(o.id, { method: 'CHEQUE', amount: '5' }).expect(400);
      await pay(o.id, { method: 'CASH', amount: '100', tendered_amount: '50' }).expect(400);
      await pay(o.id, { method: 'CASH', amount: '100', status: 'VOIDED' }).expect(400);
      expect(storage.store.findBy('payments', 'order_id', o.id)).toHaveLength(0);
    });

    it('REQ-065: two requests with the same key create one Payments row; the repeat returns the original with 200', async () => {
      const o = await billedTable(BILL_300);
      const [a, b] = await Promise.all([pay(o.id, { method: 'CASH', amount: '100' }, 'dup-key'), pay(o.id, { method: 'CASH', amount: '100' }, 'dup-key')]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      const again = await pay(o.id, { method: 'CASH', amount: '100' }, 'dup-key').expect(200);
      expect(again.body).toMatchObject({ id: a.body.id, amount: '100.00' });
      expect(storage.store.findBy('payments', 'order_id', o.id)).toHaveLength(1);
      expect(order(o.id).balance_due).toBe('200.00');
    });

    it('REQ-066: a paid order takes no more payments (409 ORDER_NOT_OPEN); an unknown order is 404; Kitchen is 403', async () => {
      const o = await billedTable(BILL_300);
      await pay(o.id, { method: 'CASH', amount: '300' }).expect(201);
      expect((await pay(o.id, { method: 'CASH', amount: '1' }).expect(409)).body.code).toBe('ORDER_NOT_OPEN');
      await pay('ORD-NOPE', { method: 'CASH', amount: '1' }).expect(404);
      await pay(o.id, { method: 'CASH', amount: '1' }, undefined, 'KITCHEN').expect(403);
    });
  });

  describe('void (REQ-068)', () => {
    it('REQ-068: a Cashier void without approval is 403; the payment is unchanged', async () => {
      const o = await billedTable(BILL_300);
      const p = (await pay(o.id, { method: 'CASH', amount: '100' }).expect(201)).body;
      expect((await voidPay(p.id, { void_reason: 'Wrong table' }, {}, 'CASHIER').expect(403)).body.code).toBe('APPROVAL_INVALID');
      expect(storage.store.get('payments', p.id)!.status).toBe('SUCCESS');
    });

    it('REQ-068: a void without a reason is 400; a stale If-Match is 409', async () => {
      const o = await billedTable(BILL_300);
      const p = (await pay(o.id, { method: 'CASH', amount: '100' }).expect(201)).body;
      expect((await voidPay(p.id, {}).expect(400)).body.code).toBe('REASON_REQUIRED');
      await http().post(`/api/v1/payments/${p.id}/void`).set(as('ADMIN')).set('If-Match', '99').send({ void_reason: 'x' }).expect(409);
    });

    it('REQ-068/REQ-082: an Admin void keeps the row as VOIDED, raises the balance by the amount and reopens a PAID order', async () => {
      const o = await billedTable(BILL_800);
      const upi = (await pay(o.id, { method: 'UPI', amount: '500' }).expect(201)).body;
      await pay(o.id, { method: 'CASH', amount: '300' }).expect(201);
      expect(order(o.id).status).toBe('PAID');
      const res = await voidPay(upi.id, { void_reason: 'UPI did not arrive' }).expect(200);
      expect(res.body).toMatchObject({ id: upi.id, status: 'VOIDED', void_reason: 'UPI did not arrive', voided_by: 'ADM-1' });
      expect(order(o.id)).toMatchObject({ status: 'BILLED', paid_amount: '300.00', balance_due: '500.00' });
      expect(storage.store.findBy('payments', 'order_id', o.id)).toHaveLength(2);
      expect(storage.store.findBy('exceptions', 'order_id', o.id)).toContainEqual(expect.objectContaining({ exception_type: 'PAYMENT_VOID', amount: '500.00', requested_by: 'ADM-1', approved_by: null }));
      expect(storage.store.findBy('audit_log', 'entity_id', upi.id).map((a) => a.action)).toContain('VOID');
      expect(events).toContainEqual(expect.objectContaining({ event: 'order.updated', payload: expect.objectContaining({ order_id: o.id, balance_due: '500.00' }) }));
      expect((await tableCard(o.table_id!)).status).toBe('READY_TO_CLOSE');
      expect(await openBillIds()).toContain(o.id);
      // Voiding twice is refused.
      expect((await voidPay(upi.id, { void_reason: 'again' }).expect(409)).body.code).toBe('ALREADY_VOIDED');
    });

    it('REQ-023: a Cashier with an Admin approval token can void; the Admin is recorded as approver', async () => {
      const o = await billedTable(BILL_300);
      const p = (await pay(o.id, { method: 'CASH', amount: '100' }).expect(201)).body;
      const res = await voidPay(p.id, { reason: 'Double entry' }, { 'X-Approval-Token': await approval() }, 'CASHIER').expect(200);
      expect(res.body).toMatchObject({ status: 'VOIDED', voided_by: 'ADM-1' });
      expect(order(o.id).balance_due).toBe('300.00');
      expect(storage.store.findBy('exceptions', 'order_id', o.id)).toContainEqual(expect.objectContaining({ exception_type: 'PAYMENT_VOID', requested_by: 'USR-C', approved_by: 'ADM-1' }));
    });
  });

  describe('close with exception (REQ-069)', () => {
    it('REQ-069: a Cashier cannot close a table with a ₹300 balance without approval', async () => {
      const o = await billedTable(BILL_300);
      await closeExc(o.id, { reason_code: 'CUSTOMER_LEFT' }, {}, 'CASHIER').expect(403);
      expect(order(o.id).status).toBe('BILLED');
      expect((await tableCard(o.table_id!)).status).toBe('READY_TO_CLOSE');
    });

    it('REQ-069: a close without a reason (or OTHER without text, or an unknown code) is 400', async () => {
      const o = await billedTable(BILL_300);
      expect((await closeExc(o.id, {}).expect(400)).body.code).toBe('REASON_REQUIRED');
      expect((await closeExc(o.id, { reason_code: 'OTHER' }).expect(400)).body.code).toBe('REASON_REQUIRED');
      await closeExc(o.id, { reason_code: 'BIRTHDAY' }).expect(400);
      expect(order(o.id).status).toBe('BILLED');
    });

    it('REQ-069/REQ-066: an Admin close records the balance in a CLOSE_WITH_BALANCE exception and frees the table', async () => {
      const o = await billedTable(BILL_800);
      await pay(o.id, { method: 'CASH', amount: '500' }).expect(201);
      const res = await closeExc(o.id, { reason_code: 'CUSTOMER_LEFT' }).expect(200);
      expect(res.body).toMatchObject({ id: o.id, status: 'CLOSED_EXCEPTION', balance_due: '300.00' });
      expect(storage.store.findBy('exceptions', 'order_id', o.id)).toContainEqual(expect.objectContaining({
        exception_type: 'CLOSE_WITH_BALANCE', reason_code: 'CUSTOMER_LEFT', amount: '300.00', requested_by: 'ADM-1', approved_by: null,
      }));
      expect((await tableCard(o.table_id!)).status).toBe('AVAILABLE');
      expect(events).toContainEqual(expect.objectContaining({ event: 'table.status_changed', payload: expect.objectContaining({ table_id: o.table_id, status: 'AVAILABLE' }) }));
      expect(await openBillIds()).not.toContain(o.id);
      await closeExc(o.id, { reason_code: 'OTHER', reason_text: 'again' }).expect(409);
    });

    it('REQ-023: a Cashier with an approval token closes as STAFF_MEAL; the Admin is the approver', async () => {
      const o = await billedTable(BILL_300);
      await closeExc(o.id, { reason_code: 'STAFF_MEAL', reason_text: 'Lunch for Raju' }, { 'X-Approval-Token': await approval() }, 'CASHIER').expect(200);
      expect(storage.store.findBy('exceptions', 'order_id', o.id)).toContainEqual(expect.objectContaining({
        exception_type: 'CLOSE_WITH_BALANCE', reason_code: 'STAFF_MEAL', reason_text: 'Lunch for Raju', requested_by: 'USR-C', approved_by: 'ADM-1',
      }));
    });
  });

  describe('receipt prints (REQ-067)', () => {
    it('REQ-067: the first print and each Cashier reprint write an Audit Log row; the order and settings are returned', async () => {
      const o = await billedTable(BILL_300);
      await pay(o.id, { method: 'CASH', amount: '300' }).expect(201);
      const print = (key: string) => http().post(`/api/v1/orders/${o.id}/receipt-prints`).set(as('CASHIER')).set('Idempotency-Key', key);
      const first = await print('rp-1').expect(201);
      expect(first.body).toMatchObject({ id: o.id, status: 'PAID', print: { action: 'RECEIPT_PRINT', print_count: 1 } });
      expect(first.body.settings).toMatchObject({ dhaba_name: expect.any(String), receipt_footer: expect.any(String) });
      expect(first.body.kots[0].lines.length).toBeGreaterThan(0);
      expect(first.body.payments).toHaveLength(1);
      const re = await print('rp-2').expect(201);
      expect(re.body.print).toEqual({ action: 'REPRINT', print_count: 2 });
      // A double tap with the same key logs once.
      await Promise.all([print('rp-2'), print('rp-2')]);
      const rows = storage.store.findBy('audit_log', 'entity_id', o.id).filter((a) => ['RECEIPT_PRINT', 'REPRINT'].includes(a.action));
      expect(rows.map((a) => a.action)).toEqual(['RECEIPT_PRINT', 'REPRINT']);
      expect(rows[1]).toMatchObject({ user_id: 'USR-C', entity_type: 'orders' });
    });

    it('REQ-067/REQ-017: logging a print never changes the payment or order; missing key is 400; Kitchen is 403', async () => {
      const o = await billedTable(BILL_300);
      await pay(o.id, { method: 'CASH', amount: '300' }).expect(201);
      const before = { ...order(o.id) };
      await http().post(`/api/v1/orders/${o.id}/receipt-prints`).set(as('CASHIER')).expect(400);
      await http().post(`/api/v1/orders/${o.id}/receipt-prints`).set(as('KITCHEN')).set('Idempotency-Key', 'k').expect(403);
      await http().post('/api/v1/orders/ORD-NOPE/receipt-prints').set(as('CASHIER')).set('Idempotency-Key', 'k').expect(404);
      expect(order(o.id)).toEqual(before);
      expect(storage.store.findBy('payments', 'order_id', o.id)[0].status).toBe('SUCCESS');
    });
  });
});
