import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, seededData, tempDir } from './fixtures';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };

describe('admin menu, variants and price changes (WI-013)', () => {
  let app: INestApplication;
  let storage: StorageService;
  const clock = Date.parse('2026-11-05T12:30:00+05:30');
  const tokens = {} as Record<Role, string>;
  let keyN = 0;
  const key = () => `k-${++keyN}`;
  const http = () => request(app.getHttpServer());
  const as = (who: Role = 'ADMIN') => ({ Authorization: `Bearer ${tokens[who]}` });
  const post = (url: string, body: object, who: Role = 'ADMIN', idem = key()) => http().post(`/api/v1${url}`).set(as(who)).set('Idempotency-Key', idem).send(body);
  const patch = (url: string, version: number, body: object, who: Role = 'ADMIN') => http().patch(`/api/v1${url}`).set(as(who)).set('If-Match', String(version)).send(body);
  const priceChange = (id: string, version: number, body: object, idem = key()) =>
    http().post(`/api/v1/admin/variants/${id}/price-changes`).set(as()).set('Idempotency-Key', idem).set('If-Match', String(version)).send(body);
  const menu = async () => (await http().get('/api/v1/menu').set(as('CASHIER')).expect(200)).body as Record<string, any>[];

  /** Category + item + variant through the API. */
  const seedItem = async (name: string, code: string, price = '100.00') => {
    const c = (await post('/admin/categories', { name_en: `${name} Cat`, name_hi: 'क' }).expect(201)).body;
    const i = (await post('/admin/items', { category_id: c.id, name_en: name, name_hi: 'आ', short_code: code, food_type: 'VEG' }).expect(201)).body;
    const v = (await post(`/admin/items/${i.id}/variants`, { name: 'Full', price }).expect(201)).body;
    return { c, i, v };
  };

  beforeAll(async () => {
    const dir = tempDir();
    const data = seededData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'));
    data.tables.push({ id: 'TBL-9', table_number: 'T9', area: 'Hall', seats: 4, is_active: true, ...audit });
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => clock });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
  });

  afterAll(async () => {
    await app?.close();
    storage?.close();
  });

  describe('categories (REQ-070)', () => {
    it('REQ-070: creates a category with a new id, CREATE audit, and replays the same Idempotency-Key with 200', async () => {
      const res = await post('/admin/categories', { name_en: 'Breads', name_hi: 'रोटियाँ', sort_order: 4 }, 'ADMIN', 'cat-once').expect(201);
      expect(res.body).toMatchObject({ id: expect.stringMatching(/^CAT-\d{6}$/), name_en: 'Breads', sort_order: 4, is_active: true, row_version: 1, created_by: 'ADM-1' });
      const again = await post('/admin/categories', { name_en: 'Breads', name_hi: 'रोटियाँ' }, 'ADMIN', 'cat-once').expect(200);
      expect(again.body.id).toBe(res.body.id);
      expect(storage.store.all('categories').filter((c) => c.name_en === 'Breads')).toHaveLength(1);
      expect(storage.store.all('audit_log').some((a) => a.action === 'CREATE' && a.entity_id === res.body.id)).toBe(true);
    });

    it('REQ-070: a duplicate English category name is rejected (409), also case-insensitively and on rename', async () => {
      const res = await post('/admin/categories', { name_en: 'main course', name_hi: 'x' }).expect(409);
      expect(res.body).toMatchObject({ code: 'DUPLICATE_NAME', details: { field: 'name_en', existing_id: 'CAT-1' } });
      const c = (await post('/admin/categories', { name_en: 'Rename Me', name_hi: 'x' }).expect(201)).body;
      await patch(`/admin/categories/${c.id}`, 1, { name_en: 'Main Course' }).expect(409);
    });

    it('REQ-070/REQ-082: deactivating hides the items from the menu; reactivating restores them', async () => {
      const { c, i } = await seedItem('Toggle Dish', 'TD');
      expect((await menu()).some((m) => m.id === i.id)).toBe(true);
      const off = await patch(`/admin/categories/${c.id}`, 1, { is_active: false }).expect(200);
      expect(off.body).toMatchObject({ is_active: false, row_version: 2 });
      expect((await menu()).some((m) => m.id === i.id)).toBe(false);
      await patch(`/admin/categories/${c.id}`, 2, { is_active: true, sort_order: 9 }).expect(200);
      expect((await menu()).some((m) => m.id === i.id)).toBe(true);
      expect(storage.store.get('categories', c.id)).toBeDefined();
    });

    it('REQ-113: a stale If-Match on a category is 409 with the current row', async () => {
      const c = (await post('/admin/categories', { name_en: 'Stale Cat', name_hi: 'x' }).expect(201)).body;
      await patch(`/admin/categories/${c.id}`, 1, { sort_order: 3 }).expect(200);
      const res = await patch(`/admin/categories/${c.id}`, 1, { sort_order: 4 }).expect(409);
      expect(res.body.details.current).toMatchObject({ id: c.id, row_version: 2 });
    });

    it('REQ-019: a Cashier gets 403 ACCESS_DENIED', async () => {
      await post('/admin/categories', { name_en: 'Nope', name_hi: 'x' }, 'CASHIER').expect(403);
    });
  });

  describe('items (REQ-071)', () => {
    const base = { category_id: 'CAT-1', name_hi: 'आइटम', food_type: 'NON_VEG' };

    it('REQ-071: creates an item with photo, Hindi name, short code and station', async () => {
      const res = await post('/admin/items', { ...base, name_en: 'Chicken Tikka', short_code: 'CT', photo_url: '/img/ct.png', kitchen_station: 'Tandoor' }).expect(201);
      expect(res.body).toMatchObject({ id: expect.stringMatching(/^ITM-\d{6}$/), short_code: 'CT', food_type: 'NON_VEG', photo_url: '/img/ct.png', kitchen_station: 'Tandoor', is_active: true, available_today: true });
    });

    it('REQ-071: a short code outside 2–5 characters is rejected (400)', async () => {
      expect((await post('/admin/items', { ...base, name_en: 'Short', short_code: 'X' }).expect(400)).body.code).toBe('SHORT_CODE_LENGTH');
      expect((await post('/admin/items', { ...base, name_en: 'Long', short_code: 'ABCDEF' }).expect(400)).body.code).toBe('SHORT_CODE_LENGTH');
      const ok = (await post('/admin/items', { ...base, name_en: 'Five', short_code: 'ABCDE' }).expect(201)).body;
      await patch(`/admin/items/${ok.id}`, 1, { short_code: 'Q' }).expect(400);
    });

    it('REQ-071: a duplicate name within one category, or a duplicate short code, is rejected (409)', async () => {
      const dup = await post('/admin/items', { ...base, name_en: 'butter chicken', short_code: 'BC2' }).expect(409);
      expect(dup.body).toMatchObject({ code: 'DUPLICATE_NAME', details: { existing_id: 'ITM-1' } });
      expect((await post('/admin/items', { ...base, name_en: 'Another', short_code: 'bc' }).expect(409)).body.code).toBe('DUPLICATE_SHORT_CODE');
      // Same name in a different category is fine.
      const c = (await post('/admin/categories', { name_en: 'Specials', name_hi: 'x' }).expect(201)).body;
      await post('/admin/items', { ...base, category_id: c.id, name_en: 'Butter Chicken', short_code: 'BCS' }).expect(201);
    });

    it('REQ-071: an unknown category is 404', async () => {
      await post('/admin/items', { ...base, category_id: 'CAT-404', name_en: 'Lost', short_code: 'LO' }).expect(404);
    });

    it('REQ-082: deactivating keeps the item row, and no DELETE route exists for items', async () => {
      const { i } = await seedItem('Keep Me', 'KM');
      const res = await patch(`/admin/items/${i.id}`, 1, { is_active: false, name_hi: 'नया' }).expect(200);
      expect(res.body).toMatchObject({ is_active: false, name_hi: 'नया', row_version: 2 });
      expect((await menu()).some((m) => m.id === i.id)).toBe(false);
      const del = await http().delete(`/api/v1/admin/items/${i.id}`).set(as()).expect(404);
      expect(del.body.code).toBe('NOT_FOUND');
      await http().delete(`/api/v1/items/${i.id}`).set(as()).expect(404);
      expect(storage.store.get('items', i.id)).toMatchObject({ id: i.id, is_active: false });
      const actions = storage.store.all('audit_log').filter((a) => a.entity_id === i.id).map((a) => a.action);
      expect(actions).toEqual(expect.arrayContaining(['CREATE', 'DEACTIVATE']));
    });

    it('REQ-114: client-sent id or available_today does not get written', async () => {
      await post('/admin/items', { ...base, id: 'ITM-HACK', name_en: 'Hack', short_code: 'HK' }).expect(400);
      const res = await post('/admin/items', { ...base, name_en: 'Avail', short_code: 'AV', available_today: false }).expect(201);
      expect(res.body.available_today).toBe(true);
    });
  });

  describe('variants (REQ-072)', () => {
    it('REQ-072: creates a variant with its price; price ≤ 0 is rejected (400)', async () => {
      const { i } = await seedItem('Paneer Tikka', 'PT', '180');
      const v = storage.store.findBy('variants', 'item_id', i.id)[0];
      expect(v).toMatchObject({ id: expect.stringMatching(/^VAR-\d{6}$/), price: '180.00', sort_order: 1 });
      for (const price of ['0', '0.00', '-5', 'abc', '1.234']) {
        expect([price, (await post(`/admin/items/${i.id}/variants`, { name: `P${price}`, price }).expect(400)).body.code]).toEqual([price, expect.any(String)]);
      }
      expect((await post(`/admin/items/${i.id}/variants`, { name: 'Zero', price: 0 }).expect(400)).body.code).toBe('PRICE_NOT_POSITIVE');
      const half = (await post(`/admin/items/${i.id}/variants`, { name: 'Half', price: 99.5 }).expect(201)).body;
      expect(half).toMatchObject({ price: '99.50', sort_order: 2 });
    });

    it('REQ-072: a duplicate variant name within the same item is rejected (409), but allowed on another item', async () => {
      await post('/admin/items/ITM-1/variants', { name: 'half', price: '10' }).expect(409);
      await post('/admin/items/ITM-2/variants', { name: 'Half', price: '10' }).expect(201);
      const v = (await post('/admin/items/ITM-1/variants', { name: 'Quarter', price: '10' }).expect(201)).body;
      expect((await patch(`/admin/variants/${v.id}`, 1, { name: 'Half' }).expect(409)).body.code).toBe('DUPLICATE_NAME');
    });

    it('REQ-072: a variant edit that includes a new price leaves the price unchanged', async () => {
      const { v } = await seedItem('Lassi', 'LS', '60');
      const res = await patch(`/admin/variants/${v.id}`, 1, { name: 'Large', sort_order: 3, price: '1.00' }).expect(200);
      expect(res.body).toMatchObject({ name: 'Large', sort_order: 3, price: '60.00' });
      expect(storage.store.get('variants', v.id)!.price).toBe('60.00');
      expect(storage.store.findBy('price_changes', 'variant_id', v.id)).toHaveLength(0);
      await patch(`/admin/variants/${v.id}`, 2, { is_active: false }).expect(200);
      expect(storage.store.get('variants', v.id)).toMatchObject({ is_active: false });
    });
  });

  describe('price changes (REQ-073, REQ-094)', () => {
    it('REQ-073: writes the new price, the history row and the audit row in one journal entry', async () => {
      const { v } = await seedItem('Kadhai Paneer', 'KP', '200');
      const seqBefore = storage.journal.lastSeq;
      const res = await priceChange(v.id, 1, { new_price: '220', reason: 'MARKET_RATE', old_price: '1.00' }, 'pc-once').expect(201);
      expect(res.body).toMatchObject({ id: expect.stringMatching(/^PRC-\d{6}$/), variant_id: v.id, old_price: '200.00', new_price: '220.00', reason: 'MARKET_RATE', changed_by: 'ADM-1', created_at: expect.stringContaining('+05:30') });
      expect(storage.journal.lastSeq).toBe(seqBefore + 1);
      expect(storage.store.get('variants', v.id)).toMatchObject({ price: '220.00', row_version: 2 });
      expect(storage.store.all('audit_log').find((a) => a.action === 'PRICE_CHANGE' && a.entity_id === v.id)).toMatchObject({ before_json: { price: '200.00' } });
      // Replay of the same key: 200, no second history row.
      const again = await priceChange(v.id, 1, { new_price: '220', reason: 'MARKET_RATE' }, 'pc-once').expect(200);
      expect(again.body.id).toBe(res.body.id);
      expect(storage.store.findBy('price_changes', 'variant_id', v.id)).toHaveLength(1);
    });

    it('REQ-073/REQ-094: a missing reason, a reason outside the enum, or a price ≤ 0 is rejected (400)', async () => {
      const { v } = await seedItem('Rajma', 'RJ', '120');
      await priceChange(v.id, 1, { new_price: '130' }).expect(400);
      await priceChange(v.id, 1, { new_price: '130', reason: '' }).expect(400);
      const bad = await priceChange(v.id, 1, { new_price: '130', reason: 'INFLATION' }).expect(400);
      expect(JSON.stringify(bad.body)).toContain('MARKET_RATE');
      await priceChange(v.id, 1, { new_price: '0', reason: 'OTHER' }).expect(400);
      await priceChange(v.id, 1, { new_price: '-1', reason: 'OTHER' }).expect(400);
      for (const reason of ['NEW_SEASON', 'CORRECTION', 'OTHER']) {
        const version = storage.store.get('variants', v.id)!.row_version;
        await priceChange(v.id, version, { new_price: String(130 + version), reason }).expect(201);
      }
      expect(storage.store.findBy('price_changes', 'variant_id', v.id)).toHaveLength(3);
    });

    it('REQ-113: a stale If-Match is 409 with the current variant', async () => {
      const { v } = await seedItem('Stale Dish', 'SD', '50');
      const res = await priceChange(v.id, 7, { new_price: '55', reason: 'OTHER' }).expect(409);
      expect(res.body.details.current).toMatchObject({ id: v.id, price: '50.00', row_version: 1 });
    });

    it('REQ-018: a Cashier gets 403 and an ACCESS_DENIED audit row', async () => {
      const before = storage.store.all('audit_log').length;
      await http().post('/api/v1/admin/variants/VAR-1/price-changes').set(as('CASHIER')).set('Idempotency-Key', key()).set('If-Match', '1').send({ new_price: '1', reason: 'OTHER' }).expect(403);
      expect(storage.store.all('audit_log').slice(before)).toEqual([expect.objectContaining({ action: 'ACCESS_DENIED', user_id: 'USR-C' })]);
      expect(storage.store.get('variants', 'VAR-1')!.price).toBe('220.00');
    });

    it('REQ-073: a failed write leaves neither the new price nor the history row', async () => {
      const { v } = await seedItem('Fail Dish', 'FD', '80');
      const historyBefore = storage.store.all('price_changes').length;
      const auditBefore = storage.store.all('audit_log').length;
      const spy = jest.spyOn(storage.journal, 'append').mockImplementationOnce(() => {
        throw Object.assign(new Error('EIO: disk gone'), { code: 'EIO' });
      });
      const res = await priceChange(v.id, 1, { new_price: '90', reason: 'MARKET_RATE' }, 'pc-fail');
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(storage.store.get('variants', v.id)).toMatchObject({ price: '80.00', row_version: 1 });
      expect(storage.store.all('price_changes')).toHaveLength(historyBefore);
      expect(storage.store.all('audit_log')).toHaveLength(auditBefore);
      // The same key works once the disk is back.
      await priceChange(v.id, 1, { new_price: '90', reason: 'MARKET_RATE' }, 'pc-fail').expect(201);
    });

    it('REQ-073/REQ-058/REQ-082: existing order lines keep their price; only new lines use the new one; cancelled lines and orders stay', async () => {
      const { v } = await seedItem('Shahi Paneer', 'SP', '150');
      const order = (await post('/orders/dine-in', { table_id: 'TBL-9' }, 'CASHIER').expect(201)).body;
      const kot1 = (await post(`/orders/${order.id}/kots`, { lines: [{ variant_id: v.id, quantity: 2 }] }, 'CASHIER').expect(201)).body;
      const line1 = kot1.lines[0];
      const linesBefore = JSON.stringify(storage.store.all('order_items'));

      await priceChange(v.id, 1, { new_price: '175', reason: 'NEW_SEASON' }).expect(201);
      expect(JSON.stringify(storage.store.all('order_items'))).toBe(linesBefore);
      expect(storage.store.get('order_items', line1.id)).toMatchObject({ unit_price: '150.00', line_total: '300.00', row_version: 1 });

      const kot2 = (await post(`/orders/${order.id}/kots`, { lines: [{ variant_id: v.id, quantity: 1 }] }, 'CASHIER').expect(201)).body;
      expect(kot2.lines[0]).toMatchObject({ unit_price: '175.00' });

      // A line cancelled after Preparing stays in the sheet as CANCELLED (REQ-082/REQ-083).
      await patch(`/kots/${kot1.id}/status`, kot1.row_version, { status: 'PREPARING' }, 'CASHIER').expect(200);
      const cancelled = await http().post(`/api/v1/order-items/${line1.id}/cancel`).set(as()).set('If-Match', '1').send({ cancel_reason: 'Guest changed mind' }).expect(200);
      expect(cancelled.body.subtotal).toBe('175.00');
      expect(storage.store.get('order_items', line1.id)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Guest changed mind' });

      // DELETE on an order is not a route: 404 and the row stays.
      const del = await http().delete(`/api/v1/orders/${order.id}`).set(as()).expect(404);
      expect(del.body.code).toBe('NOT_FOUND');
      expect(storage.store.get('orders', order.id)).toMatchObject({ id: order.id });
    });
  });
});
