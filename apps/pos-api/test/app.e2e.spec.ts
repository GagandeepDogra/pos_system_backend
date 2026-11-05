import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { StorageService } from '../src/storage/storage.service';
import { nowIst } from '../src/common/time';
import { loadConfig } from '../src/config';
import { tempDir } from './fixtures';

describe('pos-api bootstrap (REQ-002, REQ-104)', () => {
  let app: INestApplication;
  let storage: StorageService;

  beforeAll(async () => {
    storage = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await storage.open();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage)] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    storage.close();
  });

  it('REQ-002: starts with only a workbook (no database) and reports green', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'green', workbook: { loaded: true }, journal: { last_seq: 0, last_error: null } });
  });

  it('reports 503 until the workbook is loaded', async () => {
    const unloaded = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(unloaded)] }).compile();
    const other = moduleRef.createNestApplication();
    other.setGlobalPrefix('api/v1');
    await other.init();
    const res = await request(other.getHttpServer()).get('/api/v1/health').expect(503);
    expect(res.body.code).toBe('STARTING');
    await other.close();
  });

  it('formats timestamps in +05:30 and reads config defaults', () => {
    expect(nowIst(new Date('2026-11-05T00:00:00Z'))).toBe('2026-11-05T05:30:00.000+05:30');
    expect(loadConfig({})).toMatchObject({ port: 3000, sheetPassword: 'dhaba-pos' });
  });
});
