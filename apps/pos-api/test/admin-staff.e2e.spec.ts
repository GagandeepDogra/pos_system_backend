import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin, verifyPin } from '../src/auth/pin';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, seededData, tempDir } from './fixtures';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };

describe('admin tables, staff and settings (WI-014)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let clock = Date.parse('2026-11-05T12:30:00+05:30');
  const tokens = {} as Record<Role, string>;
  let keyN = 0;
  const key = () => `k-${++keyN}`;
  const http = () => request(app.getHttpServer());
  const as = (who: Role | string = 'ADMIN') => ({ Authorization: `Bearer ${tokens[who as Role] ?? who}` });
  const post = (url: string, body: object, who: Role = 'ADMIN', idem = key()) => http().post(`/api/v1${url}`).set(as(who)).set('Idempotency-Key', idem).send(body);
  const patch = (url: string, version: number, body: object, who: Role = 'ADMIN') => http().patch(`/api/v1${url}`).set(as(who)).set('If-Match', String(version)).send(body);
  const pinReset = (id: string, version: number, pin: string) => http().post(`/api/v1/admin/users/${id}/pin-reset`).set(as()).set('If-Match', String(version)).send({ pin });
  const login = (user_id: string, pin: string) => http().post('/api/v1/auth/login').send({ user_id, pin });
  const user = (id: string) => storage.store.get('users', id)!;
  const audits = (entityId: string) => storage.store.all('audit_log').filter((a) => a.entity_id === entityId).map((a) => a.action);

  beforeAll(async () => {
    const dir = tempDir();
    const data = seededData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'), await mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'));
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => clock });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const token = async (id: string, pin: string) => (await login(id, pin).expect(200)).body.token;
    tokens.ADMIN = await token('ADM-1', '1234');
    tokens.CASHIER = await token('USR-C', '5678');
    tokens.KITCHEN = await token('USR-K', '9012');
  });

  afterAll(async () => {
    await app?.close();
    storage?.close();
  });

  describe('tables (REQ-075)', () => {
    it('REQ-075: adds a table with area and seats, CREATE audit, and a repeat Idempotency-Key answers 200 with the same table', async () => {
      const res = await post('/admin/tables', { table_number: 'T20', area: 'Garden', seats: 6 }, 'ADMIN', 'tbl-once').expect(201);
      expect(res.body).toMatchObject({ id: expect.stringMatching(/^TBL-\d{6}$/), table_number: 'T20', area: 'Garden', seats: 6, is_active: true, row_version: 1, created_by: 'ADM-1' });
      expect(audits(res.body.id)).toEqual(['CREATE']);
      const again = await post('/admin/tables', { table_number: 'T20' }, 'ADMIN', 'tbl-once').expect(200);
      expect(again.body.id).toBe(res.body.id);
      const grid = (await http().get('/api/v1/tables?area=Garden').set(as('CASHIER')).expect(200)).body;
      expect(grid.map((t: { id: string }) => t.id)).toContain(res.body.id);
    });

    it('REQ-075: a duplicate table number is rejected with 409, on create and on rename', async () => {
      expect((await post('/admin/tables', { table_number: 't1' }).expect(409)).body.code).toBe('DUPLICATE_TABLE_NUMBER');
      const t = (await post('/admin/tables', { table_number: 'T21' }).expect(201)).body;
      expect((await patch(`/admin/tables/${t.id}`, 1, { table_number: 'T20' }).expect(409)).body.code).toBe('DUPLICATE_TABLE_NUMBER');
    });

    it('REQ-075/REQ-032: renaming keeps the label on past orders; deactivating with an open order is 409; after closing it can be deactivated', async () => {
      const t = (await post('/admin/tables', { table_number: 'T30', area: 'Hall' }).expect(201)).body;
      const order = (await post('/orders/dine-in', { table_id: t.id }, 'CASHIER').expect(201)).body;
      expect(order.table_label_snapshot).toBe('T30');
      const renamed = (await patch(`/admin/tables/${t.id}`, 1, { table_number: 'T31', area: null, seats: 2 }).expect(200)).body;
      expect(renamed).toMatchObject({ table_number: 'T31', area: null, seats: 2, row_version: 2 });
      expect(storage.store.get('orders', order.id)!.table_label_snapshot).toBe('T30');
      const busy = await patch(`/admin/tables/${t.id}`, 2, { is_active: false }).expect(409);
      expect(busy.body).toMatchObject({ code: 'TABLE_HAS_OPEN_ORDER', details: { order: { id: order.id } } });
      // Close the order (cancelled: no lines), then deactivation succeeds and the table leaves the grid.
      await storage.queue.run((tx) => tx.update('orders', tx.get('orders', order.id)!, { status: 'CANCELLED' }, 'ADM-1'));
      const off = (await patch(`/admin/tables/${t.id}`, 2, { is_active: false }).expect(200)).body;
      expect(off.is_active).toBe(false);
      expect(audits(t.id)).toEqual(expect.arrayContaining(['UPDATE', 'DEACTIVATE']));
      const grid = (await http().get('/api/v1/tables').set(as('CASHIER')).expect(200)).body;
      expect(grid.map((x: { id: string }) => x.id)).not.toContain(t.id);
    });

    it('REQ-113/REQ-019: a stale If-Match is 409 with the current table; a Cashier gets 403', async () => {
      const t = (await post('/admin/tables', { table_number: 'T40' }).expect(201)).body;
      const stale = await patch(`/admin/tables/${t.id}`, 7, { seats: 3 }).expect(409);
      expect(stale.body.details.current).toMatchObject({ id: t.id, row_version: 1 });
      await post('/admin/tables', { table_number: 'T41' }, 'CASHIER').expect(403);
      await patch(`/admin/tables/${t.id}`, 1, { seats: 3 }, 'CASHIER').expect(403);
    });
  });

  describe('staff (REQ-076, REQ-119, REQ-120, REQ-025)', () => {
    it('REQ-076/REQ-119: adds a staff member with a bcrypt PIN that can log in; pin_hash is never returned or audited', async () => {
      const res = await post('/admin/users', { display_name: 'Waiter Amit', role: 'CASHIER', pin: '4321', language: 'hi' }).expect(201);
      expect(res.body).toMatchObject({ id: expect.stringMatching(/^USR-\d{6}$/), display_name: 'Waiter Amit', role: 'CASHIER', language: 'hi', is_active: true, failed_pin_count: 0, token_version: 1 });
      expect(res.body.pin_hash).toBeUndefined();
      expect(res.body.pin).toBeUndefined();
      expect(user(res.body.id).pin_hash).toMatch(/^\$2[aby]\$10\$/);
      expect(JSON.stringify(storage.store.all('audit_log').filter((a) => a.entity_id === res.body.id))).not.toMatch(/pin_hash|\$2[aby]\$|4321/);
      await login(res.body.id, '4321').expect(200);
    });

    it('REQ-119: a 3-digit PIN is rejected with 400 on create and on reset', async () => {
      expect((await post('/admin/users', { display_name: 'Short Pin', role: 'CASHIER', pin: '123' }).expect(400)).body.code).toBe('VALIDATION_FAILED');
      await pinReset('USR-C', user('USR-C').row_version, '987').expect(400);
    });

    it('REQ-076: a display name already used by an active user is rejected; an inactive user’s name can be reused', async () => {
      const dup = await post('/admin/users', { display_name: 'cashier ravi', role: 'KITCHEN', pin: '1111' }).expect(409);
      expect(dup.body).toMatchObject({ code: 'DUPLICATE_NAME', details: { field: 'display_name', existing_id: 'USR-C' } });
      const gone = (await post('/admin/users', { display_name: 'Temp Staff', role: 'CASHIER', pin: '2222' }).expect(201)).body;
      await patch(`/admin/users/${gone.id}`, 1, { is_active: false }).expect(200);
      await post('/admin/users', { display_name: 'Temp Staff', role: 'CASHIER', pin: '3333' }).expect(201);
      // Reactivating the first one would clash now.
      expect((await patch(`/admin/users/${gone.id}`, 2, { is_active: true }).expect(409)).body.code).toBe('DUPLICATE_NAME');
    });

    it('REQ-119: a second active Admin with the same PIN is rejected on create and on reset; a repeat key of a created Admin answers 200', async () => {
      expect((await post('/admin/users', { display_name: 'Co Owner', role: 'ADMIN', pin: '1234' }).expect(409)).body.code).toBe('ADMIN_PIN_CLASH');
      // A non-Admin may share an Admin's PIN.
      await post('/admin/users', { display_name: 'Helper', role: 'KITCHEN', pin: '1234' }).expect(201);
      const co = (await post('/admin/users', { display_name: 'Co Owner', role: 'ADMIN', pin: '7777' }, 'ADMIN', 'co-owner').expect(201)).body;
      expect((await post('/admin/users', { display_name: 'Co Owner', role: 'ADMIN', pin: '7777' }, 'ADMIN', 'co-owner').expect(200)).body.id).toBe(co.id);
      expect((await pinReset(co.id, 1, '1234').expect(409)).body.code).toBe('ADMIN_PIN_CLASH');
      // Its own current PIN is not a clash.
      await pinReset(co.id, 1, '7777').expect(200);
    });

    it('REQ-119/REQ-120: after a forced reset the old PIN no longer logs in and the old token is rejected', async () => {
      const u = (await post('/admin/users', { display_name: 'Reset Me', role: 'CASHIER', pin: '1357' }).expect(201)).body;
      const old = (await login(u.id, '1357').expect(200)).body.token;
      const res = await pinReset(u.id, user(u.id).row_version, '2468').expect(200);
      expect(res.body).toMatchObject({ id: u.id, token_version: 2 });
      expect(res.body.pin_hash).toBeUndefined();
      expect(await verifyPin('2468', user(u.id).pin_hash)).toBe(true);
      expect((await login(u.id, '1357').expect(401)).body.code).toBe('WRONG_PIN');
      await http().get('/api/v1/settings').set(as(old)).expect(401);
      await login(u.id, '2468').expect(200);
      expect(audits(u.id)).toContain('PIN_RESET');
    });

    it('REQ-120: a deactivated user’s existing token is rejected on the next request; token_version is bumped', async () => {
      const u = (await post('/admin/users', { display_name: 'Leaving Soon', role: 'CASHIER', pin: '8642' }).expect(201)).body;
      const t = (await login(u.id, '8642').expect(200)).body.token;
      await http().get('/api/v1/settings').set(as(t)).expect(200);
      const res = await patch(`/admin/users/${u.id}`, 1, { is_active: false }).expect(200);
      expect(res.body).toMatchObject({ is_active: false, token_version: 2 });
      expect((await http().get('/api/v1/settings').set(as(t)).expect(401)).body.code).toBe('UNAUTHORIZED');
      expect(audits(u.id)).toContain('DEACTIVATE');
    });

    it('REQ-076: changes a role; a stale If-Match is 409 without pin_hash; the last active Admin cannot be removed', async () => {
      const u = (await post('/admin/users', { display_name: 'Role Swap', role: 'CASHIER', pin: '1470' }).expect(201)).body;
      expect((await patch(`/admin/users/${u.id}`, 1, { role: 'KITCHEN' }).expect(200)).body.role).toBe('KITCHEN');
      const stale = await patch(`/admin/users/${u.id}`, 1, { role: 'CASHIER' }).expect(409);
      expect(stale.body.code).toBe('ROW_VERSION_CONFLICT');
      expect(stale.body.details.current).toMatchObject({ id: u.id, row_version: 2 });
      expect(JSON.stringify(stale.body)).not.toMatch(/pin_hash|\$2[aby]\$/);
      await patch(`/admin/users/${u.id}`, 2, { pin_hash: 'x' }).expect(400);
      // Deactivate the co-owner, then the Owner is the last Admin.
      const co = storage.store.all('users').find((x) => x.display_name === 'Co Owner')!;
      await patch(`/admin/users/${co.id}`, co.row_version, { is_active: false }).expect(200);
      expect((await patch('/admin/users/ADM-1', user('ADM-1').row_version, { role: 'CASHIER' }).expect(409)).body.code).toBe('LAST_ADMIN');
    });

    it('REQ-025: the 5th wrong PIN locks for 5 minutes, a correct PIN is refused, an Admin unlock lets it in, and success resets the count', async () => {
      const u = (await post('/admin/users', { display_name: 'Lock Test', role: 'CASHIER', pin: '3690' }).expect(201)).body;
      for (const left of [4, 3, 2, 1]) expect((await login(u.id, '0000').expect(401)).body.details.remaining_tries).toBe(left);
      expect((await login(u.id, '0000').expect(423)).body.code).toBe('USER_LOCKED');
      const locked = user(u.id);
      expect(locked.failed_pin_count).toBe(5);
      expect(Date.parse(locked.locked_until!) - clock).toBe(5 * 60_000);
      clock += 60_000;
      await login(u.id, '3690').expect(423);
      const res = await patch(`/admin/users/${u.id}`, locked.row_version, { unlock: true }).expect(200);
      expect(res.body).toMatchObject({ failed_pin_count: 0, locked_until: null });
      expect(audits(u.id)).toContain('UNLOCK');
      await login(u.id, '0000').expect(401);
      expect(user(u.id).failed_pin_count).toBe(1);
      await login(u.id, '3690').expect(200);
      expect(user(u.id).failed_pin_count).toBe(0);
    });
  });

  describe('settings (REQ-080)', () => {
    const body = (extra: object = {}) => ({
      dhaba_name: 'Sher-e-Punjab Dhaba', address: 'NH-44, Karnal', phone: '9876543210', receipt_footer: 'Thank you, visit again',
      token_reset_time: '04:00', late_kot_minutes: 20, discount_limit_amount: '50', ...extra,
    });
    const put = (version: number, b: object, who: Role = 'ADMIN') => http().put('/api/v1/admin/settings').set(as(who)).set('If-Match', String(version)).send(b);
    const version = () => storage.store.all('settings')[0].row_version;

    it('REQ-080: every role reads the settings', async () => {
      for (const who of ['ADMIN', 'CASHIER', 'KITCHEN'] as Role[]) {
        const res = await http().get('/api/v1/settings').set(as(who)).expect(200);
        expect(res.body).toMatchObject({ id: 'SETTINGS', token_reset_time: '04:00' });
      }
    });

    it('REQ-080: saving without a GST number succeeds (no tax line); a stale If-Match is 409; a Cashier gets 403', async () => {
      const res = await put(version(), body()).expect(200);
      expect(res.body).toMatchObject({ dhaba_name: 'Sher-e-Punjab Dhaba', gst_number: null, gst_rate_percent: null, late_kot_minutes: 20, discount_limit_amount: '50.00', kitchen_print_enabled: false, updated_by: 'ADM-1' });
      const withGst = await put(version(), body({ gst_number: '07AAACB1234C1Z5', gst_rate_percent: 5, shift_end_time: '23:30' })).expect(200);
      expect(withGst.body).toMatchObject({ gst_number: '07AAACB1234C1Z5', gst_rate_percent: '5.00', shift_end_time: '23:30' });
      expect((await put(version() - 1, body()).expect(409)).body.details.current).toMatchObject({ id: 'SETTINGS' });
      await put(version(), body(), 'CASHIER').expect(403);
      expect(audits('SETTINGS')).toContain('UPDATE');
    });

    it('REQ-080: a bad time format or rate is 400', async () => {
      await put(version(), body({ token_reset_time: '4am' })).expect(400);
      await put(version(), body({ shift_end_time: '25:00' })).expect(400);
      expect((await put(version(), body({ gst_rate_percent: '120' })).expect(400)).body.code).toBe('INVALID_SETTING');
      expect((await put(version(), body({ gst_rate_percent: '5.555' })).expect(400)).body.code).toBe('INVALID_SETTING');
      await put(version(), body({ late_kot_minutes: 0 })).expect(400);
      await put(version(), { ...body(), id: 'X' }).expect(400);
    });

    it('REQ-080/REQ-067: a changed receipt footer appears on the next printed receipt', async () => {
      await put(version(), body({ receipt_footer: 'Shukriya! Phir aana' })).expect(200);
      const t = (await post('/admin/tables', { table_number: 'R1' }).expect(201)).body;
      const order = (await post('/orders/dine-in', { table_id: t.id }, 'CASHIER').expect(201)).body;
      const receipt = await post(`/orders/${order.id}/receipt-prints`, {}, 'CASHIER').expect(201);
      expect(receipt.body.settings.receipt_footer).toBe('Shukriya! Phir aana');
    });
  });
});
