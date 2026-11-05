import fs from 'fs';
import path from 'path';
import { Body, Controller, Get, Headers, HttpCode, INestApplication, Param, Post, Res } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { WriteQueue } from '../src/storage/write-queue';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { seededData, tempDir } from './fixtures';
import { recordPayment } from './support/pos-ops';

/** Test-only routes standing in for the feature endpoints built later. */
@Controller('test')
class ProbeController {
  constructor(private readonly queue: WriteQueue) {}

  @Get('ping')
  ping(): { ok: true } {
    return { ok: true };
  }

  @Post('orders/:id/touch')
  @HttpCode(200)
  touch(@Param('id') id: string, @Headers('if-match') ifMatch: string) {
    return this.queue.run((tx) => {
      const order = tx.expectVersion('orders', id, Number(ifMatch));
      return tx.replace('orders', { ...order, updated_at: tx.now, row_version: order.row_version + 1 });
    });
  }

  @Post('orders/:id/payments')
  async pay(@Param('id') id: string, @Headers('idempotency-key') key: string, @Body() body: { amount: string }, @Res() res: { status(code: number): { json(body: unknown): void } }) {
    const r = await recordPayment(this.queue, id, key, body.amount);
    res.status(r.replayed ? 200 : 201).json(r.row);
  }
}

async function appFor(storage: StorageService): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [ProbeController])] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

describe('journal over HTTP (REQ-105, REQ-106, REQ-065)', () => {
  it('REQ-105: requests are refused with 503 until loading completes', async () => {
    const dir = tempDir();
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seededData(), 'x');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    storage.lockFolder();
    const app = await appFor(storage);
    const http = request(app.getHttpServer());
    expect((await http.get('/api/v1/test/ping').expect(503)).body.code).toBe('STARTING');
    expect((await http.get('/api/v1/health').expect(503)).body.code).toBe('STARTING');
    await storage.load();
    await http.get('/api/v1/test/ping').expect(200);
    await http.get('/api/v1/health').expect(200);
    await app.close();
    storage.close();
  });

  it('REQ-113: a row_version mismatch returns 409 with the current row; a match returns 200', async () => {
    const dir = tempDir();
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seededData(), 'x');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const app = await appFor(storage);
    const http = request(app.getHttpServer());
    const stale = await http.post('/api/v1/test/orders/ORD-20261105-0001/touch').set('If-Match', '5').expect(409);
    expect(stale.body).toMatchObject({ code: 'ROW_VERSION_CONFLICT', details: { current: { row_version: 1 } } });
    expect(stale.body.message_hi).toBeTruthy();
    const ok = await http.post('/api/v1/test/orders/ORD-20261105-0001/touch').set('If-Match', '1').expect(200);
    expect(ok.body.row_version).toBe(2);
    await app.close();
    storage.close();
  });

  it('REQ-065/REQ-129: a repeated key returns the original payment (200); after a power cut it still exists', async () => {
    const dir = tempDir();
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seededData(), 'x');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const app = await appFor(storage);
    const http = request(app.getHttpServer());
    const first = await http.post('/api/v1/test/orders/ORD-20261105-0001/payments').set('Idempotency-Key', 'tap-1').send({ amount: '120.00' }).expect(201);
    const retry = await http.post('/api/v1/test/orders/ORD-20261105-0001/payments').set('Idempotency-Key', 'tap-1').send({ amount: '120.00' }).expect(200);
    expect(retry.body).toEqual(first.body);
    // Power cut right after the confirmed reply: no save, memory gone.
    await app.close();
    storage.close();
    expect(fs.existsSync(storage.journal.file)).toBe(true);

    const restarted = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await restarted.open();
    expect(restarted.store.findUnique('payments', 'idempotency_key', 'tap-1')).toEqual(first.body);
    expect(restarted.store.all('payments')).toHaveLength(1);
    expect(restarted.store.get('orders', 'ORD-20261105-0001')!.status).toBe('PAID');
    restarted.close();
  });

  it('a corrupt workbook: health is red with the recovery offer, other routes 503', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, WORKBOOK_FILE), 'broken');
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const app = await appFor(storage);
    const http = request(app.getHttpServer());
    const health = await http.get('/api/v1/health').expect(200);
    expect(health.body).toMatchObject({ status: 'red', workbook: { loaded: false }, recovery: { backup: null } });
    expect((await http.get('/api/v1/test/ping').expect(503)).body.code).toBe('WRITES_BLOCKED');
    await app.close();
    storage.close();
  });
});
