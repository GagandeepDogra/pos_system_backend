// Payments, voids and close-with-exception (REQ-062..069, REQ-129): every
// change runs inside the write queue, rechecks the balance from the order's
// lines and SUCCESS payments (recomputeOrder) and commits in one journal entry.
import { CloseReasonCode, Order, Payment, PaymentMethod } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { SessionUser } from '../auth/decorators';
import { OrderNotOpenError, emitOrderChange, recomputeOrder, writeException } from '../billing/bill';
import { fromPaise, toPaise } from '../billing/money';
import { computeTotals } from '../billing/totals';
import { ApiError, NotFoundError } from '../common/errors';
import { hideOrderKots } from '../kitchen/kots';
import { TableBusyError, isOpenOrder } from '../orders/dine-in';
import { activeOrderForTable } from '../tables/table-status';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';

export const PAYMENT_COUNTER = 'PAYMENT';

type Reader = Pick<Tx, 'all'>;
type ConsumeApproval = (token: string | null, userId: string) => string;

// ---------------------------------------------------------------- open bills

export interface OpenBill extends Order {
  /** Table number or takeaway token, for the list row. */
  label: string;
  /** BILLED = the bill is printed and the table is Ready to Close (REQ-062). */
  ready_to_close: boolean;
}

/** listOpenBills (REQ-062): OPEN/BILLED orders with a balance due, oldest first. */
export function openBills(store: Reader): OpenBill[] {
  return store.all('orders')
    .filter((o) => isOpenOrder(o) && toPaise(o.balance_due) > 0)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((o) => ({ ...o, label: o.table_label_snapshot ?? o.token ?? o.id, ready_to_close: o.status === 'BILLED' }));
}

// ---------------------------------------------------------------- record payment

export interface PaymentInput {
  method: PaymentMethod;
  amount: string;
  tendered_amount: string | null;
  upi_ref: string | null;
}

export class OverpaymentError extends ApiError {
  constructor(amount: string, balance: string) {
    super(422, 'OVERPAYMENT', `₹${amount} is more than the balance due ₹${balance}.`, `₹${amount} बकाया ₹${balance} से ज़्यादा है।`,
      { amount, balance_due: balance });
  }
}

function currentTotals(tx: Tx, order: Order) {
  return computeTotals(order, tx.findBy('order_items', 'order_id', order.id), tx.findBy('payments', 'order_id', order.id), tx.all('settings')[0]);
}

function getOrder(tx: Tx, id: string): Order {
  const order = tx.get('orders', id);
  if (!order) throw new NotFoundError('orders', id);
  return order;
}

/**
 * Ends a session (PAID or CLOSED_EXCEPTION): its KOTs leave the kitchen board
 * 10 min later (REQ-054). A PAID takeaway is the exception: it may be paid
 * before cooking (REQ-041), so its KOTs stay until handover (orders/takeaway.ts).
 */
function closeSession(tx: Tx, before: Order, after: Order, userId: string): void {
  if (!(after.order_type === 'TAKEAWAY' && after.status === 'PAID')) hideOrderKots(tx, after.id, userId);
  emitOrderChange(tx, before, after);
}

/**
 * recordPayment (REQ-063..066): one SUCCESS payment part, never more than the
 * balance due at this moment. At zero balance the order becomes PAID, its table
 * Available and its KOTs get hide_after. Call it through
 * `queue.runIdempotent('payments', 'idempotency_key', key, ...)` (REQ-065).
 */
export function recordPayment(tx: Tx, orderId: string, input: PaymentInput, key: string, user: SessionUser): Payment {
  const order = getOrder(tx, orderId);
  if (!isOpenOrder(order)) throw new OrderNotOpenError(order);
  const amount = toPaise(input.amount);
  if (amount <= 0) throw new ApiError(400, 'VALIDATION_FAILED', 'Enter an amount above zero.', 'शून्य से ज़्यादा रकम डालें।', { field: 'amount' });
  // Recheck against the current lines and payments, not the stored balance.
  const balanceDue = currentTotals(tx, order).balance_due;
  const balance = toPaise(balanceDue);
  if (amount > balance) throw new OverpaymentError(fromPaise(amount), balanceDue);
  const cash = input.method === 'CASH';
  if (cash && input.tendered_amount != null && toPaise(input.tendered_amount) < amount) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'The cash given is less than the amount.', 'दिया गया कैश रकम से कम है।', { field: 'tendered_amount' });
  }

  const payment = tx.create('payments', {
    id: idFormats.seq('PAY', tx.nextCounter(counterKeys.seq(PAYMENT_COUNTER))),
    order_id: orderId, business_date: tx.businessDate(), method: input.method, amount: fromPaise(amount),
    tendered_amount: cash && input.tendered_amount != null ? fromPaise(toPaise(input.tendered_amount)) : null,
    upi_ref: input.method === 'UPI' ? input.upi_ref : null,
    status: 'SUCCESS', void_reason: null, voided_by: null, idempotency_key: key,
  }, user.id);
  const paidOff = amount === balance;
  const updated = recomputeOrder(tx, order, paidOff ? { status: 'PAID' } : {}, user.id);
  writeAudit(tx, {
    action: 'PAYMENT', entity_type: 'payments', entity_id: payment.id, user_id: user.id, device_id: user.device_id,
    before_json: { order_id: orderId, status: order.status, balance_due: balanceDue },
    after_json: { method: payment.method, amount: payment.amount, status: updated.status, balance_due: updated.balance_due },
  });
  tx.emit('payment.recorded', {
    payment_id: payment.id, order_id: orderId, method: payment.method, amount: payment.amount,
    order_status: updated.status, balance_due: updated.balance_due,
  });
  if (paidOff) closeSession(tx, order, updated, user.id);
  else emitOrderChange(tx, order, updated);
  return payment;
}

/** Change to hand back for a cash payment (REQ-063): tendered − amount, else null. */
export function changeDue(p: Pick<Payment, 'amount' | 'tendered_amount'>): string | null {
  return p.tendered_amount == null ? null : fromPaise(toPaise(p.tendered_amount) - toPaise(p.amount));
}

// ---------------------------------------------------------------- void

/**
 * voidPayment (REQ-068): the row is kept, marked VOIDED with the reason and the
 * Admin's id. A non-Admin consumes an approval token inside the queue. The
 * order's balance grows by the voided amount; a PAID order reopens (BILLED when
 * its bill was printed, else OPEN), unless its table already holds a new session.
 */
export function voidPayment(tx: Tx, id: string, version: number, reason: string, approvalToken: string | null, user: SessionUser, consume: ConsumeApproval): Payment {
  const payment = tx.expectVersion('payments', id, version);
  if (payment.status !== 'SUCCESS') {
    throw new ApiError(409, 'ALREADY_VOIDED', 'This payment is already voided.', 'यह भुगतान पहले ही रद्द है।', { payment_id: id });
  }
  const approver = user.role === 'ADMIN' ? null : consume(approvalToken, user.id);
  const order = getOrder(tx, payment.order_id);
  let status = order.status;
  if (order.status === 'PAID') {
    if (order.table_id) {
      const busy = activeOrderForTable(tx, order.table_id);
      if (busy) throw new TableBusyError(busy);
    }
    status = order.bill_no ? 'BILLED' : 'OPEN';
  }
  const voided = tx.update('payments', payment, { status: 'VOIDED', void_reason: reason.slice(0, 80), voided_by: approver ?? user.id }, user.id);
  const updated = recomputeOrder(tx, order, { status }, user.id);
  const exception = writeException(tx, {
    order_id: order.id, exception_type: 'PAYMENT_VOID', reason_code: 'PAYMENT_VOID', reason_text: reason,
    amount: payment.amount, requested_by: user.id, approved_by: approver,
  });
  writeAudit(tx, {
    action: 'VOID', entity_type: 'payments', entity_id: id, user_id: user.id, approver_id: approver, device_id: user.device_id,
    before_json: { status: payment.status, order_status: order.status, balance_due: order.balance_due },
    after_json: { status: voided.status, void_reason: voided.void_reason, order_status: updated.status, balance_due: updated.balance_due, exception_id: exception.id },
  });
  emitOrderChange(tx, order, updated);
  return voided;
}

// ---------------------------------------------------------------- close with exception

export interface CloseInput {
  reason_code: CloseReasonCode;
  reason_text: string | null;
  approvalToken: string | null;
}

/**
 * closeWithException (REQ-069): an OPEN/BILLED order with a balance becomes
 * CLOSED_EXCEPTION; a CLOSE_WITH_BALANCE exception records the balance written
 * off and the approving Admin. The table turns Available.
 */
export function closeWithException(tx: Tx, id: string, version: number, input: CloseInput, user: SessionUser, consume: ConsumeApproval): Order {
  const order = tx.expectVersion('orders', id, version);
  if (!isOpenOrder(order)) throw new OrderNotOpenError(order);
  const approver = user.role === 'ADMIN' ? null : consume(input.approvalToken, user.id);
  // The balance stays on the order (it was never paid); the exception records it as written off.
  const updated = recomputeOrder(tx, order, { status: 'CLOSED_EXCEPTION' }, user.id);
  const exception = writeException(tx, {
    order_id: id, exception_type: 'CLOSE_WITH_BALANCE', reason_code: input.reason_code, reason_text: input.reason_text,
    amount: updated.balance_due, requested_by: user.id, approved_by: approver,
  });
  writeAudit(tx, {
    action: 'CLOSE_EXCEPTION', entity_type: 'orders', entity_id: id, user_id: user.id, approver_id: approver, device_id: user.device_id,
    before_json: { status: order.status, balance_due: order.balance_due },
    after_json: { status: updated.status, reason_code: input.reason_code, amount: updated.balance_due, exception_id: exception.id },
  });
  closeSession(tx, order, updated, user.id);
  return updated;
}

// ---------------------------------------------------------------- receipt print log

export const RECEIPT_ACTIONS = { first: 'RECEIPT_PRINT', again: 'REPRINT' };

/**
 * recordReceiptPrint (REQ-067): logs the print before the browser prints. The
 * first print of an order is RECEIPT_PRINT, every later one REPRINT. Nothing
 * else changes, so a failed print can never undo a payment.
 */
export function logReceiptPrint(tx: Tx, orderId: string, user: SessionUser): { action: string; print_count: number } {
  const order = getOrder(tx, orderId);
  const earlier = tx.findBy('audit_log', 'entity_id', orderId)
    .filter((a) => a.entity_type === 'orders' && (a.action === RECEIPT_ACTIONS.first || a.action === RECEIPT_ACTIONS.again)).length;
  const action = earlier === 0 ? RECEIPT_ACTIONS.first : RECEIPT_ACTIONS.again;
  writeAudit(tx, {
    action, entity_type: 'orders', entity_id: orderId, user_id: user.id, device_id: user.device_id,
    after_json: { status: order.status, bill_no: order.bill_no, grand_total: order.grand_total, paid_amount: order.paid_amount, print_count: earlier + 1 },
  });
  return { action, print_count: earlier + 1 };
}
