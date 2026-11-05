// HTTP checks of takeaway tokens, the active takeaway list and handover (WI-011).
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
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, tempDir } from './fixtures';
import { sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };

describe('takeaway tokens, active list and handover over HTTP (WI-011)', () => {
  let app: INestApplication;
  let storage: StorageService;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  let keyN = 0;
  const order = (id: string): Order => storage.store.get('orders', id)!;
  const tokenNo = (o: Order) => Number(o.token!.slice(2));

  const create = (body: object = {}, key = `ta-${++keyN}`) =>
    http().post('/api/v1/orders/takeaway').set(as('CASHIER')).set('Idempotency-Key', key).send(body);
  const list = async () => (await http().get('/api/v1/takeaways').set(as('CASHIER')).expect(200)).body as Array<Order & Record<string, unknown>>;
  const row = async (id: string) => (await list()).find((r) => r.id === id);
  const kotOf = (id: string) => storage.store.findBy('kots', 'order_id', id)[0];
  const advance = (kotId: string, status: string) =>
    http().patch(`/api/v1/kots/${kotId}/status`).set(as('KITCHEN')).set('If-Match', String(storage.store.get('kots', kotId)!.row_version)).send({ status }).expect(200);
  const handover = (id: string, version = order(id).row_version) =>
    http().post(`/api/v1/takeaways/${id}/handover`).set(as('CASHIER')).set('If-Match', String(version));

  /** A new takeaway with one ₹220 Butter Chicken Half sent to the kitchen. */
  const sentTakeaway = async (): Promise<Order> => {
    const o: Order = (await create().expect(201)).body;
    await http().post(`/api/v1/orders/${o.id}/kots`).set(as('CASHIER')).set('Idempotency-Key', `send-${++keyN}`)
      .send({ lines: [{ variant_id: 'VAR-1', quantity: 1 }] }).expect(201);
    return o;
  };
  const payInFull = (id: string) =>
    http().post(`/api/v1/orders/${id}/payments`).set(as('CASHIER')).set('Idempotency-Key', `pay-${++keyN}`)
      .send({ method: 'CASH', amount: order(id).balance_due }).expect(201);

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

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  describe('createTakeaway (REQ-038, REQ-039)', () => {
    it('REQ-038: two takeaways created at the same moment on two phones get different, consecutive tokens', async () => {
      const [a, b] = await Promise.all([create({}, 'phone-a'), create({}, 'phone-b')]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const nums = [tokenNo(a.body), tokenNo(b.body)].sort((x, y) => x - y);
      expect(nums[1]).toBe(nums[0] + 1);
      expect(a.body.token).toMatch(/^T-\d{3}$/);
      expect(a.body.business_date).toBe(b.body.business_date);
    });

    it('REQ-112: a repeat Idempotency-Key returns the same order with 200; a missing key is a 400', async () => {
      const first = (await create({}, 'repeat-me').expect(201)).body;
      const again = (await create({}, 'repeat-me').expect(200)).body;
      expect(again).toMatchObject({ id: first.id, token: first.token });
      await http().post('/api/v1/orders/takeaway').set(as('CASHIER')).send({}).expect(400);
    });

    it('REQ-039: a takeaway with no name or phone is created', async () => {
      const res = await create({}).expect(201);
      expect(res.body).toMatchObject({ order_type: 'TAKEAWAY', status: 'OPEN', customer_name: null, customer_phone: null, table_id: null });
    });

    it('REQ-039/REQ-124: a 4-digit phone is accepted, a formula prefix is stripped, a non-digit phone or unknown field is a 400', async () => {
      const res = await create({ customer_name: '=Meena', customer_phone: '4321' }).expect(201);
      expect(res.body).toMatchObject({ customer_name: 'Meena', customer_phone: '4321' });
      expect((await create({ customer_phone: '' }).expect(201)).body.customer_phone).toBeNull();
      await create({ customer_phone: '12ab' }).expect(400);
      await create({ token: 'T-999' }).expect(400);
    });

    it('REQ-018: Kitchen may not create takeaways or read the list', async () => {
      await http().post('/api/v1/orders/takeaway').set(as('KITCHEN')).set('Idempotency-Key', 'kitchen-ta').send({}).expect(403);
      await http().get('/api/v1/takeaways').set(as('KITCHEN')).expect(403);
    });
  });

  describe('active list and handover (REQ-040, REQ-041)', () => {
    it('REQ-040: tapping HANDED OVER on a Ready, Paid token removes it from the active list', async () => {
      const o = await sentTakeaway();
      expect(await row(o.id)).toMatchObject({ token: o.token, item_count: 1, kitchen_status: 'NEW', paid: false });
      await payInFull(o.id);
      const kot = kotOf(o.id);
      await advance(kot.id, 'PREPARING');
      await advance(kot.id, 'READY');
      expect(await row(o.id)).toMatchObject({ kitchen_status: 'READY', paid: true, ready_to_hand_over: true });
      await handover(o.id, 99).expect(409);
      const res = await handover(o.id).expect(200);
      expect(res.body.handed_over_at).toMatch(/\+05:30$/);
      expect(await row(o.id)).toBeUndefined();
      expect(storage.store.get('kots', kot.id)).toMatchObject({ status: 'SERVED' });
    });

    it('REQ-040: tapping HANDED OVER on a Ready but unpaid token is rejected and the token stays in the list', async () => {
      const o = await sentTakeaway();
      const kot = kotOf(o.id);
      await advance(kot.id, 'PREPARING');
      await advance(kot.id, 'READY');
      const res = await handover(o.id).expect(422);
      expect(res.body).toMatchObject({ code: 'NOT_READY_FOR_HANDOVER', details: { reasons: ['NOT_PAID'] } });
      expect(await row(o.id)).toMatchObject({ kitchen_status: 'READY', paid: false });
    });

    it('REQ-041: a takeaway paid while its KOT is NEW still appears in the kitchen and in the list', async () => {
      const o = await sentTakeaway();
      await payInFull(o.id);
      expect(order(o.id).status).toBe('PAID');
      expect(kotOf(o.id).hide_after).toBeNull();
      const board = (await http().get('/api/v1/kitchen/kots').set(as('KITCHEN')).expect(200)).body as Array<{ id: string; status: string; token: string }>;
      expect(board.find((k) => k.id === kotOf(o.id).id)).toMatchObject({ status: 'NEW', token: o.token });
      expect(await row(o.id)).toMatchObject({ paid: true, kitchen_status: 'NEW', ready_to_hand_over: false });
      await handover(o.id).expect(422);
    });

    it('REQ-041: marking an unpaid takeaway\'s KOT Ready leaves the token in the list labelled Unpaid', async () => {
      const o = await sentTakeaway();
      const kot = kotOf(o.id);
      await advance(kot.id, 'PREPARING');
      await advance(kot.id, 'READY');
      expect(await row(o.id)).toMatchObject({ token: o.token, kitchen_status: 'READY', paid: false, balance_due: '220.00' });
    });
  });
});
