// HTTP checks of printBill and applyDiscount over the §7.6 sample session.
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
import { sampleSessionData, TAKEAWAY_ORDER } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };

describe('print bill and discounts over HTTP (WI-009)', () => {
  let app: INestApplication;
  let storage: StorageService;
  const events: TxEvent[] = [];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  let keyN = 0;
  const order = (id: string): Order => storage.store.get('orders', id)!;
  const bill = (id: string, who: Role = 'CASHIER', version = order(id).row_version, body: object = {}) =>
    http().post(`/api/v1/orders/${id}/bill`).set(as(who)).set('If-Match', String(version)).send(body);
  const discount = (id: string, body: object, headers: Record<string, string> = {}, who: Role = 'CASHIER') =>
    http().post(`/api/v1/orders/${id}/discount`).set(as(who)).set('If-Match', String(order(id).row_version)).set(headers).send(body);
  const openTable = async (table_id: string): Promise<Order> =>
    (await http().post('/api/v1/orders/dine-in').set(as('CASHIER')).set('Idempotency-Key', `open-${++keyN}`).send({ table_id }).expect(201)).body;
  const send = (id: string, lines: object[]) =>
    http().post(`/api/v1/orders/${id}/kots`).set(as('CASHIER')).set('Idempotency-Key', `send-${++keyN}`).send({ lines }).expect(201);

  beforeAll(async () => {
    const dir = tempDir();
    const data = sampleSessionData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    data.tables.push({ id: 'TBL-6', table_number: '6', area: 'Hall', seats: 4, is_active: true, ...audit });
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

  it('REQ-060/REQ-033: PRINT BILL returns the BILLED order view with a bill number and turns the table Ready to Close', async () => {
    const o = await openTable('TBL-6');
    await send(o.id, [{ variant_id: 'VAR-1', quantity: 2 }, { variant_id: 'VAR-2', quantity: 1 }]);
    const res = await bill(o.id).expect(200);
    expect(res.body).toMatchObject({ id: o.id, status: 'BILLED', subtotal: '460.00', tax_amount: '0.00', grand_total: '460.00', balance_due: '460.00' });
    expect(res.body.bill_no).toMatch(/^B-\d{8}-\d{3}$/);
    expect(res.body.kots).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ event: 'table.status_changed', payload: expect.objectContaining({ table_id: 'TBL-6', status: 'READY_TO_CLOSE' }) }));
    const card = (await http().get('/api/v1/tables').set(as('CASHIER')).expect(200)).body.find((c: { id: string }) => c.id === 'TBL-6');
    expect(card.status).toBe('READY_TO_CLOSE');

    // A reprint keeps the number; new items reopen the bill and log a BILL_REOPEN exception.
    expect((await bill(o.id).expect(200)).body.bill_no).toBe(res.body.bill_no);
    await send(o.id, [{ variant_id: 'VAR-2', quantity: 1 }]);
    expect(order(o.id)).toMatchObject({ status: 'OPEN', bill_no: res.body.bill_no });
    expect(storage.store.findBy('exceptions', 'order_id', o.id).map((e) => e.exception_type)).toContain('BILL_REOPEN');
  });

  it('REQ-059/REQ-102: client-sent totals have no effect on the stored total', async () => {
    const res = await bill(TAKEAWAY_ORDER, 'CASHIER', order(TAKEAWAY_ORDER).row_version, { grand_total: '1.00', subtotal: '1.00' }).expect(200);
    expect(res.body).toMatchObject({ subtotal: '260.00', grand_total: '260.00' });
    const d = await discount(TAKEAWAY_ORDER, { amount: '10', reason_text: 'Regular', grand_total: '5.00', discount_amount: '200.00' }).expect(200);
    expect(d.body).toMatchObject({ discount_amount: '10.00', grand_total: '250.00' });
    expect(order(TAKEAWAY_ORDER).grand_total).toBe('250.00');
  });

  it('REQ-018: Kitchen cannot print a bill or discount; a stale If-Match gets 409 with the current order', async () => {
    await bill(TAKEAWAY_ORDER, 'KITCHEN').expect(403);
    await discount(TAKEAWAY_ORDER, { amount: '10', reason_text: 'x' }, {}, 'KITCHEN').expect(403);
    const stale = await bill(TAKEAWAY_ORDER, 'CASHIER', 1).expect(409);
    expect(stale.body.code).toBe('ROW_VERSION_CONFLICT');
    expect(stale.body.details.current.id).toBe(TAKEAWAY_ORDER);
    await http().post(`/api/v1/orders/${TAKEAWAY_ORDER}/bill`).set(as('CASHIER')).expect(428);
  });

  it('REQ-061: a discount needs a reason, stays within the subtotal and above the limit needs an Admin approval', async () => {
    expect((await discount(TAKEAWAY_ORDER, { amount: '10' }).expect(400)).body.code).toBe('REASON_REQUIRED');
    expect((await discount(TAKEAWAY_ORDER, { reason_text: 'x' }).expect(400)).body.details.field).toBe('amount');
    await discount(TAKEAWAY_ORDER, { amount: '10.005', reason_text: 'x' }).expect(400);
    expect((await discount(TAKEAWAY_ORDER, { amount: '300', reason_text: 'x' }).expect(422)).body.code).toBe('DISCOUNT_TOO_LARGE');
    expect((await discount(TAKEAWAY_ORDER, { amount: '150', reason_text: 'Big party' }).expect(403)).body.code).toBe('APPROVAL_INVALID');

    const approval = (await http().post('/api/v1/auth/approvals').set(as('CASHIER')).set('Idempotency-Key', `appr-${++keyN}`).send({ pin: '1234' }).expect(201)).body;
    const ok = await discount(TAKEAWAY_ORDER, { discount_type: 'PERCENT', percent: '50', reason_code: 'BIG_PARTY' }, { 'X-Approval-Token': approval.approval_token }).expect(200);
    expect(ok.body).toMatchObject({ discount_amount: '130.00', discount_reason: 'BIG_PARTY', grand_total: '130.00' });
    expect(storage.store.findBy('exceptions', 'order_id', TAKEAWAY_ORDER).at(-1)).toMatchObject({ exception_type: 'DISCOUNT', approved_by: 'ADM-1', reason_code: 'BIG_PARTY' });
    // The token was single-use.
    await discount(TAKEAWAY_ORDER, { amount: '140', reason_text: 'again' }, { 'X-Approval-Token': approval.approval_token }).expect(403);
  });
});
