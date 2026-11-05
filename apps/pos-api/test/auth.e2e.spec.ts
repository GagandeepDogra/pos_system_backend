import fs from 'fs';
import path from 'path';
import { Body, Controller, Get, HttpCode, INestApplication, Param, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ROLES, Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { writeAudit } from '../src/audit/audit';
import { AuthService, deactivatePatch, findAdminByPin, pinResetPatch, sessionExpiry, unlockPatch } from '../src/auth/auth.service';
import { ApprovalToken, CurrentUser, Roles, SessionUser } from '../src/auth/decorators';
import { defaultSecretFile, loadJwtSecret } from '../src/auth/jwt-secret';
import { signJwt, verifyJwt } from '../src/auth/jwt';
import { PERMISSIONS } from '../src/auth/permissions';
import { hashPin } from '../src/auth/pin';
import { counterKeys, idFormats } from '../src/storage/repository';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { CONTRACT_ROUTES, stubController } from './support/contract-routes';
import { NOW, seededData, tempDir } from './fixtures';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };

/** Test stand-in for the close-with-balance route (WI-010): Admin acts alone, a cashier needs an approval token. */
@Controller('probe')
class ApprovalProbeController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Post('orders/:id/close-exception')
  @HttpCode(200)
  @Roles(...PERMISSIONS.closeWithException)
  close(@Param('id') id: string, @CurrentUser() user: SessionUser, @ApprovalToken() token: string | null, @Body() body: { reason_code?: string }) {
    return this.storage.queue.run((tx) => {
      const approver = user.role === 'ADMIN' ? null : this.auth.approvals.consume(token, user.id);
      const exc = tx.insert('exceptions', {
        id: idFormats.seq('EXC', tx.nextCounter(counterKeys.seq('EXCEPTION'))), order_id: id, exception_type: 'CLOSE_WITH_BALANCE',
        reason_code: body.reason_code ?? 'OTHER', reason_text: null, amount: '120.00', requested_by: user.id, approved_by: approver, created_at: tx.now,
      });
      writeAudit(tx, { action: 'CLOSE_EXCEPTION', entity_type: 'orders', entity_id: id, user_id: user.id, approver_id: approver });
      return exc;
    });
  }
}

/** An /admin route with no @Roles: the guard defaults it to ADMIN only. */
@Controller('admin/probe')
class AdminDefaultController {
  @Get()
  get() {
    return { ok: true };
  }
}

describe('authentication, role guards and approvals (WI-005)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let auth: AuthService;
  let dir: string;
  let clock = Date.parse('2026-11-05T12:00:00+05:30');
  const http = () => request(app.getHttpServer());
  const user = (id: string) => storage.store.get('users', id)!;
  const patchUser = (id: string, patch: (u: UserRow) => Partial<UserRow>) =>
    storage.queue.run((tx) => tx.update('users', tx.get('users', id)!, patch(tx.get('users', id)!), 'ADM-1'));
  const login = (user_id: string, pin: string, device_role?: Role) => http().post('/api/v1/auth/login').send({ user_id, pin, device_role });
  const token = async (id: string, pin: string, device?: Role) => {
    const res = await login(id, pin, device).expect(200);
    return res.body.token as string;
  };
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    dir = tempDir();
    const data = seededData();
    const mk = (id: string, display_name: string, role: Role, pin: string, extra: Partial<UserRow> = {}): Promise<UserRow> =>
      hashPin(pin).then((pin_hash) => ({
        id, display_name, role, pin_hash, language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit, ...extra,
      }));
    data.users.push(
      ...(await Promise.all([
        mk('ADM-1', 'Owner', 'ADMIN', '1234'),
        mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'),
        mk('USR-C2', 'Cashier Meena', 'CASHIER', '2468'),
        mk('USR-K', 'Kitchen Raju', 'KITCHEN', '9012'),
        mk('USR-OLD', 'Gone Staff', 'CASHIER', '1111', { is_active: false }),
      ])),
    );
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    auth = new AuthService(storage, { jwtSecret: SECRET, now: () => clock });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(storage, [ApprovalProbeController, AdminDefaultController, stubController(new Set(['createApproval', 'updateMyLanguage', 'listTables', 'openTableSession', 'getOrder', 'moveOrder', 'mergeOrders', 'getMenu', 'setItemAvailability', 'markItemOutOfStock', 'sendToKitchen', 'listKitchenKots', 'updateKotStatus', 'cancelOrderItem', 'printBill', 'applyDiscount']))], [], auth)],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  describe('login tiles and PIN login', () => {
    it('REQ-024: GET /auth/staff without a token lists active names and roles, never pin_hash', async () => {
      const res = await http().get('/api/v1/auth/staff').expect(200);
      expect(res.body).toEqual(expect.arrayContaining([{ id: 'ADM-1', display_name: 'Owner', role: 'ADMIN' }]));
      expect(res.body.map((u: { id: string }) => u.id)).not.toContain('USR-OLD');
      expect(JSON.stringify(res.body)).not.toMatch(/pin_hash|\$2[aby]\$/);
    });

    it('REQ-024/REQ-111: a correct PIN returns a 12 h JWT and the user without pin_hash', async () => {
      const res = await login('USR-C', '5678').expect(200);
      expect(res.body.user).toMatchObject({ id: 'USR-C', role: 'CASHIER' });
      expect(res.body.user.pin_hash).toBeUndefined();
      const claims = verifyJwt(res.body.token, SECRET)!;
      expect(claims.exp - claims.iat).toBe(12 * 3600);
      expect(res.body.expires_at).toMatch(/\+05:30$/);
    });

    it('REQ-119: a 3-digit PIN is rejected with 400', async () => {
      const res = await login('USR-C', '567').expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('REQ-025: a wrong PIN answers 401 with the remaining tries; a success resets the count to 0', async () => {
      let res = await login('USR-C2', '0000').expect(401);
      expect(res.body).toMatchObject({ code: 'WRONG_PIN', details: { remaining_tries: 4 } });
      res = await login('USR-C2', '0001').expect(401);
      expect(res.body.details.remaining_tries).toBe(3);
      expect(user('USR-C2').failed_pin_count).toBe(2);
      await login('USR-C2', '2468').expect(200);
      expect(user('USR-C2').failed_pin_count).toBe(0);
    });

    it('REQ-025: the 5th wrong PIN locks for 5 minutes, a correct PIN is refused while locked, and an Admin unlock lets it in', async () => {
      for (const left of [4, 3, 2, 1]) expect((await login('USR-C', '0000').expect(401)).body.details.remaining_tries).toBe(left);
      const locked = await login('USR-C', '0000').expect(423);
      expect(locked.body).toMatchObject({ code: 'USER_LOCKED', details: { remaining_tries: 0 } });
      const until = Date.parse(user('USR-C').locked_until!);
      expect(until - clock).toBe(5 * 60_000);
      await login('USR-C', '5678').expect(423);
      await patchUser('USR-C', () => unlockPatch());
      await login('USR-C', '5678').expect(200);
      expect(user('USR-C')).toMatchObject({ failed_pin_count: 0, locked_until: null });
    });

    it('REQ-025: once the 5 minutes pass, the user can log in again with a fresh count', async () => {
      for (let i = 0; i < 5; i++) await login('USR-C2', '0000');
      await login('USR-C2', '2468').expect(423);
      clock += 5 * 60_000 + 1;
      expect((await login('USR-C2', '0000').expect(401)).body.details.remaining_tries).toBe(4);
      await login('USR-C2', '2468').expect(200);
    });

    it('REQ-024: an unknown or deactivated user cannot log in', async () => {
      await login('USR-OLD', '1111').expect(401);
      await login('NOPE', '1111').expect(401);
    });
  });

  describe('sessions', () => {
    it('REQ-018/REQ-111: a request without a Bearer token, or with a forged one, gets 401', async () => {
      await http().get('/api/v1/dashboard').expect(401);
      const forged = signJwt({ sub: 'ADM-1', role: 'ADMIN', tv: 1, kd: false, iat: clock / 1000, exp: clock / 1000 + 60 }, 'another-secret-of-enough-length!!');
      expect((await http().get('/api/v1/dashboard').set(bearer(forged)).expect(401)).body.code).toBe('UNAUTHORIZED');
    });

    it('REQ-026/REQ-111: a token older than 12 hours returns 401', async () => {
      const t = await token('ADM-1', '1234');
      clock += 12 * 3600_000 - 1000;
      await http().get('/api/v1/dashboard').set(bearer(t)).expect(200);
      clock += 1000;
      await http().get('/api/v1/dashboard').set(bearer(t)).expect(401);
    });

    it('REQ-026: at the configured shift end a cashier session ends, a kitchen device session does not', async () => {
      await storage.queue.run((tx) => tx.update('settings', tx.all('settings')[0], { shift_end_time: '23:00' }, 'ADM-1'));
      clock = Date.parse('2026-11-07T20:00:00+05:30');
      const cashier = await token('USR-C', '5678');
      const kitchen = await token('USR-K', '9012', 'KITCHEN');
      const kitchenOnCounter = await token('USR-K', '9012');
      clock = Date.parse('2026-11-07T22:59:59+05:30');
      await http().get('/api/v1/menu').set(bearer(cashier)).expect(200);
      clock = Date.parse('2026-11-07T23:00:00+05:30');
      await http().get('/api/v1/menu').set(bearer(cashier)).expect(401);
      await http().get('/api/v1/menu').set(bearer(kitchenOnCounter)).expect(401);
      await http().get('/api/v1/menu').set(bearer(kitchen)).expect(200);
      await storage.queue.run((tx) => tx.update('settings', tx.all('settings')[0], { shift_end_time: null }, 'ADM-1'));
    });

    it('REQ-026: session expiry is min(12 h, next shift end)', () => {
      const at = Date.parse('2026-11-05T23:30:00+05:30');
      expect(sessionExpiry(at, '23:00', false)).toBe(at + 12 * 3600_000);
      expect(sessionExpiry(at, '02:00', false)).toBe(Date.parse('2026-11-06T02:00:00+05:30'));
      expect(sessionExpiry(at, null, false)).toBe(at + 12 * 3600_000);
      expect(sessionExpiry(at, '02:00', true)).toBe(at + 12 * 3600_000);
    });

    it('REQ-120/REQ-024: deactivating a user removes the tile and revokes their token', async () => {
      await patchUser('USR-C2', () => ({ is_active: true, failed_pin_count: 0, locked_until: null }));
      const t = await token('USR-C2', '2468');
      await http().get('/api/v1/menu').set(bearer(t)).expect(200);
      await patchUser('USR-C2', deactivatePatch);
      await http().get('/api/v1/menu').set(bearer(t)).expect(401);
      const staff = await http().get('/api/v1/auth/staff').expect(200);
      expect(staff.body.map((u: { id: string }) => u.id)).not.toContain('USR-C2');
      await login('USR-C2', '2468').expect(401);
      await patchUser('USR-C2', () => ({ is_active: true }));
    });

    it('REQ-119/REQ-120: after a forced PIN reset the old PIN and the old token stop working', async () => {
      const t = await token('USR-K', '9012');
      const hash = await hashPin('4321');
      await patchUser('USR-K', (u) => pinResetPatch(u, hash));
      await login('USR-K', '9012').expect(401);
      await http().get('/api/v1/menu').set(bearer(t)).expect(401);
      await login('USR-K', '4321').expect(200);
    });

    it('REQ-120: the JWT secret is not in the workbook, its backups or the journal', async () => {
      await storage.save();
      const live = path.join(dir, WORKBOOK_FILE);
      for (const file of [live, path.join(dir, 'dhaba-pos.journal')]) {
        if (fs.existsSync(file)) expect(fs.readFileSync(file).includes(SECRET)).toBe(false);
      }
      expect(JSON.stringify(storage.store.toData())).not.toContain(SECRET);
    });

    it('REQ-120: the secret comes from JWT_SECRET or a file outside the data folder, never inside it', () => {
      const base = tempDir();
      const data = path.join(base, 'data');
      expect(() => loadJwtSecret({ JWT_SECRET: 'short' }, data)).toThrow(/32/);
      expect(loadJwtSecret({ JWT_SECRET: SECRET }, data)).toBe(SECRET);
      const generated = loadJwtSecret({}, data);
      expect(generated.length).toBeGreaterThanOrEqual(32);
      expect(fs.readFileSync(defaultSecretFile(data), 'utf8')).toBe(generated);
      expect(fs.statSync(defaultSecretFile(data)).mode & 0o077).toBe(0);
      expect(loadJwtSecret({}, data)).toBe(generated);
      expect(() => loadJwtSecret({ JWT_SECRET_FILE: path.join(data, 'secret') }, data)).toThrow(/outside/);
    });
  });

  describe('role matrix (REQ-018, REQ-019, REQ-020, REQ-021)', () => {
    let tokens: Record<Role, string>;
    beforeAll(async () => {
      clock = Date.parse('2026-11-08T12:00:00+05:30');
      tokens = { ADMIN: await token('ADM-1', '1234'), CASHIER: await token('USR-C', '5678'), KITCHEN: await token('USR-K', '4321') };
    });

    it('REQ-018: every contract route answers each role as the matrix says; no token is 401', async () => {
      const mismatches: string[] = [];
      for (const route of CONTRACT_ROUTES.filter((r) => r.op !== 'createApproval' && r.op !== 'updateMyLanguage')) {
        const url = `/api/v1/${route.path.replace(':id', 'X-1')}`;
        const call = () => http()[route.method.toLowerCase() as 'get'](url);
        if ((await call()).status !== 401) mismatches.push(`${route.op} without token`);
        for (const role of ROLES) {
          const res = await call().set(bearer(tokens[role]));
          const allowed = PERMISSIONS[route.op].includes(role);
          if (allowed ? res.status === 403 || res.status === 401 : res.status !== 403 || res.body.code !== 'ACCESS_DENIED') {
            mismatches.push(`${route.op} as ${role}: ${res.status}`);
          }
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('REQ-019: an Admin token gets no 403 on any /admin endpoint', async () => {
      const admin = CONTRACT_ROUTES.filter((r) => r.path.startsWith('admin/'));
      expect(admin.length).toBeGreaterThanOrEqual(20);
      for (const route of admin) {
        const res = await http()[route.method.toLowerCase() as 'get'](`/api/v1/${route.path.replace(':id', 'X-1')}`).set(bearer(tokens.ADMIN));
        expect([route.op, res.status]).toEqual([route.op, 200]);
      }
      await http().get('/api/v1/admin/probe').set(bearer(tokens.ADMIN)).expect(200);
      await http().get('/api/v1/admin/probe').set(bearer(tokens.CASHIER)).expect(403);
    });

    it('REQ-018/REQ-020: a Cashier calling the price-change API gets 403 and an ACCESS_DENIED audit row', async () => {
      const before = storage.store.all('audit_log').length;
      const res = await http().post('/api/v1/admin/variants/VAR-1/price-changes').set(bearer(tokens.CASHIER)).set('X-Device-Id', 'phone-7').send({ new_price: '1.00' }).expect(403);
      expect(res.body).toMatchObject({ code: 'ACCESS_DENIED', message_en: expect.any(String), message_hi: expect.any(String) });
      const rows = storage.store.all('audit_log').slice(before);
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'ACCESS_DENIED', entity_type: 'admin', entity_id: 'VAR-1', user_id: 'USR-C', device_id: 'phone-7', after_json: null,
          before_json: { method: 'POST', path: '/admin/variants/VAR-1/price-changes', role: 'CASHIER' },
        }),
      ]);
      expect(rows[0].id).toMatch(/^AUD-\d{6}$/);
    });

    it('REQ-021: a Kitchen user calling a payment endpoint gets 403', async () => {
      await http().post('/api/v1/orders/ORD-20261105-0001/payments').set(bearer(tokens.KITCHEN)).set('Idempotency-Key', 'k1').send({}).expect(403);
      await http().get('/api/v1/bills/open').set(bearer(tokens.KITCHEN)).expect(403);
      await http().post('/api/v1/kitchen/items/ITM-1/out-of-stock').set(bearer(tokens.CASHIER)).expect(403);
    });
  });

  describe('Admin approvals (REQ-023, REQ-019)', () => {
    let cashier: string;
    const approve = (pin: string, key: string, t = cashier) => http().post('/api/v1/auth/approvals').set(bearer(t)).set('Idempotency-Key', key).send({ pin });
    const closeWith = (approval: string | null, t = cashier) => {
      const req = http().post('/api/v1/probe/orders/ORD-20261105-0001/close-exception').set(bearer(t)).send({ reason_code: 'CUSTOMER_LEFT' });
      return approval ? req.set('X-Approval-Token', approval) : req;
    };
    beforeAll(async () => {
      cashier = await token('USR-C', '5678');
    });

    it('REQ-023: a correct Admin PIN returns a single-use token; the action records the Admin as approver; reuse is rejected', async () => {
      const res = await approve('1234', 'appr-1').expect(201);
      expect(res.body).toMatchObject({ admin_id: 'ADM-1', approval_token: expect.any(String), requested_by: 'USR-C' });
      expect(storage.store.all('audit_log').at(-1)).toMatchObject({ action: 'APPROVAL', user_id: 'USR-C', approver_id: 'ADM-1' });
      const done = await closeWith(res.body.approval_token).expect(200);
      expect(done.body).toMatchObject({ requested_by: 'USR-C', approved_by: 'ADM-1' });
      expect(storage.store.get('exceptions', done.body.id)!.approved_by).toBe('ADM-1');
      expect(storage.store.all('audit_log').at(-1)).toMatchObject({ action: 'CLOSE_EXCEPTION', user_id: 'USR-C', approver_id: 'ADM-1' });
      const again = await closeWith(res.body.approval_token).expect(403);
      expect(again.body.code).toBe('APPROVAL_INVALID');
      await closeWith(null).expect(403);
    });

    it('REQ-023: a repeat Idempotency-Key returns the same approval with 200', async () => {
      const first = await approve('1234', 'appr-2').expect(201);
      const second = await approve('1234', 'appr-2').expect(200);
      expect(second.body.approval_token).toBe(first.body.approval_token);
      await approve('1234', '').expect(400);
    });

    it('REQ-023: a non-Admin PIN on the override pad is rejected with 403', async () => {
      const res = await approve('5678', 'appr-3').expect(403);
      expect(res.body.code).toBe('NOT_ADMIN_PIN');
      await approve('0000', 'appr-4').expect(403);
    });

    it('REQ-023: an approval not used within 2 minutes expires', async () => {
      const res = await approve('1234', 'appr-5').expect(201);
      clock += 2 * 60_000;
      expect((await closeWith(res.body.approval_token).expect(403)).body.details.reason).toBe('expired');
    });

    it('REQ-023: an approval issued to one user cannot be used by another', async () => {
      const res = await approve('1234', 'appr-6').expect(201);
      const admin = await token('ADM-1', '1234');
      const other = await token('USR-C2', '2468');
      expect((await closeWith(res.body.approval_token, other).expect(403)).body.details.reason).toBe('issued to another user');
      expect((await closeWith(null, admin).expect(200)).body.approved_by).toBeNull();
    });

    it('REQ-119: findAdminByPin matches only active Admins', async () => {
      const users = storage.store.all('users');
      expect((await findAdminByPin(users, '1234'))?.id).toBe('ADM-1');
      expect(await findAdminByPin(users, '1234', 'ADM-1')).toBeUndefined();
      expect(await findAdminByPin(users, '5678')).toBeUndefined();
    });
  });

  describe('language (REQ-008)', () => {
    it('REQ-008: a user switches their own language; another user is unchanged; a stale If-Match is 409 without pin_hash', async () => {
      const cashier = await token('USR-C', '5678');
      const version = user('USR-C').row_version;
      const res = await http().patch('/api/v1/me/language').set(bearer(cashier)).set('If-Match', String(version)).send({ language: 'hi' }).expect(200);
      expect(res.body).toMatchObject({ id: 'USR-C', language: 'hi', row_version: version + 1 });
      expect(res.body.pin_hash).toBeUndefined();
      expect(user('USR-C2').language).toBe('en');
      expect(user('ADM-1').language).toBe('en');
      expect(storage.store.all('audit_log').at(-1)).toMatchObject({ action: 'UPDATE', entity_id: 'USR-C', after_json: { language: 'hi' } });
      const stale = await http().patch('/api/v1/me/language').set(bearer(cashier)).set('If-Match', String(version)).send({ language: 'en' }).expect(409);
      expect(stale.body.details.current).toMatchObject({ language: 'hi' });
      expect(stale.body.details.current.pin_hash).toBeUndefined();
      await http().patch('/api/v1/me/language').set(bearer(cashier)).set('If-Match', String(version + 1)).send({ language: 'pa' }).expect(400);
      await http().patch('/api/v1/me/language').set(bearer(cashier)).send({ language: 'en' }).expect(428);
    });
  });
});
