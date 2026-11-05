// Save benchmark (REQ-107, REQ-128): grows a synthetic month of orders until
// the saved workbook is at least TARGET_MB, then times full saves.
// Run: npm run bench:save -w @dhaba/pos-api   (TARGET_MB=15 by default)
import fs from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { writeWorkbookFile } from '../../src/storage/workbook-file';
import { WorkbookData } from '../../src/storage/workbook-codec';
import { sampleData, tempDir } from '../fixtures';

const TARGET = Number(process.env.TARGET_MB ?? 15) * 1024 * 1024;

function grow(data: WorkbookData, days: number): void {
  const base = data.orders[0];
  const kot = data.kots[0];
  const line = data.order_items[0];
  const pay = { id: '', order_id: '', business_date: '', method: 'CASH' as const, amount: '120.00', tendered_amount: null, upi_ref: null,
    status: 'SUCCESS' as const, void_reason: null, voided_by: null, idempotency_key: '', created_at: base.created_at, created_by: 'U1',
    updated_at: base.updated_at, updated_by: 'U1', row_version: 1 };
  const start = data.orders.length;
  for (let d = 0; d < days; d++) {
    const date = `2026-10-${String((d % 28) + 1).padStart(2, '0')}`;
    for (let o = 0; o < 600; o++) {
      const n = start + d * 600 + o;
      const id = `ORD-X-${n}`;
      data.orders.push({ ...base, id, business_date: date, client_request_id: `req-${n}`, table_id: null, table_label_snapshot: null, status: 'PAID' });
      data.kots.push({ ...kot, id: `KOT-X-${n}`, order_id: id, business_date: date, idempotency_key: `kot-${n}` });
      for (let l = 0; l < 5; l++) data.order_items.push({ ...line, id: `OI-X-${n}-${l}`, order_id: id, kot_id: `KOT-X-${n}`, note: l % 2 ? 'less spicy' : null });
      data.payments.push({ ...pay, id: `PAY-X-${n}`, order_id: id, business_date: date, idempotency_key: `pay-${n}` });
      data.audit_log.push({ id: `AUD-X-${n}`, action: 'CREATE', entity_type: 'orders', entity_id: id, user_id: 'U1', approver_id: null,
        device_id: null, before_json: null, after_json: { status: 'OPEN' }, created_at: base.created_at });
    }
  }
}

async function main(): Promise<void> {
  const dir = tempDir();
  const file = path.join(dir, 'bench.xlsx');
  const data = sampleData();
  let size = 0;
  while (size < TARGET) {
    // ~0.33 MB per day of 600 orders; jump close to the target, then step.
    grow(data, size === 0 ? Math.max(1, Math.floor((TARGET / 1048576) * 2.9)) : 2);
    await writeWorkbookFile(file, data, 'x');
    size = fs.statSync(file).size;
    console.log(`orders=${data.orders.length} lines=${data.order_items.length} size=${(size / 1048576).toFixed(1)} MB`);
  }
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await writeWorkbookFile(file, data, 'x');
    times.push(performance.now() - t0);
  }
  console.log(`save of ${(size / 1048576).toFixed(1)} MB: ${times.map((t) => `${Math.round(t)} ms`).join(', ')} (target < 1000 ms on a Core i3 with SSD)`);
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
