// Minimal order / KOT / payment changes run through the real write queue.
// They stand in for the feature services (built later) in the durability tests.
import { Order, OrderItem, Payment } from '@dhaba/shared';
import { buildOrderLine } from '../../src/billing/order-line';
import { fromPaise, toPaise } from '../../src/billing/money';
import { WriteQueue } from '../../src/storage/write-queue';

const BD = '2026-11-05';
const ymd = BD.replace(/-/g, '');

export function openTakeaway(queue: WriteQueue, key: string) {
  return queue.runIdempotent('orders', 'client_request_id', key, (tx) => {
    const n = tx.nextCounter('ORDER');
    const order: Order = {
      id: `ORD-${ymd}-${String(n).padStart(4, '0')}`, order_type: 'TAKEAWAY', business_date: BD, table_id: null,
      table_label_snapshot: null, token: `T-${String(tx.nextCounter(`TOKEN:${BD}`)).padStart(3, '0')}`,
      customer_name: null, customer_phone: null, guest_count: null, status: 'OPEN', bill_no: null,
      subtotal: '0.00', discount_amount: '0.00', discount_reason: null, tax_amount: '0.00', round_off: '0.00',
      grand_total: '0.00', paid_amount: '0.00', balance_due: '0.00', merged_into_order_id: null,
      handed_over_at: null, client_request_id: key, created_at: tx.now, created_by: 'U1', updated_at: tx.now,
      updated_by: 'U1', row_version: 1,
    };
    return tx.insert('orders', order);
  });
}

export function sendKot(queue: WriteQueue, orderId: string, key: string, lines: { variantId: string; qty: number }[]) {
  return queue.runIdempotent('kots', 'idempotency_key', key, (tx) => {
    const order = tx.get('orders', orderId)!;
    const n = tx.nextCounter(`KOT:${BD}`);
    const kot = tx.insert('kots', {
      id: `KOT-${ymd}-${String(n).padStart(4, '0')}`, kot_number: n, business_date: BD, order_id: orderId,
      status: 'NEW', idempotency_key: key, sent_at: tx.now, served_at: null, hide_after: null,
      created_at: tx.now, created_by: 'U1', updated_at: tx.now, updated_by: 'U1', row_version: 1,
    });
    let added = 0;
    for (const l of lines) {
      const variant = tx.get('variants', l.variantId)!;
      const item = tx.get('items', variant.item_id)!;
      const line: OrderItem = buildOrderLine(item, variant, {
        id: `OI-${tx.nextCounter('ORDER_ITEM')}`, order_id: orderId, kot_id: kot.id, quantity: l.qty,
        note: null, user_id: 'U1', now: tx.now,
      });
      tx.insert('order_items', line);
      added += toPaise(line.line_total);
    }
    const subtotal = toPaise(order.subtotal) + added;
    const balance = subtotal - toPaise(order.paid_amount);
    tx.replace('orders', {
      ...order, subtotal: fromPaise(subtotal), grand_total: fromPaise(subtotal), balance_due: fromPaise(balance),
      updated_at: tx.now, row_version: order.row_version + 1,
    });
    return kot;
  });
}

export class OverpaymentError extends Error {}

export function recordPayment(queue: WriteQueue, orderId: string, key: string, amount: string) {
  return queue.runIdempotent('payments', 'idempotency_key', key, (tx) => {
    const order = tx.get('orders', orderId)!;
    const balance = toPaise(order.balance_due);
    if (toPaise(amount) > balance) throw new OverpaymentError('OVERPAYMENT');
    const payment: Payment = {
      id: `PAY-${ymd}-${String(tx.nextCounter('PAYMENT')).padStart(4, '0')}`, order_id: orderId, business_date: BD,
      method: 'CASH', amount, tendered_amount: null, upi_ref: null, status: 'SUCCESS', void_reason: null,
      voided_by: null, idempotency_key: key, created_at: tx.now, created_by: 'U1', updated_at: tx.now,
      updated_by: 'U1', row_version: 1,
    };
    tx.insert('payments', payment);
    const left = balance - toPaise(amount);
    tx.replace('orders', {
      ...order, paid_amount: fromPaise(toPaise(order.paid_amount) + toPaise(amount)), balance_due: fromPaise(left),
      status: left === 0 ? 'PAID' : order.status, updated_at: tx.now, row_version: order.row_version + 1,
    });
    return payment;
  });
}
