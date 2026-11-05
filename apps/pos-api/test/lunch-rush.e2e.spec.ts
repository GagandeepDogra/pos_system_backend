// Lunch-rush acceptance over HTTP (REQ-138, REQ-126, REQ-129): 10 clients with
// double taps open tables, send two KOTs, print the bill and settle it in two
// payment parts through the real routes, with a price change mid-service. The
// p95 of Send to Kitchen and Record Payment must stay under 1.5 s, and after a
// crash (nothing saved) the workbook holds no duplicate, lost or mispriced row.
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Order, OrderItem, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { fromPaise, lineTotal, toPaise } from '../src/billing/money';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, tempDir } from './fixtures';
import { sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const stamp = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const CLIENTS = 10;
const ROUNDS = 4;

const p95 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1];

describe('REQ-138: lunch rush over HTTP', () => {
  it('REQ-126/REQ-138/REQ-129/REQ-065: p95 send and pay < 1.5 s; no duplicate, lost or mispriced record after a crash', async () => {
    const dir = tempDir();
    const data = sampleSessionData();
    data.users.push({
      id: 'USR-C', display_name: 'Cashier Ravi', role: 'CASHIER', pin_hash: await hashPin('5678'), language: 'en', is_active: true,
      failed_pin_count: 0, locked_until: null, token_version: 1, ...stamp,
    } as UserRow);
    for (let c = 0; c < CLIENTS; c++) data.tables.push({ id: `TBL-R${c}`, table_number: `R${c}`, area: 'Rush', seats: 4, is_active: true, ...stamp });
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], new AuthService(storage, { jwtSecret: SECRET }))] }).compile();
    const app: INestApplication = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const http = () => request(app.getHttpServer());
    const token = (await http().post('/api/v1/auth/login').send({ user_id: 'USR-C', pin: '5678' }).expect(200)).body.token;
    const auth = { Authorization: `Bearer ${token}` };
    const sendMs: number[] = [];
    const payMs: number[] = [];
    const timed = async <T>(bucket: number[], f: () => Promise<T>) => {
      const t = Date.now();
      const r = await f();
      bucket.push(Date.now() - t);
      return r;
    };
    // A double tap: the same request (same Idempotency-Key) twice at once.
    const twice = <T>(f: () => Promise<T>) => Promise.all([f(), f()]);
    const order = (id: string): Order => storage.store.get('orders', id)!;

    const client = async (c: number, rounds: number, from: number) => {
      for (let r = from; r < from + rounds; r++) {
        const tag = `c${c}-r${r}`;
        const [o] = await twice(() => http().post('/api/v1/orders/dine-in').set(auth).set('Idempotency-Key', `ord-${tag}`).send({ table_id: `TBL-R${c}` }));
        const id = o.body.id as string;
        for (const [k, lines] of [['1', [{ variant_id: 'VAR-1', quantity: 1 + (r % 3) }]], ['2', [{ variant_id: 'VAR-5', quantity: 2 }, { variant_id: 'VAR-4', quantity: 1 }]]] as const) {
          const res = await twice(() => timed(sendMs, () => http().post(`/api/v1/orders/${id}/kots`).set(auth).set('Idempotency-Key', `kot-${tag}-${k}`).send({ lines })));
          expect(res.map((x) => x.status).sort()).toEqual([200, 201]);
        }
        await http().post(`/api/v1/orders/${id}/bill`).set(auth).set('If-Match', String(order(id).row_version)).expect(200);
        const half = fromPaise(Math.floor(toPaise(order(id).balance_due) / 2));
        await twice(() => timed(payMs, () => http().post(`/api/v1/orders/${id}/payments`).set(auth).set('Idempotency-Key', `pay-${tag}-a`).send({ method: 'UPI', amount: half })));
        const rest = order(id).balance_due;
        const paid = await twice(() => timed(payMs, () => http().post(`/api/v1/orders/${id}/payments`).set(auth).set('Idempotency-Key', `pay-${tag}-b`).send({ method: 'CASH', amount: rest })));
        expect(paid.map((x) => x.status).sort()).toEqual([200, 201]);
        expect(order(id).status).toBe('PAID');
      }
    };

    await Promise.all(Array.from({ length: CLIENTS }, (_, c) => client(c, ROUNDS / 2, 0)));
    const earlierLines: OrderItem[] = storage.store.all('order_items').map((l) => ({ ...l }));
    // Price change mid-service: only lines sent afterwards may use it.
    await storage.queue.run((tx) => {
      const v = tx.get('variants', 'VAR-1')!;
      tx.update('variants', v, { price: '240.00' }, 'ADM-1');
    });
    await Promise.all(Array.from({ length: CLIENTS }, (_, c) => client(c, ROUNDS / 2, ROUNDS / 2)));

    expect(p95(sendMs)).toBeLessThan(1500);
    expect(p95(payMs)).toBeLessThan(1500);

    await app.close();
    storage.close(); // power cut: nothing saved since startup, only the journal survives

    const r = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await r.open();
    const orders = r.store.all('orders').filter((o) => o.client_request_id.startsWith('ord-c'));
    expect(orders).toHaveLength(CLIENTS * ROUNDS);
    const kots = r.store.all('kots').filter((k) => k.idempotency_key.startsWith('kot-c'));
    expect(kots).toHaveLength(CLIENTS * ROUNDS * 2);
    const payments = r.store.all('payments').filter((p) => p.idempotency_key.startsWith('pay-c'));
    expect(payments).toHaveLength(CLIENTS * ROUNDS * 2);
    expect(new Set(payments.map((p) => p.idempotency_key)).size).toBe(payments.length);
    expect(new Set(r.store.all('payments').map((p) => p.idempotency_key)).size).toBe(r.store.all('payments').length);

    for (const l of earlierLines) expect(r.store.get('order_items', l.id)).toEqual(l);
    for (const o of orders) {
      const lines = r.store.findBy('order_items', 'order_id', o.id);
      expect(lines).toHaveLength(3);
      const late = Number(o.client_request_id.split('-r')[1]) >= ROUNDS / 2;
      for (const l of lines) {
        const expected = { 'VAR-1': late ? '240.00' : '220.00', 'VAR-5': '180.00', 'VAR-4': '60.00' }[l.variant_id];
        expect(l.unit_price).toBe(expected);
        expect(l.line_total).toBe(lineTotal(l.unit_price, l.quantity));
      }
      const subtotal = lines.reduce((s, l) => s + toPaise(l.line_total), 0);
      const paid = r.store.findBy('payments', 'order_id', o.id).reduce((s, p) => s + toPaise(p.amount), 0);
      expect(paid).toBe(subtotal);
      expect(o).toMatchObject({ status: 'PAID', subtotal: fromPaise(subtotal), paid_amount: fromPaise(paid), balance_due: '0.00' });
    }
    r.close();
  }, 120000);
});
