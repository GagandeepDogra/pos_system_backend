// HTTP checks of backup download and validated restore (WI-017): audit + Admin-only download,
// 422 for bad uploads, double PIN, pre-restore snapshot, swap under the write lock, app.reload.
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { io, Socket } from 'socket.io-client';
import { Role, UserRow } from '@dhaba/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { AuthService } from '../src/auth/auth.service';
import { hashPin } from '../src/auth/pin';
import { RestoreService } from '../src/backups/restore';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { WorkbookData } from '../src/storage/workbook-codec';
import { readWorkbookFile, writeWorkbookFile } from '../src/storage/workbook-file';
import { NOW, tempDir } from './fixtures';
import { sampleSessionData } from './support/sample-session';

const SECRET = 'test-jwt-secret-0123456789abcdef-XYZ';
const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function binaryParser(res: any, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

async function toBuffer(data: WorkbookData): Promise<Buffer> {
  const file = path.join(tempDir(), 'x.xlsx');
  await writeWorkbookFile(file, data, 'x');
  return fs.readFileSync(file);
}

async function edit(buffer: Buffer, change: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  change(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function setCell(wb: ExcelJS.Workbook, sheet: string, column: string, value: ExcelJS.CellValue): void {
  const ws = wb.getWorksheet(sheet)!;
  let col = 0;
  ws.getRow(1).eachCell((c, n) => {
    if (c.value === column) col = n;
  });
  ws.getRow(2).getCell(col).value = value;
}

describe('backup download and restore over HTTP (WI-017)', () => {
  let app: INestApplication;
  let storage: StorageService;
  let socket: Socket;
  let backup: Buffer;
  let base: WorkbookData;
  const tokens = {} as Record<Role, string>;
  const http = () => request(app.getHttpServer());
  const as = (who: Role) => ({ Authorization: `Bearer ${tokens[who]}` });
  let n = 0;
  const upload = (buf: Buffer, who: Role = 'ADMIN') =>
    http().post('/api/v1/admin/restores').set(as(who)).set('Idempotency-Key', `k-${++n}`).attach('file', buf, 'backup.xlsx');

  beforeAll(async () => {
    const dir = tempDir();
    const data = sampleSessionData();
    const mk = async (id: string, display_name: string, role: Role, pin: string): Promise<UserRow> => ({
      id, display_name, role, pin_hash: await hashPin(pin), language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1, ...audit,
    });
    data.users.push(await mk('ADM-1', 'Owner', 'ADMIN', '1234'), await mk('USR-C', 'Cashier Ravi', 'CASHIER', '5678'));
    base = data;
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), data, 'x');
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const auth = new AuthService(storage, { jwtSecret: SECRET, now: () => Date.parse('2026-11-05T13:00:00.000+05:30') });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], auth)] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    const login = async (user_id: string, pin: string) => (await http().post('/api/v1/auth/login').send({ user_id, pin }).expect(200)).body.token;
    tokens.ADMIN = await login('ADM-1', '1234');
    tokens.CASHIER = await login('USR-C', '5678');
    socket = io(await app.getUrl(), { path: '/socket.io', transports: ['websocket'] });
    await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
  });

  afterAll(async () => {
    socket.close();
    await app.close();
    storage.close();
  });

  it('REQ-123: a Cashier backup download returns 403 and gets no file', async () => {
    const res = await http().get('/api/v1/admin/backups/download').set(as('CASHIER')).expect(403);
    expect(res.body.code).toBe('ACCESS_DENIED');
  });

  it('REQ-123: an Admin download streams the live workbook and writes a BACKUP_DOWNLOAD audit row', async () => {
    const res = await http().get('/api/v1/admin/backups/download').set(as('ADMIN')).buffer(true).parse(binaryParser).expect(200);
    expect(res.headers['content-type']).toContain(XLSX);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="dhaba-pos-.*\.xlsx"/);
    backup = res.body as Buffer;
    const rows = storage.store.all('audit_log').filter((a) => a.action === 'BACKUP_DOWNLOAD');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'ADM-1', entity_type: 'backups', entity_id: 'LIVE' });
    // The download is current: it already holds its own audit row.
    const file = path.join(tempDir(), 'dl.xlsx');
    fs.writeFileSync(file, backup);
    const data = await readWorkbookFile(file);
    expect(data.audit_log.some((a) => a.id === rows[0].id)).toBe(true);
  });

  it('REQ-103: the downloaded workbook is sheet-protected with locked ids and an enum dropdown on status', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(backup as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('orders')!;
    expect((ws as unknown as { sheetProtection: { sheet: boolean } }).sheetProtection.sheet).toBe(true);
    expect(ws.getRow(2).getCell(1).protection?.locked).not.toBe(false);
    const model = (ws as unknown as { dataValidations: { model: Record<string, ExcelJS.DataValidation> } }).dataValidations.model;
    const lists = Object.values(model).filter((v) => v.type === 'list').map((v) => String(v.formulae?.[0]));
    expect(lists.some((f) => f.includes('OPEN') && f.includes('CANCELLED'))).toBe(true);
    expect(Object.values(model).find((v) => String(v.formulae?.[0]).includes('OPEN'))?.showErrorMessage).toBe(true);
  });

  it('REQ-079: a named snapshot downloads; an unknown or path-like name is 404', async () => {
    const snap = await storage.backups.snapshot('auto');
    const res = await http().get('/api/v1/admin/backups/download').query({ snapshot: snap.name }).set(as('ADMIN')).buffer(true).parse(binaryParser).expect(200);
    expect((res.body as Buffer).equals(fs.readFileSync(snap.file))).toBe(true);
    expect(res.headers['content-disposition']).toContain(snap.name);
    await http().get('/api/v1/admin/backups/download').query({ snapshot: 'snapshot-20991231-000000-auto.xlsx' }).set(as('ADMIN')).expect(404);
    const bad = await http().get('/api/v1/admin/backups/download').query({ snapshot: '../dhaba-pos.xlsx' }).set(as('ADMIN')).expect(404);
    expect(bad.body.code).toBe('SNAPSHOT_NOT_FOUND');
  });

  it('REQ-110: a Cashier upload is 403; an empty upload is 400', async () => {
    await upload(backup, 'CASHIER').expect(403);
    const res = await http().post('/api/v1/admin/restores').set(as('ADMIN')).set('Idempotency-Key', 'k-empty').expect(400);
    expect(res.body.code).toBe('FILE_REQUIRED');
  });

  it('REQ-110: a wrong schema version, a missing sheet, a missing column or a non-xlsx file is rejected with 422', async () => {
    const v2 = structuredClone(base);
    v2.meta[0] = { ...v2.meta[0], schema_version: 99 };
    let res = await upload(await toBuffer(v2)).expect(422);
    expect(res.body.code).toBe('RESTORE_INVALID');
    expect(res.body.details.errors.join()).toMatch(/schema_version 99/);
    res = await upload(await edit(backup, (wb) => wb.removeWorksheet(wb.getWorksheet('payments')!.id))).expect(422);
    expect(res.body.details.errors).toContain('missing sheet "payments"');
    res = await upload(await edit(backup, (wb) => (wb.getWorksheet('orders')!.getRow(1).getCell(1).value = 'order_id'))).expect(422);
    expect(res.body.details.errors.join()).toMatch(/orders: missing columns id/);
    res = await upload(Buffer.from('not a workbook')).expect(422);
    expect(res.body.details.errors).toEqual(['the file is not an .xlsx workbook']);
  });

  it('REQ-110: duplicate ids and broken references are rejected with 422', async () => {
    const dup = structuredClone(base);
    dup.orders.push({ ...dup.orders[0], client_request_id: 'other-key', bill_no: null });
    let res = await upload(await toBuffer(dup)).expect(422);
    expect(res.body.details.errors.join()).toMatch(/orders row \d+: duplicate id/);
    const broken = structuredClone(base);
    broken.payments[0] = { ...broken.payments[0], order_id: 'ORD-NOPE' };
    res = await upload(await toBuffer(broken)).expect(422);
    expect(res.body.details.errors.join()).toMatch(/order_id "ORD-NOPE" does not exist in orders/);
  });

  it('REQ-103: a hand-edited invalid status, or an amount with 3 decimals, is rejected by restore validation', async () => {
    let res = await upload(await edit(backup, (wb) => setCell(wb, 'orders', 'status', 'DONE'))).expect(422);
    expect(res.body.details.errors.join()).toMatch(/status has invalid value "DONE"/);
    res = await upload(await edit(backup, (wb) => setCell(wb, 'payments', 'amount', 12.345))).expect(422);
    expect(res.body.details.errors.join()).toMatch(/amount must be a number with at most 2 decimals/);
  });

  it('REQ-110: a file without an active Admin is rejected', async () => {
    const noAdmin = structuredClone(base);
    noAdmin.users = noAdmin.users.filter((u) => u.role !== 'ADMIN');
    const res = await upload(await toBuffer(noAdmin)).expect(422);
    expect(res.body.details.errors).toEqual(['users: the file has no active Admin']);
  });

  let restoreId: string;

  it('REQ-079: a valid upload returns a restore id, the file date and order/payment counts; a retry is 200', async () => {
    const res = await http().post('/api/v1/admin/restores').set(as('ADMIN')).set('Idempotency-Key', 'k-good').attach('file', backup, 'backup.xlsx').expect(201);
    expect(res.body).toMatchObject({ file_name: 'backup.xlsx', schema_version: 1, order_count: base.orders.length, payment_count: base.payments.length });
    expect(res.body.restore_id).toMatch(/^RST-/);
    expect(res.body.file_date).toMatch(/\+05:30$/);
    restoreId = res.body.restore_id;
    const again = await http().post('/api/v1/admin/restores').set(as('ADMIN')).set('Idempotency-Key', 'k-good').attach('file', backup, 'backup.xlsx').expect(200);
    expect(again.body.restore_id).toBe(restoreId);
    // Staged outside backups/, so crash recovery never mistakes it for a backup.
    expect(fs.existsSync(path.join(storage.restoreStagingDir, `${restoreId}.xlsx`))).toBe(true);
  });

  it('REQ-110: a raw xlsx body is accepted too', async () => {
    const res = await http().post('/api/v1/admin/restores').set(as('ADMIN')).set('Idempotency-Key', 'k-raw').set('Content-Type', XLSX).send(backup).expect(201);
    expect(res.body.order_count).toBe(base.orders.length);
  });

  it('REQ-079: mismatched PIN entries, a wrong PIN or an unknown restore id swap nothing', async () => {
    await storage.queue.run((tx) => tx.update('settings', tx.get('settings', 'SETTINGS')!, { dhaba_name: 'Changed After Backup' }, 'ADM-1'));
    const confirm = (id: string, pin: string, pin_confirm: string) => http().post(`/api/v1/admin/restores/${id}/confirm`).set(as('ADMIN')).send({ pin, pin_confirm });
    expect((await confirm(restoreId, '1234', '1243').expect(403)).body.code).toBe('PIN_MISMATCH');
    expect((await confirm(restoreId, '9999', '9999').expect(403)).body.code).toBe('PIN_NOT_ADMIN');
    expect((await confirm('RST-unknown', '1234', '1234').expect(404)).body.code).toBe('RESTORE_NOT_FOUND');
    await http().post(`/api/v1/admin/restores/${restoreId}/confirm`).set(as('CASHIER')).send({ pin: '5678', pin_confirm: '5678' }).expect(403);
    expect(storage.store.get('settings', 'SETTINGS')!.dhaba_name).toBe('Changed After Backup');
    expect(storage.backups.folder.list().some((s) => s.reason === 'pre-restore')).toBe(false);
  });

  it('REQ-079/REQ-110: confirming saves a pre-restore snapshot, swaps the workbook and tells every device to reload', async () => {
    const reload = new Promise<Record<string, unknown>>((resolve) => socket.once('app.reload', resolve));
    const started = Date.now();
    const res = await http().post(`/api/v1/admin/restores/${restoreId}/confirm`).set(as('ADMIN')).send({ pin: '1234', pin_confirm: '1234' }).expect(200);
    const event = await reload;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(event).toMatchObject({ reason: 'RESTORE', restore_id: restoreId });
    expect(res.body).toMatchObject({ restored: true, restore_id: restoreId, order_count: base.orders.length });
    // The pre-restore snapshot holds the data as it was just before the swap.
    const pre = storage.backups.folder.list().find((s) => s.name === res.body.pre_restore_snapshot)!;
    expect(pre.reason).toBe('pre-restore');
    expect((await readWorkbookFile(pre.file)).settings[0].dhaba_name).toBe('Changed After Backup');
    // Memory and the live file now hold the backup's data, plus the RESTORE audit row.
    expect(storage.store.get('settings', 'SETTINGS')!.dhaba_name).toBe('My Dhaba');
    expect(storage.store.all('audit_log').filter((a) => a.action === 'RESTORE')).toHaveLength(1);
    const live = await readWorkbookFile(storage.workbookPath);
    expect(live.settings[0].dhaba_name).toBe('My Dhaba');
    expect(fs.existsSync(path.join(storage.restoreStagingDir, `${restoreId}.xlsx`))).toBe(false);
    // The id is single use.
    await http().post(`/api/v1/admin/restores/${restoreId}/confirm`).set(as('ADMIN')).send({ pin: '1234', pin_confirm: '1234' }).expect(404);
  });

  it('REQ-110: writes arriving during the swap wait for the lock and land in the restored data, which survives a restart', async () => {
    const restores = new RestoreService(storage);
    const preview = await restores.preview(backup, 'backup.xlsx', 'ADM-1');
    await storage.queue.run((tx) => tx.update('settings', tx.get('settings', 'SETTINGS')!, { dhaba_name: 'Before Second Restore' }, 'ADM-1'));
    const swap = restores.confirm(preview.restore_id, 'ADM-1');
    // Queued while the restore holds the queue: it must run after the swap.
    const write = storage.queue.run((tx) => tx.update('settings', tx.get('settings', 'SETTINGS')!, { receipt_footer: 'Written during restore' }, 'ADM-1'));
    expect(storage.queue.depth).toBeGreaterThanOrEqual(2);
    await swap;
    await write;
    const settings = storage.store.get('settings', 'SETTINGS')!;
    expect(settings.dhaba_name).toBe('My Dhaba');
    expect(settings.receipt_footer).toBe('Written during restore');

    // Restart: the restored file plus the journal (only post-restore entries) load cleanly.
    const dir = path.dirname(storage.workbookPath);
    await app.close();
    storage.close();
    storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    expect(storage.state).toBe('ready');
    const after = storage.store.get('settings', 'SETTINGS')!;
    expect(after.dhaba_name).toBe('My Dhaba');
    expect(after.receipt_footer).toBe('Written during restore');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(storage, [], [], { jwtSecret: SECRET })] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });
});
