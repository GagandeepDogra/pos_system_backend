// KOT lifecycle (REQ-049, REQ-045, REQ-060, REQ-052, REQ-054, REQ-055, REQ-083,
// REQ-095, REQ-021). Each change is a synchronous write-queue change over a Tx.
// KOT state never touches payment or order status, except that cancelling the
// last ACTIVE line of an unpaid order cancels the order (which frees its table).
import { Kot, KotStatus, Order, OrderItem } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { SessionUser } from '../auth/decorators';
import { buildOrderLine } from '../billing/order-line';
import { computeTotals } from '../billing/totals';
import { ApiError, NotFoundError } from '../common/errors';
import { nowIst } from '../common/time';
import { isAvailableToday, resetTimeOf } from '../menu/availability';
import { isOpenOrder } from '../orders/dine-in';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';
import { WorkbookStore } from '../storage/workbook-store';

/** Minutes a SERVED (or paid / cancelled) KOT stays on the board (REQ-054). */
export const HIDE_AFTER_MINUTES = 10;
export const DEFAULT_LATE_KOT_MINUTES = 15;
export const ORDER_ITEM_COUNTER = 'ORDER_ITEM';
export const EXCEPTION_COUNTER = 'EXCEPTION';

/** The one legal next status for each KOT status (REQ-052). NEW → CANCELLED happens only through item cancel. */
export const KOT_NEXT: Partial<Record<KotStatus, KotStatus>> = { NEW: 'PREPARING', PREPARING: 'READY', READY: 'SERVED' };

/** An ISO +05:30 timestamp `minutes` after `at`. */
export function addMinutes(at: string, minutes: number): string {
  return nowIst(new Date(Date.parse(at) + minutes * 60_000));
}

class OrderNotOpenError extends ApiError {
  constructor(order: Order) {
    super(409, 'ORDER_NOT_OPEN', 'This order is already closed.', 'यह ऑर्डर पहले ही बंद है।', { order_id: order.id, status: order.status });
  }
}

function writeException(tx: Tx, fields: { order_id: string; exception_type: 'BILL_REOPEN' | 'CANCEL_AFTER_START'; reason_code: string; reason_text: string | null; amount: string | null; requested_by: string; approved_by: string | null }) {
  return tx.insert('exceptions', {
    id: idFormats.seq('EXC', tx.nextCounter(counterKeys.seq(EXCEPTION_COUNTER))), ...fields,
    reason_text: fields.reason_text?.slice(0, 80) ?? null, created_at: tx.now,
  });
}

function recomputeOrder(tx: Tx, order: Order, patch: Partial<Order>, userId: string): Order {
  const settings = tx.all('settings')[0];
  const totals = computeTotals(order, tx.findBy('order_items', 'order_id', order.id), tx.findBy('payments', 'order_id', order.id), settings);
  return tx.update('orders', order, { ...totals, ...patch }, userId);
}

const tableStatusOf = (o: Order) => (o.status === 'OPEN' ? 'OCCUPIED' : o.status === 'BILLED' ? 'READY_TO_CLOSE' : 'AVAILABLE');

// ---------------------------------------------------------------- send to kitchen

export interface CartLineInput {
  variant_id: string;
  quantity: number;
  note?: string | null;
}

export interface RejectedLine {
  /** Position of the line in the request. */
  index: number;
  variant_id: string;
  item_id: string | null;
  name_en: string | null;
  name_hi: string | null;
  reason: 'NOT_AVAILABLE_TODAY' | 'INACTIVE' | 'NOT_FOUND';
}

export class ItemUnavailableError extends ApiError {
  constructor(lines: RejectedLine[]) {
    super(422, 'ITEM_UNAVAILABLE', 'Some items are not available (Khatam). Remove them and send again.',
      'कुछ आइटम खत्म हैं। उन्हें हटाकर फिर भेजें।', { lines });
  }
}

/**
 * sendToKitchen: one KOT holding exactly the lines in the request (the cart
 * lines not yet sent, REQ-049). Prices and names are copied from the menu here
 * (REQ-114). Any unavailable line rejects the send with only those lines in
 * details (REQ-045). A BILLED order reopens to OPEN with a BILL_REOPEN
 * exception (REQ-060).
 */
export function sendToKitchen(tx: Tx, orderId: string, lines: CartLineInput[], key: string, user: SessionUser): Kot {
  const order = tx.get('orders', orderId);
  if (!order) throw new NotFoundError('orders', orderId);
  if (!isOpenOrder(order)) throw new OrderNotOpenError(order);

  const today = tx.businessDate();
  const resetTime = resetTimeOf(tx);
  const rejected: RejectedLine[] = [];
  const priced = lines.map((line, index) => {
    const variant = tx.get('variants', line.variant_id);
    const item = variant ? tx.get('items', variant.item_id) : undefined;
    const reject = (reason: RejectedLine['reason']) =>
      rejected.push({ index, variant_id: line.variant_id, item_id: item?.id ?? null, name_en: item?.name_en ?? null, name_hi: item?.name_hi ?? null, reason });
    if (!variant || !item) reject('NOT_FOUND');
    else if (!variant.is_active || !item.is_active || tx.get('categories', item.category_id)?.is_active === false) reject('INACTIVE');
    else if (!isAvailableToday(item, today, resetTime)) reject('NOT_AVAILABLE_TODAY');
    return { line, variant, item };
  });
  if (rejected.length) throw new ItemUnavailableError(rejected);

  const n = tx.nextCounter(counterKeys.kot(today));
  const kot = tx.create('kots', {
    id: idFormats.kot(today, n), kot_number: n, business_date: today, order_id: order.id, status: 'NEW',
    idempotency_key: key, sent_at: tx.now, served_at: null, hide_after: null,
  }, user.id);
  const created: OrderItem[] = priced.map(({ line, variant, item }) => tx.insert('order_items', buildOrderLine(item!, variant!, {
    id: idFormats.seq('OI', tx.nextCounter(counterKeys.seq(ORDER_ITEM_COUNTER))), order_id: order.id, kot_id: kot.id,
    quantity: line.quantity, note: line.note?.trim() ? line.note.trim() : null, user_id: user.id, now: tx.now,
  })));

  const reopen = order.status === 'BILLED';
  const updated = recomputeOrder(tx, order, reopen ? { status: 'OPEN' } : {}, user.id);
  if (reopen) {
    writeException(tx, {
      order_id: order.id, exception_type: 'BILL_REOPEN', reason_code: 'NEW_ITEMS', reason_text: `KOT ${n} sent after bill ${order.bill_no ?? ''}`.trim(),
      amount: null, requested_by: user.id, approved_by: null,
    });
    writeAudit(tx, {
      action: 'BILL_REOPEN', entity_type: 'orders', entity_id: order.id, user_id: user.id, device_id: user.device_id,
      before_json: { status: 'BILLED', grand_total: order.grand_total }, after_json: { status: 'OPEN', grand_total: updated.grand_total, kot_id: kot.id },
    });
  }
  writeAudit(tx, {
    action: 'CREATE', entity_type: 'kots', entity_id: kot.id, user_id: user.id, device_id: user.device_id,
    after_json: { order_id: order.id, kot_number: n, lines: created.map((l) => ({ id: l.id, variant_id: l.variant_id, quantity: l.quantity })) },
  });

  tx.emit('kot.created', { kot: kitchenCard(tx, kot, Date.parse(tx.now)) });
  if (order.table_id) tx.emit('table.status_changed', { table_id: order.table_id, status: tableStatusOf(updated), order_id: order.id });
  tx.emit('order.updated', { order_id: order.id, status: updated.status, row_version: updated.row_version });
  tx.emit('dashboard.updated', {});
  return kot;
}

// ---------------------------------------------------------------- status changes

export class IllegalTransitionError extends ApiError {
  constructor(kot: Kot, to: string) {
    const next = KOT_NEXT[kot.status];
    super(422, 'ILLEGAL_TRANSITION', `A ${kot.status} KOT cannot move to ${to}.`, `${kot.status} KOT को ${to} नहीं किया जा सकता।`,
      { kot_id: kot.id, from: kot.status, to, allowed: next ? [next] : [] });
  }
}

/** updateKotStatus: one legal step; SERVED sets served_at and hide_after = now + 10 min. Never touches the order (REQ-095). */
export function advanceKot(tx: Tx, id: string, version: number, to: KotStatus, user: SessionUser): Kot {
  const kot = tx.expectVersion('kots', id, version);
  if (KOT_NEXT[kot.status] !== to) throw new IllegalTransitionError(kot, to);
  const patch: Partial<Kot> = { status: to };
  if (to === 'SERVED') Object.assign(patch, { served_at: tx.now, hide_after: addMinutes(tx.now, HIDE_AFTER_MINUTES) });
  const updated = tx.update('kots', kot, patch, user.id);
  writeAudit(tx, {
    action: 'STATUS_CHANGE', entity_type: 'kots', entity_id: id, user_id: user.id, device_id: user.device_id,
    before_json: { status: kot.status }, after_json: { status: to, served_at: updated.served_at, hide_after: updated.hide_after },
  });
  const order = tx.get('orders', kot.order_id);
  tx.emit('kot.status_changed', {
    kot_id: id, kot_number: kot.kot_number, order_id: kot.order_id, status: to, row_version: updated.row_version,
    hide_after: updated.hide_after, table_id: order?.table_id ?? null, table_label: order?.table_label_snapshot ?? null, token: order?.token ?? null,
  });
  return updated;
}

/**
 * For payments (WI-010): when an order is paid, every KOT of it still without
 * hide_after leaves the board 10 minutes later (REQ-054).
 */
export function hideOrderKots(tx: Tx, orderId: string, userId: string): Kot[] {
  const hideAfter = addMinutes(tx.now, HIDE_AFTER_MINUTES);
  return tx.findBy('kots', 'order_id', orderId).filter((k) => !k.hide_after).map((k) => tx.update('kots', k, { hide_after: hideAfter }, userId));
}

// ---------------------------------------------------------------- item cancel

export interface CancelLineInput {
  reason: string;
  approvalToken: string | null;
}

/**
 * cancelOrderItem (REQ-083): the line is kept as CANCELLED. On a KOT past NEW a
 * non-Admin needs an approval token (consumed here, inside the queue) and a
 * CANCEL_AFTER_START exception records both user ids. A KOT whose lines are all
 * cancelled becomes CANCELLED; an unpaid order with no ACTIVE line left becomes
 * CANCELLED (its table turns Available).
 */
export function cancelLine(
  tx: Tx, id: string, version: number, input: CancelLineInput, user: SessionUser,
  consumeApproval: (token: string | null, userId: string) => string,
): Order {
  const line = tx.expectVersion('order_items', id, version);
  if (line.status === 'CANCELLED') {
    throw new ApiError(409, 'ALREADY_CANCELLED', 'This item is already cancelled.', 'यह आइटम पहले ही रद्द है।', { order_item_id: id });
  }
  const order = tx.get('orders', line.order_id);
  if (!order) throw new NotFoundError('orders', line.order_id);
  if (!isOpenOrder(order)) throw new OrderNotOpenError(order);
  const kot = tx.get('kots', line.kot_id);
  if (!kot) throw new NotFoundError('kots', line.kot_id);

  const started = kot.status !== 'NEW';
  const approver = started ? (user.role === 'ADMIN' ? user.id : consumeApproval(input.approvalToken, user.id)) : null;
  const reason = input.reason.trim().slice(0, 80);
  tx.update('order_items', line, { status: 'CANCELLED', cancel_reason: reason }, user.id);

  const kotLines = tx.findBy('order_items', 'kot_id', kot.id);
  const kotCancelled = kot.status !== 'CANCELLED' && kotLines.every((l) => l.status === 'CANCELLED');
  const kotAfter = kotCancelled ? tx.update('kots', kot, { status: 'CANCELLED', hide_after: kot.hide_after ?? addMinutes(tx.now, HIDE_AFTER_MINUTES) }, user.id) : kot;

  const active = tx.findBy('order_items', 'order_id', order.id).some((l) => l.status === 'ACTIVE');
  const paid = tx.findBy('payments', 'order_id', order.id).some((p) => p.status === 'SUCCESS');
  const orderCancelled = !active && !paid;
  const updated = recomputeOrder(tx, order, orderCancelled ? { status: 'CANCELLED' } : {}, user.id);

  if (started) {
    writeException(tx, {
      order_id: order.id, exception_type: 'CANCEL_AFTER_START', reason_code: 'ITEM_CANCEL', reason_text: reason,
      amount: line.line_total, requested_by: user.id, approved_by: approver,
    });
  }
  writeAudit(tx, {
    action: 'CANCEL', entity_type: 'order_items', entity_id: id, user_id: user.id, approver_id: approver, device_id: user.device_id,
    before_json: { status: 'ACTIVE', kot_status: kot.status, order_status: order.status },
    after_json: { status: 'CANCELLED', cancel_reason: reason, kot_status: kotAfter.status, order_status: updated.status, grand_total: updated.grand_total },
  });

  tx.emit('kot.status_changed', {
    kot_id: kot.id, kot_number: kot.kot_number, order_id: order.id, status: kotAfter.status, row_version: kotAfter.row_version,
    hide_after: kotAfter.hide_after, cancelled_line_id: id,
  });
  tx.emit('order.updated', { order_id: order.id, status: updated.status, row_version: updated.row_version });
  if (orderCancelled && order.table_id) tx.emit('table.status_changed', { table_id: order.table_id, status: 'AVAILABLE', order_id: null });
  tx.emit('dashboard.updated', {});
  return updated;
}

// ---------------------------------------------------------------- kitchen board

/** One line on a kitchen card: names, variant, qty, note, cancelled flag. No money (REQ-021). */
export interface KitchenLine {
  id: string;
  item_name: string;
  item_name_hi: string;
  variant_name: string;
  food_type: string;
  quantity: number;
  note: string | null;
  cancelled: boolean;
}

/** The money-free kitchen projection of a KOT (REQ-051, REQ-055, REQ-021). */
export interface KitchenKot {
  id: string;
  kot_number: number;
  business_date: string;
  order_id: string;
  order_type: string | null;
  table_label: string | null;
  token: string | null;
  status: KotStatus;
  sent_at: string;
  served_at: string | null;
  hide_after: string | null;
  row_version: number;
  minutes_waiting: number;
  late: boolean;
  lines: KitchenLine[];
}

type Reader = Pick<WorkbookStore, 'get' | 'findBy' | 'all'>;

const lateLimit = (store: Reader) => store.all('settings')[0]?.late_kot_minutes ?? DEFAULT_LATE_KOT_MINUTES;

/** Builds the card field by field, so no money column can leak in. */
export function kitchenCard(store: Reader, kot: Kot, nowMs: number, lateMinutes = lateLimit(store)): KitchenKot {
  const order = store.get('orders', kot.order_id);
  const minutes = Math.max(0, Math.floor((nowMs - Date.parse(kot.sent_at)) / 60_000));
  return {
    id: kot.id, kot_number: kot.kot_number, business_date: kot.business_date, order_id: kot.order_id,
    order_type: order?.order_type ?? null, table_label: order?.table_label_snapshot ?? null, token: order?.token ?? null,
    status: kot.status, sent_at: kot.sent_at, served_at: kot.served_at, hide_after: kot.hide_after, row_version: kot.row_version,
    minutes_waiting: minutes,
    // Waiting longer than the limit, while the kitchen still owes the food.
    late: (kot.status === 'NEW' || kot.status === 'PREPARING') && minutes > lateMinutes,
    lines: store.findBy('order_items', 'kot_id', kot.id).map((l) => ({
      id: l.id, item_name: l.item_name_snapshot, item_name_hi: l.item_name_hi_snapshot, variant_name: l.variant_name_snapshot,
      food_type: l.food_type_snapshot, quantity: l.quantity, note: l.note, cancelled: l.status === 'CANCELLED',
    })),
  };
}

/** listKitchenKots: KOTs not yet past hide_after, oldest first (REQ-051, REQ-054). */
export function kitchenBoard(store: Reader, nowMs: number): KitchenKot[] {
  const late = lateLimit(store);
  return store.all('kots')
    .filter((k) => !k.hide_after || Date.parse(k.hide_after) > nowMs)
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || a.business_date.localeCompare(b.business_date) || a.kot_number - b.kot_number)
    .map((k) => kitchenCard(store, k, nowMs, late));
}
