import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { Category, Item, Role, UserRow, Variant } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { AvailabilityRollover, resetAvailability } from '../src/menu/availability';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, seededData, tempDir } from './fixtures';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const YESTERDAY = '2026-11-04T20:00:00.000+05:30';
const cat = (id: string, name_en: string, sort_order: number, is_active = true): Category => ({ id, name_en, name_hi: name_en, sort_order, is_active, ...audit });
const itm = (id: string, category_id: string, name_en: string, short_code: string, extra: Partial<Item> = {}): Item => ({
  id, category_id, name_en, name_hi: `${name_en} हि`, short_code, food_type: 'VEG', photo_url: null, kitchen_station: null,
  is_active: true, available_today: true, ...audit, ...extra,
});
const vr = (id: string, item_id: string, name: string, price: string, sort_order: number, is_active = true): Variant => ({ id, item_id, name, price, sort_order, is_active, ...audit });

describe('menu read, search and daily availability (WI-007)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let socket: Socket;
  const clock = Date.parse('2026-11-05T12:30:00+05:30');
  const socketEvents: { name: string; body: Record<string, unknown>; at: number }[] = [];
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  const menu = async (who: Role = 'CASHIER', q?: string) =>
    (await http().get('/api/v1/menu').query(q === undefined ? {} : { q }).set(as(who)).expect(200)).body as Record<string, any>[];
  const find = async (id: string, who: Role = 'CASHIER') => (await menu(who)).find((i) => i.id === id)!;
  const toggle = (id: string, available_today: boolean, version: number, who: Role = 'CASHIER') =>
    http().patch(`/api/v1/items/${id}/availability`).set(as(who)).set('If-Match', String(version)).send({ available_today });

  beforeAll(async () => {
    const dir = tempDir();
    const data = seededData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    data.categories.push(cat('CAT-2', 'Dal', 0), cat('CAT-3', 'Seasonal', 2, false));
    data.items.push(
      itm('ITM-3', 'CAT-2', 'Dal Makhani', 'DM', { photo_url: null }),
      itm('ITM-4', 'CAT-2', 'Dal Tadka', 'DT'),
      itm('ITM-5', 'CAT-3', 'Sarson Saag', 'SS'),
      itm('ITM-6', 'CAT-2', 'Old Dal', 'OD', { is_active: false }),
      itm('ITM-7', 'CAT-2', 'Chana Dal', 'CD', { available_today: false, updated_at: YESTERDAY }),
    );
    data.variants.push(vr('VAR-3F', 'ITM-3', 'Full', '240.00', 1), vr('VAR-3H', 'ITM-3', 'Half', '140.00', 2), vr('VAR-4', 'ITM-4', 'Std', '90.00', 1, false),
      vr('VAR-5', 'ITM-5', 'Std', '150.00', 1), vr('VAR-7', 'ITM-7', 'Std', '100.00', 1));
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => clock });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    socket = io(await app.getUrl(), { path: '/socket.io', transports: ['websocket'] });
    socket.onAny((name, body) => socketEvents.push({ name, body, at: Date.now() }));
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    tokens.KITCHEN = await login('USR-K', '9012');
  });

  afterAll(async () => {
    socket?.close();
    await app?.close();
    storage?.close();
  });

  it('REQ-042: the menu lists active items of active categories, by category order, with category labels', async () => {
    const items = await menu();
    expect(items.map((i) => i.id)).toEqual(['ITM-7', 'ITM-3', 'ITM-4', 'ITM-1', 'ITM-2']);
    expect(items[0]).toMatchObject({ category_id: 'CAT-2', category_name_en: 'Dal', category_sort_order: 0 });
    // Deactivated category (ITM-5) and deactivated item (ITM-6) are hidden.
    expect(items.some((i) => i.id === 'ITM-5' || i.id === 'ITM-6')).toBe(false);
  });

  it('REQ-042: every item carries food_type, so the VEG filter hides all non-veg items', async () => {
    const items = await menu();
    expect(items.find((i) => i.id === 'ITM-1')!.food_type).toBe('NON_VEG');
    const veg = items.filter((i) => i.food_type === 'VEG');
    expect(veg.length).toBe(4);
    expect(veg.every((i) => i.food_type !== 'NON_VEG')).toBe(true);
  });

  it('REQ-043/REQ-044: the starting price is the lowest active variant; variants come in sort order with prices', async () => {
    const dal = await find('ITM-3');
    expect(dal.starting_price).toBe('140.00');
    expect(dal.variants).toEqual([{ id: 'VAR-3F', name: 'Full', sort_order: 1, price: '240.00' }, { id: 'VAR-3H', name: 'Half', sort_order: 2, price: '140.00' }]);
    expect(dal).toMatchObject({ name_en: 'Dal Makhani', name_hi: 'Dal Makhani हि', photo_url: null, orderable: true });
  });

  it('REQ-044: a single-variant item has exactly one variant (one-tap add); an item with no active variant is not orderable', async () => {
    const roti = await find('ITM-2');
    expect(roti.variants).toHaveLength(1);
    expect(roti.orderable).toBe(true);
    const tadka = await find('ITM-4');
    expect(tadka).toMatchObject({ variants: [], starting_price: null, orderable: false });
  });

  it('REQ-021: Kitchen gets the menu without any price', async () => {
    const items = await menu('KITCHEN');
    const text = JSON.stringify(items);
    expect(text).not.toContain('price');
    expect(text).not.toContain('140');
    expect(items.find((i) => i.id === 'ITM-3')!.variants).toEqual([{ id: 'VAR-3F', name: 'Full', sort_order: 1 }, { id: 'VAR-3H', name: 'Half', sort_order: 2 }]);
  });

  it('REQ-046: one letter is rejected with 400; 2+ letters match English, Hindi and short codes', async () => {
    const res = await http().get('/api/v1/menu').query({ q: 'd' }).set(as('CASHIER')).expect(400);
    expect(res.body.code).toBe('SEARCH_TOO_SHORT');
    await http().get('/api/v1/menu').query({ q: ' d ' }).set(as('CASHIER')).expect(400);
    expect((await menu('CASHIER', 'tr')).map((i) => i.id)).toEqual(['ITM-2']);
    expect((await menu('CASHIER', 'DM'))[0].id).toBe('ITM-3');
    expect((await menu('CASHIER', 'makh')).map((i) => i.id)).toEqual(['ITM-3']);
    expect((await menu('CASHIER', 'बटर')).map((i) => i.id)).toEqual(['ITM-1']);
    expect(await menu('CASHIER', 'zz')).toEqual([]);
    await http().get('/api/v1/menu').query({ food: 'x' }).set(as('CASHIER')).expect(400);
  });

  it('REQ-074: an item marked unavailable on an earlier business day shows available today', async () => {
    expect(await find('ITM-7')).toMatchObject({ available_today: true, orderable: true });
  });

  it('REQ-074: any role toggles availability with If-Match; is_active is unchanged; stale version is 409', async () => {
    const before = storage.store.get('items', 'ITM-2')!;
    const off = await toggle('ITM-2', false, before.row_version, 'KITCHEN').expect(200);
    expect(off.body).toMatchObject({ id: 'ITM-2', available_today: false, is_active: true, row_version: before.row_version + 1 });
    expect(await find('ITM-2')).toMatchObject({ available_today: false, orderable: false });
    const stale = await toggle('ITM-2', true, before.row_version).expect(409);
    expect(stale.body.details.current).toMatchObject({ id: 'ITM-2', row_version: before.row_version + 1 });
    const on = await toggle('ITM-2', true, before.row_version + 1, 'CASHIER').expect(200);
    expect(on.body).toMatchObject({ available_today: true, is_active: true });
    await toggle('ITM-2', false, on.body.row_version, 'ADMIN').expect(200);
    await toggle('ITM-2', true, on.body.row_version + 1).expect(200);
    const audits = storage.store.all('audit_log').filter((a) => a.entity_id === 'ITM-2');
    expect(audits.map((a) => a.action)).toEqual(['OUT_OF_STOCK', 'AVAILABLE', 'OUT_OF_STOCK', 'AVAILABLE']);
    expect(storage.store.get('items', 'ITM-2')!.is_active).toBe(true);
  });

  it('REQ-074: validation — If-Match missing is 428, a non-boolean or extra field is 400, unknown item 404', async () => {
    await http().patch('/api/v1/items/ITM-2/availability').set(as('CASHIER')).send({ available_today: false }).expect(428);
    await toggle('ITM-2', 'no' as unknown as boolean, 1).expect(400);
    await http().patch('/api/v1/items/ITM-2/availability').set(as('CASHIER')).set('If-Match', '1').send({ available_today: false, is_active: false }).expect(400);
    await toggle('ITM-404', false, 1).expect(404);
  });

  it('REQ-056: Kitchen marks out of stock; cashier sockets get the alert within 3 s; the item is unavailable', async () => {
    const start = Date.now();
    socketEvents.length = 0;
    const res = await http().post('/api/v1/kitchen/items/ITM-1/out-of-stock').set(as('KITCHEN')).expect(200);
    expect(res.body).toMatchObject({ id: 'ITM-1', available_today: false, is_active: true });
    const deadline = Date.now() + 3000;
    while (!socketEvents.some((e) => e.name === 'menu.availability_changed') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const ev = socketEvents.find((e) => e.name === 'menu.availability_changed')!;
    expect(ev).toBeDefined();
    expect(ev.at - start).toBeLessThan(3000);
    expect(ev.body).toMatchObject({ item_id: 'ITM-1', available_today: false, source: 'KITCHEN', alert: { message_en: expect.stringContaining('Butter Chicken') } });
    expect(await find('ITM-1')).toMatchObject({ available_today: false, orderable: false });
    // Repeating it changes nothing and emits nothing.
    const version = storage.store.get('items', 'ITM-1')!.row_version;
    socketEvents.length = 0;
    await http().post('/api/v1/kitchen/items/ITM-1/out-of-stock').set(as('ADMIN')).expect(200);
    expect(storage.store.get('items', 'ITM-1')!.row_version).toBe(version);
    await new Promise((r) => setTimeout(r, 100));
    expect(socketEvents.filter((e) => e.name === 'menu.availability_changed')).toEqual([]);
  });

  it('REQ-018/REQ-056: a Cashier calling out-of-stock is rejected with 403 and the item is untouched', async () => {
    const before = storage.store.get('items', 'ITM-3')!;
    const res = await http().post('/api/v1/kitchen/items/ITM-3/out-of-stock').set(as('CASHIER')).expect(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
    expect(storage.store.get('items', 'ITM-3')).toEqual(before);
    await http().post('/api/v1/kitchen/items/ITM-404/out-of-stock').set(as('KITCHEN')).expect(404);
  });

  it('REQ-074: at business-day rollover available_today resets to TRUE in storage (journaled)', async () => {
    // ITM-1 was marked out of stock "today" (real clock); one business day later the rollover resets it.
    expect(storage.store.get('items', 'ITM-1')!.available_today).toBe(false);
    const sameDay = new AvailabilityRollover(storage, () => clock);
    const stale = (await sameDay.check()).filter((id) => id === 'ITM-7');
    expect(stale).toEqual(['ITM-7']);
    expect(storage.store.get('items', 'ITM-7')!.available_today).toBe(true);
    const nextDay = new AvailabilityRollover(storage, () => Date.now() + 26 * 3600_000);
    const seq = storage.journal.lastSeq;
    expect(await nextDay.check()).toContain('ITM-1');
    expect(storage.store.get('items', 'ITM-1')).toMatchObject({ available_today: true, is_active: true });
    expect(storage.journal.lastSeq).toBe(seq + 1);
    expect(await nextDay.check()).toEqual([]);
  });

  it('REQ-074: the day-close reset sets every unavailable item back to TRUE', async () => {
    await http().post('/api/v1/kitchen/items/ITM-3/out-of-stock').set(as('ADMIN')).expect(200);
    const ids = await storage.queue.run((tx) => resetAvailability(tx, { all: true, userId: 'ADM-1' }));
    expect(ids).toEqual(['ITM-3']);
    expect(storage.store.all('items').every((i) => i.available_today)).toBe(true);
  });
});
