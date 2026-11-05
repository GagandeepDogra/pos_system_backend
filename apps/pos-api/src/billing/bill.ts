// The billing service (REQ-058, REQ-059, REQ-060, REQ-061, REQ-102): every
// change that touches an order's money recomputes its totals here, inside the
// write queue, from the ACTIVE lines at their snapshot prices. Client-sent
// totals are never read.
import { DiscountType, ExceptionType, Order, OrderException, TableStatus } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { SessionUser } from '../auth/decorators';
import { ApiError } from '../common/errors';
import { isOpenOrder } from '../orders/dine-in';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';
import { fromPaise, toPaise } from './money';
import { computeTotals } from './totals';

export const EXCEPTION_COUNTER = 'EXCEPTION';

/** The table colour an order gives its table (REQ-033). */
export const tableStatusOf = (o: Pick<Order, 'status'>): TableStatus =>
  o.status === 'OPEN' ? 'OCCUPIED' : o.status === 'BILLED' ? 'READY_TO_CLOSE' : 'AVAILABLE';

export class OrderNotOpenError extends ApiError {
  constructor(order: Order) {
    super(409, 'ORDER_NOT_OPEN', 'This order is already closed.', 'यह ऑर्डर पहले ही बंद है।', { order_id: order.id, status: order.status });
  }
}

/** Recomputes the order's totals from its lines, payments and settings and applies `patch` in the same update. */
export function recomputeOrder(tx: Tx, order: Order, patch: Partial<Order>, userId: string): Order {
  const settings = tx.all('settings')[0];
  const base = { ...order, ...patch };
  const totals = computeTotals(base, tx.findBy('order_items', 'order_id', order.id), tx.findBy('payments', 'order_id', order.id), settings);
  return tx.update('orders', order, { ...patch, ...totals }, userId);
}

export interface ExceptionFields {
  order_id: string;
  exception_type: ExceptionType;
  reason_code: string;
  reason_text: string | null;
  amount: string | null;
  requested_by: string;
  approved_by: string | null;
}

/** Inserts an Exceptions row `EXC-NNNNNN` (counter EXCEPTION) in the same change. */
export function writeException(tx: Tx, fields: ExceptionFields): OrderException {
  return tx.insert('exceptions', {
    id: idFormats.seq('EXC', tx.nextCounter(counterKeys.seq(EXCEPTION_COUNTER))), ...fields,
    reason_code: fields.reason_code.slice(0, 20), reason_text: fields.reason_text?.slice(0, 80) ?? null, created_at: tx.now,
  });
}

/** Emits table.status_changed (when the table colour changes), order.updated and dashboard.updated. */
export function emitOrderChange(tx: Tx, before: Order, after: Order): void {
  if (after.table_id && tableStatusOf(before) !== tableStatusOf(after)) {
    tx.emit('table.status_changed', { table_id: after.table_id, status: tableStatusOf(after), order_id: after.id });
  }
  tx.emit('order.updated', { order_id: after.id, status: after.status, row_version: after.row_version, grand_total: after.grand_total, balance_due: after.balance_due });
  tx.emit('dashboard.updated', {});
}

// ---------------------------------------------------------------- print bill

export class EmptyBillError extends ApiError {
  constructor(orderId: string) {
    super(422, 'EMPTY_BILL', 'There are no items on this order to bill.', 'इस ऑर्डर में बिल के लिए कोई आइटम नहीं है।', { order_id: orderId });
  }
}

/**
 * printBill (REQ-060, REQ-059): recompute the totals, give the order a bill
 * number B-YYYYMMDD-NNN from the BILL:<business date> counter on its first
 * print (a reprint keeps it) and set it BILLED (table Ready to Close).
 */
export function printBill(tx: Tx, id: string, version: number, user: SessionUser): Order {
  const order = tx.expectVersion('orders', id, version);
  if (!isOpenOrder(order)) throw new OrderNotOpenError(order);
  if (!tx.findBy('order_items', 'order_id', id).some((l) => l.status === 'ACTIVE')) throw new EmptyBillError(id);

  const reprint = order.bill_no != null;
  let billNo = order.bill_no;
  if (!billNo) {
    const date = tx.businessDate();
    billNo = idFormats.bill(date, tx.nextCounter(counterKeys.bill(date)));
  }
  const updated = recomputeOrder(tx, order, { status: 'BILLED', bill_no: billNo }, user.id);
  writeAudit(tx, {
    action: reprint ? 'BILL_REPRINT' : 'BILL_PRINT', entity_type: 'orders', entity_id: id, user_id: user.id, device_id: user.device_id,
    before_json: { status: order.status, bill_no: order.bill_no, grand_total: order.grand_total },
    after_json: { status: updated.status, bill_no: billNo, subtotal: updated.subtotal, discount_amount: updated.discount_amount, tax_amount: updated.tax_amount, round_off: updated.round_off, grand_total: updated.grand_total },
  });
  emitOrderChange(tx, order, updated);
  return updated;
}

// ---------------------------------------------------------------- discount

export interface DiscountInput {
  discount_type: DiscountType;
  /** Rupees for FIXED, percent (0–100, up to 2 dp) for PERCENT. */
  value: string;
  reason_code: string;
  reason_text: string | null;
  approvalToken: string | null;
}

/** The discount in paise: FIXED as given, PERCENT of the subtotal rounded half-up to the paisa (REQ-102). */
export function discountPaise(subtotalPaise: number, type: DiscountType, value: string): number {
  const v = toPaise(value);
  if (type === 'FIXED') return v;
  // value "12.5" → 1250 hundredths of a percent.
  return Math.floor((subtotalPaise * v + 5000) / 10000);
}

export class DiscountTooLargeError extends ApiError {
  constructor(amount: string, subtotal: string) {
    super(422, 'DISCOUNT_TOO_LARGE', `The discount ₹${amount} is more than the subtotal ₹${subtotal}.`,
      `छूट ₹${amount} सबटोटल ₹${subtotal} से ज़्यादा है।`, { amount, subtotal });
  }
}

/**
 * applyDiscount (REQ-061): sets the order's discount to a fixed amount or a
 * percent of the current subtotal, with a reason. Above
 * Settings.discount_limit_amount a non-Admin must present an approval token,
 * consumed here inside the queue. Each discount writes a DISCOUNT exception and
 * an audit row. The stored discount is an amount; a percent is converted once.
 */
export function applyDiscount(
  tx: Tx, id: string, version: number, input: DiscountInput, user: SessionUser,
  consumeApproval: (token: string | null, userId: string) => string,
): Order {
  const order = tx.expectVersion('orders', id, version);
  if (!isOpenOrder(order)) throw new OrderNotOpenError(order);
  const lines = tx.findBy('order_items', 'order_id', id);
  const subtotal = lines.filter((l) => l.status === 'ACTIVE').reduce((s, l) => s + toPaise(l.line_total), 0);
  const discount = discountPaise(subtotal, input.discount_type, input.value);
  if (discount > subtotal) throw new DiscountTooLargeError(fromPaise(discount), fromPaise(subtotal));

  const limit = toPaise(tx.all('settings')[0]?.discount_limit_amount ?? '0');
  const needsApproval = discount > limit && user.role !== 'ADMIN';
  const approver = needsApproval ? consumeApproval(input.approvalToken, user.id) : null;

  const amount = fromPaise(discount);
  const reason = input.reason_text ?? input.reason_code;
  const updated = recomputeOrder(tx, order, { discount_amount: amount, discount_reason: discount > 0 ? reason.slice(0, 80) : null }, user.id);
  const exception = writeException(tx, {
    order_id: id, exception_type: 'DISCOUNT', reason_code: input.reason_code, reason_text: input.reason_text,
    amount, requested_by: user.id, approved_by: approver,
  });
  writeAudit(tx, {
    action: 'DISCOUNT', entity_type: 'orders', entity_id: id, user_id: user.id, approver_id: approver, device_id: user.device_id,
    before_json: { discount_amount: order.discount_amount, discount_reason: order.discount_reason, grand_total: order.grand_total },
    after_json: {
      discount_type: input.discount_type, value: input.value, discount_amount: updated.discount_amount, discount_reason: updated.discount_reason,
      grand_total: updated.grand_total, exception_id: exception.id,
    },
  });
  emitOrderChange(tx, order, updated);
  return updated;
}

