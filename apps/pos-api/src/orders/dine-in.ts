// Dine-in session changes (REQ-034, REQ-037). Each function is a synchronous
// write-queue change over a Tx: it re-checks the rules inside the queue, so two
// phones racing for one table cannot both win.
import { DiningTable, Kot, Order, OrderItem, Payment } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { SessionUser } from '../auth/decorators';
import { computeTotals } from '../billing/totals';
import { ApiError, NotFoundError } from '../common/errors';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';
import { activeOrderForTable } from '../tables/table-status';

type NewOrderFields = Omit<Order, 'id' | 'order_type' | 'business_date' | 'client_request_id' | 'created_at' | 'created_by' | 'updated_at' | 'updated_by' | 'row_version'>;

/** An order with nothing on it yet. */
export function blankOrder(): NewOrderFields {
  return {
    table_id: null, table_label_snapshot: null, token: null, customer_name: null, customer_phone: null,
    guest_count: null, status: 'OPEN', bill_no: null, subtotal: '0.00', discount_amount: '0.00',
    discount_reason: null, tax_amount: '0.00', round_off: '0.00', grand_total: '0.00', paid_amount: '0.00',
    balance_due: '0.00', merged_into_order_id: null, handed_over_at: null,
  };
}

export const isOpenOrder = (o: Order) => o.status === 'OPEN' || o.status === 'BILLED';

export class TableBusyError extends ApiError {
  constructor(order: Order) {
    super(409, 'TABLE_BUSY', 'This table already has an open order.', 'इस टेबल पर पहले से ऑर्डर खुला है।', { order });
  }
}

function activeTable(tx: Tx, tableId: string): DiningTable {
  const table = tx.get('tables', tableId);
  if (!table) throw new NotFoundError('tables', tableId);
  if (!table.is_active) {
    throw new ApiError(409, 'TABLE_INACTIVE', 'This table is switched off.', 'यह टेबल बंद है।', { table_id: tableId });
  }
  return table;
}

function openDineIn(tx: Tx, id: string): Order {
  const order = tx.get('orders', id);
  if (!order) throw new NotFoundError('orders', id);
  if (order.order_type !== 'DINE_IN' || !isOpenOrder(order)) {
    throw new ApiError(409, 'ORDER_NOT_OPEN', 'This table session is already closed.', 'यह टेबल सेशन पहले ही बंद है।', { order_id: id, status: order.status });
  }
  return order;
}

export interface OpenSessionInput {
  table_id: string;
  guest_count?: number | null;
  customer_name?: string | null;
  customer_phone?: string | null;
}

/** openTableSession: rechecks the table is free, allocates the id and business_date. */
export function openSession(tx: Tx, input: OpenSessionInput, key: string, user: SessionUser): Order {
  const table = activeTable(tx, input.table_id);
  const busy = activeOrderForTable(tx, table.id);
  if (busy) throw new TableBusyError(busy);
  const bd = tx.businessDate();
  const order = tx.create('orders', {
    ...blankOrder(), id: idFormats.order(bd, tx.nextCounter(counterKeys.order())), order_type: 'DINE_IN',
    business_date: bd, table_id: table.id, table_label_snapshot: table.table_number,
    guest_count: input.guest_count ?? null, customer_name: input.customer_name ?? null,
    customer_phone: input.customer_phone ?? null, client_request_id: key,
  }, user.id);
  writeAudit(tx, {
    action: 'CREATE', entity_type: 'orders', entity_id: order.id, user_id: user.id, device_id: user.device_id,
    after_json: { table_id: table.id, status: order.status, guest_count: order.guest_count },
  });
  tx.emit('table.status_changed', { table_id: table.id, status: 'OCCUPIED', order_id: order.id });
  tx.emit('dashboard.updated', {});
  return order;
}

/** moveOrder: the session goes to another free, active table; MOVE audit row (REQ-037). */
export function moveSession(tx: Tx, id: string, version: number, targetTableId: string, user: SessionUser): Order {
  tx.expectVersion('orders', id, version);
  const order = openDineIn(tx, id);
  if (order.table_id === targetTableId) {
    throw new ApiError(409, 'SAME_TABLE', 'The order is already on this table.', 'ऑर्डर पहले से इसी टेबल पर है।', { table_id: targetTableId });
  }
  const target = activeTable(tx, targetTableId);
  const busy = activeOrderForTable(tx, target.id);
  if (busy) throw new TableBusyError(busy);
  const before = { table_id: order.table_id, table_label_snapshot: order.table_label_snapshot };
  const moved = tx.update('orders', order, { table_id: target.id, table_label_snapshot: target.table_number }, user.id);
  writeAudit(tx, {
    action: 'MOVE', entity_type: 'orders', entity_id: id, user_id: user.id, device_id: user.device_id,
    before_json: before, after_json: { table_id: target.id, table_label_snapshot: target.table_number },
  });
  if (order.table_id) tx.emit('table.status_changed', { table_id: order.table_id, status: 'AVAILABLE', order_id: null });
  tx.emit('table.status_changed', { table_id: target.id, status: moved.status === 'BILLED' ? 'READY_TO_CLOSE' : 'OCCUPIED', order_id: id });
  tx.emit('order.updated', { order_id: id, row_version: moved.row_version });
  return moved;
}

/**
 * mergeOrders: the source session's lines are re-pointed to the surviving
 * order, the source is closed as CANCELLED with merged_into_order_id set (so
 * its table turns Available), and the survivor's totals are recomputed. A
 * printed (BILLED) survivor reopens to OPEN with a BILL_REOPEN exception,
 * because its printed bill no longer matches. MERGE audit row (REQ-037).
 */
export function mergeSessions(tx: Tx, id: string, version: number, sourceId: string, user: SessionUser): Order {
  tx.expectVersion('orders', id, version);
  if (id === sourceId) {
    throw new ApiError(409, 'SAME_ORDER', 'An order cannot be merged into itself.', 'ऑर्डर को खुद में नहीं जोड़ा जा सकता।', { order_id: id });
  }
  const target = openDineIn(tx, id);
  const source = openDineIn(tx, sourceId);
  const sourcePayments = tx.findBy('payments', 'order_id', sourceId).filter((p) => p.status === 'SUCCESS');
  if (sourcePayments.length) {
    throw new ApiError(409, 'SOURCE_HAS_PAYMENTS', 'That table already has a payment. Settle or void it first.',
      'उस टेबल पर भुगतान हो चुका है। पहले उसे निपटाएँ।', { order_id: sourceId, payment_ids: sourcePayments.map((p) => p.id) });
  }
  const moved = tx.findBy('order_items', 'order_id', sourceId);
  for (const line of moved) tx.update('order_items', line, { order_id: id }, user.id);

  tx.update('orders', source, {
    status: 'CANCELLED', merged_into_order_id: id,
    ...computeTotals({ discount_amount: '0.00' }, [], []), discount_reason: null,
  }, user.id);

  const settings = tx.all('settings')[0];
  const totals = computeTotals(target, tx.findBy('order_items', 'order_id', id), tx.findBy('payments', 'order_id', id), settings);
  const reopen = target.status === 'BILLED';
  const merged = tx.update('orders', target, { ...totals, ...(reopen ? { status: 'OPEN' as const } : {}) }, user.id);
  if (reopen) {
    tx.insert('exceptions', {
      id: idFormats.seq('EXC', tx.nextCounter(counterKeys.seq('EXCEPTION'))), order_id: id, exception_type: 'BILL_REOPEN',
      reason_code: 'MERGE', reason_text: `Merged ${sourceId}`.slice(0, 80), amount: null, requested_by: user.id, approved_by: null, created_at: tx.now,
    });
  }
  writeAudit(tx, {
    action: 'MERGE', entity_type: 'orders', entity_id: id, user_id: user.id, device_id: user.device_id,
    before_json: { source_order_id: sourceId, source_table_id: source.table_id, grand_total: target.grand_total, status: target.status },
    after_json: { lines_moved: moved.map((l) => l.id), grand_total: merged.grand_total, status: merged.status },
  });
  if (source.table_id) tx.emit('table.status_changed', { table_id: source.table_id, status: 'AVAILABLE', order_id: null });
  if (target.table_id) tx.emit('table.status_changed', { table_id: target.table_id, status: 'OCCUPIED', order_id: id });
  tx.emit('order.updated', { order_id: sourceId, status: 'CANCELLED', merged_into_order_id: id });
  tx.emit('order.updated', { order_id: id, row_version: merged.row_version });
  tx.emit('dashboard.updated', {});
  return merged;
}

/** One KOT in the order view with the lines sent on it (REQ-035). */
export interface KotWithLines extends Kot {
  lines: OrderItem[];
}

export interface OrderView extends Order {
  kots: KotWithLines[];
  payments: Payment[];
}

type Reader = Pick<Tx, 'get' | 'findBy'>;

/**
 * getOrder's body: the order with its lines grouped under the KOT that sent
 * them (oldest KOT first), and its payments. Lines merged in from another
 * session stay under their original KOT numbers.
 */
export function orderView(store: Reader, order: Order): OrderView {
  const lines = store.findBy('order_items', 'order_id', order.id);
  const kots = new Map<string, Kot>();
  for (const k of store.findBy('kots', 'order_id', order.id)) kots.set(k.id, k);
  for (const l of lines) {
    if (!kots.has(l.kot_id)) {
      const k = store.get('kots', l.kot_id);
      if (k) kots.set(k.id, k);
    }
  }
  const grouped = [...kots.values()]
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at) || a.kot_number - b.kot_number)
    .map((k) => ({ ...k, lines: lines.filter((l) => l.kot_id === k.id) }))
    .filter((k) => k.lines.length > 0 || k.order_id === order.id);
  return { ...order, kots: grouped, payments: store.findBy('payments', 'order_id', order.id) };
}
