import path from 'path';
import { fromPaise, lineTotal, toPaise } from '../src/billing/money';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { seededData, tempDir } from './fixtures';
import { openTakeaway, recordPayment, sendKot } from './support/pos-ops';

describe('REQ-138: lunch-rush simulation', () => {
  it('REQ-138/REQ-129: 10 clients with double taps and a price change leave no duplicate, lost or mispriced record after a crash', async () => {
    const dir = tempDir();
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seededData(), 'x');
    const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await s.open();
    const twice = <T>(f: () => Promise<T>) => Promise.all([f(), f()]);

    const client = async (c: number, rounds: number) => {
      for (let r = 0; r < rounds; r++) {
        const tag = `c${c}-r${r}`;
        const [o] = await twice(() => openTakeaway(s.queue, `ord-${tag}`));
        await twice(() => sendKot(s.queue, o.row.id, `kot-${tag}-1`, [{ variantId: 'VAR-1', qty: 1 + (r % 3) }]));
        await twice(() => sendKot(s.queue, o.row.id, `kot-${tag}-2`, [{ variantId: 'VAR-2', qty: 4 }]));
        const due = s.store.get('orders', o.row.id)!.balance_due;
        const half = fromPaise(Math.floor(toPaise(due) / 2));
        await twice(() => recordPayment(s.queue, o.row.id, `pay-${tag}-a`, half));
        const rest = s.store.get('orders', o.row.id)!.balance_due;
        await twice(() => recordPayment(s.queue, o.row.id, `pay-${tag}-b`, rest));
      }
    };

    const first = Promise.all(Array.from({ length: 10 }, (_, c) => client(c, 3)));
    await first;
    const earlierLines = s.store.all('order_items').map((l) => ({ ...l }));
    // Price change in the middle of service: only new lines may use it.
    await s.queue.run((tx) => {
      const v = tx.get('variants', 'VAR-1')!;
      tx.replace('variants', { ...v, price: '240.00', row_version: v.row_version + 1, updated_at: tx.now });
    });
    await Promise.all(Array.from({ length: 10 }, (_, c) => client(c + 10, 2)));
    s.close(); // crash: nothing saved since startup

    const r = new StorageService({ dataDir: dir, sheetPassword: 'x' });
    await r.open();
    const orders = r.store.all('orders').filter((o) => o.client_request_id.startsWith('ord-'));
    expect(orders).toHaveLength(50);
    expect(r.store.all('kots')).toHaveLength(1 + 100);
    expect(r.store.all('payments')).toHaveLength(100);
    expect(new Set(r.store.all('payments').map((p) => p.idempotency_key)).size).toBe(100);
    expect(new Set(orders.map((o) => o.token)).size).toBe(50);

    for (const l of earlierLines) expect(r.store.get('order_items', l.id)).toEqual(l);
    for (const o of orders) {
      const lines = r.store.findBy('order_items', 'order_id', o.id);
      expect(lines).toHaveLength(2);
      const late = Number(o.client_request_id.split('-')[1].slice(1)) >= 10;
      for (const l of lines) {
        const expected = l.variant_id === 'VAR-1' ? (late ? '240.00' : '220.00') : '20.00';
        expect(l.unit_price).toBe(expected);
        expect(l.line_total).toBe(lineTotal(l.unit_price, l.quantity));
      }
      const subtotal = lines.reduce((sum, l) => sum + toPaise(l.line_total), 0);
      const paid = r.store.findBy('payments', 'order_id', o.id).reduce((sum, p) => sum + toPaise(p.amount), 0);
      expect(o.subtotal).toBe(fromPaise(subtotal));
      expect(paid).toBe(subtotal);
      expect(o).toMatchObject({ status: 'PAID', balance_due: '0.00', paid_amount: fromPaise(paid) });
    }
    r.close();
  }, 60000);
});
