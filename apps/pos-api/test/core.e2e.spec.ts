import fs from 'fs';
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { readWorkbookFile, writeWorkbookFile } from '../src/storage/workbook-file';
import { seededData, tempDir } from './fixtures';
import { DemoController } from './support/demo.controller';

describe('pos-api core over HTTP (REQ-106, REQ-113, REQ-114, REQ-115, REQ-116, REQ-124)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let dir: string;
  let url: string;
  let socket: Socket;
  const events: { name: string; body: Record<string, unknown> }[] = [];
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    dir = tempDir();
    const data = seededData();
    data.tables.push({ ...data.tables[0], id: 'TBL-2', table_number: 'T2' });
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [DemoController])] }).compile();
    app = moduleRef.createNestApplication();
    const web = path.join(dir, 'web');
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, 'index.html'), '<html>pwa</html>');
    configureApp(app, { webDir: web });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    socket = io(url, { path: '/socket.io', transports: ['websocket'] });
    socket.onAny((name, body) => events.push({ name, body }));
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
  });

  afterAll(async () => {
    socket.close();
    await app.close();
    storage.close();
  });

  const waitFor = async (name: string, pred: (b: Record<string, unknown>) => boolean = () => true) => {
    const started = Date.now();
    while (Date.now() - started < 3000) {
      const hit = events.find((e) => e.name === name && pred(e.body));
      if (hit) return { ...hit, ms: Date.now() - started };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${name} event within 3 s`);
  };

  it('REQ-115: /health answers 200 without an Authorization header', async () => {
    const res = await http().get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'green', alert: null });
  });

  it('REQ-098/REQ-101/REQ-124: a takeaway gets server ids, +05:30 stamps and a formula-free name; a repeat key returns 200 without enqueuing', async () => {
    const res = await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-take-1')
      .send({ customer_name: '=HYPERLINK("http://x","y")' }).expect(201);
    expect(res.body.customer_name).toBe('HYPERLINK("http://x","y")');
    expect(res.body.id).toMatch(/^ORD-\d{8}-\d{4}$/);
    expect(res.body.created_at).toMatch(/\+05:30$/);
    expect(res.body.row_version).toBe(1);
    // Only after the journal line was fsync'd does the reply come back.
    expect(storage.journal.lastSeq).toBeGreaterThan(0);
    const depthSpy = jest.spyOn(storage.queue, 'run');
    const again = await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-take-1').send({}).expect(200);
    expect(again.body).toEqual(res.body);
    expect(depthSpy).not.toHaveBeenCalled();
    depthSpy.mockRestore();
  });

  it('REQ-101: two orders created at the same moment get different ids and tokens', async () => {
    const [a, b] = await Promise.all([
      http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-same-a').send({}),
      http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-same-b').send({}),
    ]);
    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.token).not.toBe(b.body.token);
  });

  it('REQ-114/REQ-124: a client-supplied id or an unknown field is rejected with the error body', async () => {
    for (const body of [{ id: 'ORD-EVIL' }, { grand_total: '1.00' }]) {
      const res = await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', `k-bad-${Object.keys(body)[0]}`).send(body).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', message_en: expect.any(String), message_hi: expect.any(String) });
    }
    expect(storage.store.findUnique('orders', 'client_request_id', 'k-bad-id')).toBeUndefined();
    await http().post('/api/v1/demo/orders/takeaway').send({}).expect(400);
  });

  it('REQ-113: updates need If-Match, bump row_version by 1 and answer 409 with the current row when stale', async () => {
    const created = (await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-upd').send({})).body;
    const missing = await http().patch(`/api/v1/demo/orders/${created.id}`).send({ customer_name: 'A' }).expect(428);
    expect(missing.body.code).toBe('IF_MATCH_REQUIRED');
    const ok = await http().patch(`/api/v1/demo/orders/${created.id}`).set('If-Match', '1').send({ customer_name: 'A' }).expect(200);
    expect(ok.body.row_version).toBe(2);
    expect(ok.body.created_at).toBe(created.created_at);
    const before = events.length;
    const stale = await http().patch(`/api/v1/demo/orders/${created.id}`).set('If-Match', '1').send({ customer_name: 'B' }).expect(409);
    expect(stale.body).toMatchObject({ code: 'ROW_VERSION_CONFLICT', details: { current: { row_version: 2, customer_name: 'A' } } });
    await new Promise((r) => setTimeout(r, 200));
    expect(events.slice(before)).toEqual([]); // a rejected write emits nothing
  });

  it('REQ-114/REQ-116: a KOT ignores a client price, records the server price and reaches sockets within 3 s', async () => {
    const order = (await http().post('/api/v1/demo/orders/dine-in').set('Idempotency-Key', 'k-dine').send({ table_id: 'TBL-2' })).body;
    expect(order).toMatchObject({ table_id: 'TBL-2', table_label_snapshot: 'T2', status: 'OPEN' });
    const res = await http().post(`/api/v1/demo/orders/${order.id}/kots`).set('Idempotency-Key', 'k-kot-1')
      .send({ lines: [{ variant_id: 'VAR-1', quantity: 2, price: '1.00', unit_price: '1.00' }] }).expect(201);
    const line = storage.store.findBy('order_items', 'kot_id', res.body.id)[0];
    expect(line).toMatchObject({ unit_price: '220.00', line_total: '440.00' });
    const ev = await waitFor('table.status_changed', (b) => b.table_id === 'TBL-2');
    expect(ev.ms).toBeLessThan(3000);
    expect(ev.body).toMatchObject({ status: 'OCCUPIED', seq: expect.any(Number) });
    await waitFor('kot.created', (b) => b.kot_id === res.body.id);
  });

  it('REQ-114: TABLE_BUSY carries code, message_en and message_hi', async () => {
    const res = await http().post('/api/v1/demo/orders/dine-in').set('Idempotency-Key', 'k-dine-2').send({ table_id: 'TBL-2' }).expect(409);
    expect(res.body).toMatchObject({ code: 'TABLE_BUSY', message_en: expect.any(String), message_hi: expect.any(String) });
  });

  it('REQ-009: an unknown API path is a 404 error body, other paths get the PWA', async () => {
    const res = await http().get('/api/v1/online-orders').expect(404);
    expect(res.body).toMatchObject({ code: 'NOT_FOUND', message_hi: expect.any(String) });
    const page = await http().get('/tables').expect(200);
    expect(page.text).toContain('pwa');
  });

  it('REQ-117/REQ-129: a journal failure (disk full) answers 503, leaves no row and turns /health red', async () => {
    const spy = jest.spyOn(storage.journal, 'append').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    const before = events.length;
    const res = await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-full').send({}).expect(503);
    expect(res.body).toMatchObject({ code: 'SAVE_FAILED', message_en: expect.stringContaining('Saving problem, call owner') });
    expect(res.body).not.toHaveProperty('id');
    expect(storage.store.findUnique('orders', 'client_request_id', 'k-full')).toBeUndefined();
    expect((await http().get('/api/v1/health')).body.status).toBe('red');
    spy.mockRestore();
    await new Promise((r) => setTimeout(r, 100));
    expect(events.slice(before)).toEqual([]);
    await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-full').send({}).expect(201);
    expect((await http().get('/api/v1/health')).body.status).toBe('green');
  });

  it('REQ-107/REQ-117/REQ-104: a failed save keeps the previous live file, turns /health red, and reads still answer from memory', async () => {
    await storage.save();
    const live = path.join(dir, WORKBOOK_FILE);
    const savedOrders = (await readWorkbookFile(live)).orders.length;
    await http().post('/api/v1/demo/orders/takeaway').set('Idempotency-Key', 'k-before-fail').send({}).expect(201);
    // Simulate the file being locked: the rename over the live file fails.
    const rename = jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
    await expect(storage.save()).rejects.toThrow('EBUSY');
    rename.mockRestore();
    const health = (await http().get('/api/v1/health')).body;
    expect(health).toMatchObject({ status: 'red', workbook: { last_save_error: expect.stringContaining('EBUSY') }, alert: { code: 'SAVE_FAILED' } });
    expect((await readWorkbookFile(live)).orders).toHaveLength(savedOrders);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const menu = await http().get('/api/v1/demo/menu').expect(200);
    expect(menu.body.length).toBeGreaterThan(0);
    await storage.save();
    expect((await http().get('/api/v1/health')).body.status).toBe('green');
  });
});
