import { parseIdempotencyKey, parseIfMatch } from '../common/headers';
import { toErrorBody } from '../common/error.filter';
import { ApiError } from '../common/errors';
import { stripFormula, stripFormulas } from '../common/validation';
import { BadRequestException } from '@nestjs/common';
import { FakeClock } from '../../test/support/fake-clock';
import { businessDate, counterKeys, createStamp, idFormats, updateStamp } from './repository';
import { SaveScheduler, SaveTarget } from './save-scheduler';
import path from 'path';
import { tempDir } from '../../test/fixtures';
import { StorageService, WORKBOOK_FILE } from './storage.service';
import { readWorkbookFile } from './workbook-file';

describe('repository rules (REQ-097, REQ-098, REQ-101)', () => {
  it('REQ-097: 01:00 on Nov 6 belongs to Nov 5; 04:01 to Nov 6', () => {
    expect(businessDate('2026-11-06T01:00:00+05:30')).toBe('2026-11-05');
    expect(businessDate('2026-11-06T04:01:00+05:30')).toBe('2026-11-06');
    expect(businessDate('2026-11-06T03:59:59+05:30')).toBe('2026-11-05');
    expect(businessDate('2026-11-06T04:00:00+05:30')).toBe('2026-11-06');
    expect(businessDate('2026-11-06T01:00:00+05:30', '00:00')).toBe('2026-11-06');
    expect(() => businessDate(new Date(), '4am')).toThrow('invalid reset time');
  });

  it('REQ-098: a row created at 13:02 IST stores created_at ending in +05:30; an update adds 1 to row_version', () => {
    const stamp = createStamp('2026-11-05T13:02:00.000+05:30', 'USR-1');
    expect(stamp).toEqual({ created_at: '2026-11-05T13:02:00.000+05:30', created_by: 'USR-1', updated_at: stamp.created_at, updated_by: 'USR-1', row_version: 1 });
    const row = { id: 'X', name: 'a', ...stamp };
    const next = updateStamp(row, { name: 'b', id: 'Y', row_version: 99, created_by: 'evil' } as never, '2026-11-05T13:05:00.000+05:30', 'USR-2');
    expect(next).toEqual({ ...row, name: 'b', updated_at: '2026-11-05T13:05:00.000+05:30', updated_by: 'USR-2', row_version: 2 });
  });

  it('REQ-101: id and counter formats', () => {
    expect(idFormats.order('2026-11-05', 8)).toBe('ORD-20261105-0008');
    expect(idFormats.token(7)).toBe('T-007');
    expect(idFormats.bill('2026-11-05', 12)).toBe('B-20261105-012');
    expect(idFormats.kot('2026-11-05', 3)).toBe('KOT-20261105-0003');
    expect(idFormats.seq('PAY', 5)).toBe('PAY-000005');
    expect([counterKeys.order(), counterKeys.token('d'), counterKeys.kot('d'), counterKeys.bill('d'), counterKeys.seq('PAYMENT')])
      .toEqual(['ORDER', 'TOKEN:d', 'KOT:d', 'BILL:d', 'PAYMENT']);
  });
});

describe('input guards (REQ-113, REQ-114, REQ-124)', () => {
  it('REQ-124: leading = + - @ are stripped from text, plain numbers are kept', () => {
    expect(stripFormula('=HYPERLINK("x")')).toBe('HYPERLINK("x")');
    expect(stripFormula(' +-@cmd')).toBe('cmd');
    expect(stripFormula('-5.00')).toBe('-5.00');
    expect(stripFormulas({ a: ['@x', { b: '=y' }], n: 3, z: null })).toEqual({ a: ['x', { b: 'y' }], n: 3, z: null });
  });

  it('REQ-113: If-Match is required and must be a positive integer', () => {
    expect(parseIfMatch('3')).toBe(3);
    expect(parseIfMatch(['"4"'])).toBe(4);
    expect(() => parseIfMatch(undefined)).toThrow(ApiError);
    expect(() => parseIfMatch('abc')).toThrow(ApiError);
    expect(parseIdempotencyKey(' k ')).toBe('k');
    expect(() => parseIdempotencyKey('')).toThrow(ApiError);
    expect(() => parseIdempotencyKey('x'.repeat(65))).toThrow(ApiError);
  });

  it('REQ-114: every error leaves as {code, message_en, message_hi, details}', () => {
    expect(toErrorBody(new BadRequestException('nope')).body).toMatchObject({ code: 'BAD_REQUEST', details: { message: 'nope' } });
    expect(toErrorBody(new Error('x'))).toMatchObject({ status: 500, body: { code: 'INTERNAL_ERROR', details: null } });
  });
});

describe('coalesced save (REQ-107)', () => {
  function target(fail = false) {
    const t = { lastSavedSeq: 0, changeSeq: 0, calls: 0, fail } as SaveTarget & { lastSavedSeq: number; changeSeq: number; calls: number; fail: boolean };
    t.save = async () => {
      t.calls++;
      if (t.fail) throw new Error('disk full');
      t.lastSavedSeq = t.changeSeq;
    };
    return t;
  }

  it('REQ-107: ten changes within one second produce one save, within 2 s of the last change', async () => {
    const clock = new FakeClock('2026-11-05T12:00:00+05:30');
    const t = target();
    const s = new SaveScheduler(t, clock);
    for (let i = 0; i < 10; i++) {
      t.changeSeq++;
      s.changed();
      await clock.advance(100, () => s.whenIdle());
    }
    expect(t.calls).toBe(0);
    await clock.advance(1100, () => s.whenIdle());
    expect(t.calls).toBe(1);
    expect(t.lastSavedSeq).toBe(10);
    await clock.advance(10_000, () => s.whenIdle());
    expect(t.calls).toBe(1);
  });

  it('REQ-107: saves are at least 2 s apart; a change during a save is saved after it', async () => {
    const clock = new FakeClock('2026-11-05T12:00:00+05:30');
    const t = target();
    const s = new SaveScheduler(t, clock);
    t.changeSeq = 1;
    s.changed();
    await clock.advance(2000, () => s.whenIdle());
    expect(t.calls).toBe(1);
    await clock.advance(500);
    t.changeSeq = 2;
    s.changed();
    await clock.advance(1900, () => s.whenIdle());
    expect(t.calls).toBe(1);
    await clock.advance(100, () => s.whenIdle());
    expect(t.calls).toBe(2);
  });

  it('REQ-107: the storage service saves ten queued changes in one coalesced save', async () => {
    const dir = tempDir();
    const storage = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await storage.open();
    const clock = new FakeClock('2026-11-05T12:00:00+05:30');
    const auto = storage.startAutoSave({ clock });
    expect(storage.saveScheduler).toBe(auto);
    for (let i = 0; i < 10; i++) {
      await storage.queue.run((tx) => {
        const s = tx.all('settings')[0];
        tx.update('settings', s, { dhaba_name: `Dhaba ${i}` }, 'USR-1');
        tx.emit('dashboard.updated', {});
        expect(tx.businessDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });
    }
    await clock.advance(2000, () => auto.whenIdle());
    expect(auto.saves).toBe(1);
    expect(storage.lastSavedSeq).toBe(storage.journal.lastSeq);
    const saved = await readWorkbookFile(path.join(dir, WORKBOOK_FILE));
    expect(saved.settings[0]).toMatchObject({ dhaba_name: 'Dhaba 9', row_version: 11, updated_by: 'USR-1' });
    expect(storage.saveAlert).toBeNull();
    storage.close();
  });

  it('REQ-117: a failed save is reported and retried; flush and stop', async () => {
    const clock = new FakeClock('2026-11-05T12:00:00+05:30');
    const t = target(true);
    const errors: Error[] = [];
    const s = new SaveScheduler(t, clock, 2000, (e) => errors.push(e));
    t.changeSeq = 1;
    s.changed();
    await clock.advance(2000, () => s.whenIdle());
    expect(errors).toHaveLength(1);
    t.fail = false;
    await clock.advance(2000, () => s.whenIdle());
    expect(t.lastSavedSeq).toBe(1);
    t.changeSeq = 2;
    s.changed();
    await s.flush();
    expect(t.lastSavedSeq).toBe(2);
    s.stop();
    t.changeSeq = 3;
    s.changed();
    await clock.advance(5000);
    expect(t.calls).toBe(3);
  });
});
