// Takeaway tokens, the active takeaway list and handover (REQ-038..041).
// createTakeaway and handOver are synchronous write-queue changes; the list is
// a read over the in-memory store.
import { KOT_STATUSES, Kot, KotStatus, ORDER_STATUSES, Order } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { SessionUser } from '../auth/decorators';
import { ApiError } from '../common/errors';
import { HIDE_AFTER_MINUTES, addMinutes } from '../kitchen/kots';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';
import { blankOrder } from './dine-in';

export interface CreateTakeawayInput {
  customer_name?: string | null;
  customer_phone?: string | null;
}

/** Blank or whitespace-only optional details are stored as null (REQ-039). */
const optional = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
};

export class TokenExistsError extends ApiError {
  constructor(token: string, businessDate: string, order: Order) {
    super(409, 'TOKEN_EXISTS', `Token ${token} already exists for ${businessDate}.`, `टोकन ${token} ${businessDate} के लिए पहले से है।`,
      { token, business_date: businessDate, order_id: order.id });
  }
}

/**
 * createTakeaway (REQ-038, REQ-039): the next token from the
 * TOKEN:<business_date> counter, so it restarts at T-001 after the
 * token_reset_time cut-off. The queue serialises creates, so two phones at the
 * same second get consecutive tokens; a token already used on that business
 * date (e.g. a hand-edited counter) is refused with 409 TOKEN_EXISTS.
 */
export function createTakeaway(tx: Tx, input: CreateTakeawayInput, key: string, user: SessionUser): Order {
  const bd = tx.businessDate();
  const token = idFormats.token(tx.nextCounter(counterKeys.token(bd)));
  const clash = tx.findBy('orders', 'business_date', bd).find((o) => o.order_type === 'TAKEAWAY' && o.token === token);
  if (clash) throw new TokenExistsError(token, bd, clash);
  const order = tx.create('orders', {
    ...blankOrder(), id: idFormats.order(bd, tx.nextCounter(counterKeys.order())), order_type: 'TAKEAWAY',
    business_date: bd, token, customer_name: optional(input.customer_name), customer_phone: optional(input.customer_phone),
    client_request_id: key,
  }, user.id);
  writeAudit(tx, {
    action: 'CREATE', entity_type: 'orders', entity_id: order.id, user_id: user.id, device_id: user.device_id,
    after_json: { order_type: 'TAKEAWAY', token, business_date: bd, status: order.status },
  });
  tx.emit('order.updated', { order_id: order.id, order_type: 'TAKEAWAY', token, status: order.status });
  tx.emit('dashboard.updated', {});
  return order;
}

/** Kitchen progress of a takeaway: the least advanced live KOT, or NONE before the first send. */
export type TakeawayKitchenStatus = Exclude<KotStatus, 'CANCELLED'> | 'NONE';
/** Kitchen progress order, from the shared lifecycle (NEW → PREPARING → READY → SERVED). */
const KITCHEN_ORDER = KOT_STATUSES.filter((s): s is Exclude<KotStatus, 'CANCELLED'> => s !== 'CANCELLED');

export function kitchenStatus(kots: Kot[]): TakeawayKitchenStatus {
  const live = kots.filter((k) => k.status !== 'CANCELLED');
  if (!live.length) return 'NONE';
  return KITCHEN_ORDER[Math.min(...live.map((k) => KITCHEN_ORDER.indexOf(k.status as Exclude<KotStatus, 'CANCELLED'>)))];
}

const isFoodReady = (s: TakeawayKitchenStatus) => s === 'READY' || s === 'SERVED';

export interface ActiveTakeaway extends Order {
  /** Sum of quantities on ACTIVE lines. */
  item_count: number;
  kitchen_status: TakeawayKitchenStatus;
  /** True only when the order is PAID; a Ready but unpaid token shows Unpaid (REQ-041). */
  paid: boolean;
  /** Food Ready and PAID: the HANDED OVER button may be tapped. */
  ready_to_hand_over: boolean;
}

type Reader = Pick<Tx, 'findBy'>;

/** One row of the active list. */
export function takeawayCard(store: Reader, order: Order): ActiveTakeaway {
  const items = store.findBy('order_items', 'order_id', order.id).filter((l) => l.status === 'ACTIVE');
  const status = kitchenStatus(store.findBy('kots', 'order_id', order.id));
  const paid = order.status === 'PAID';
  return {
    ...order, item_count: items.reduce((n, l) => n + l.quantity, 0), kitchen_status: status, paid,
    ready_to_hand_over: paid && isFoodReady(status),
  };
}

/** Order statuses of a takeaway still waiting for its customer (not cancelled or written off). */
const ACTIVE_STATUSES = ORDER_STATUSES.filter((s) => s === 'OPEN' || s === 'BILLED' || s === 'PAID');
const isActiveTakeaway = (o: Order) => o.order_type === 'TAKEAWAY' && !o.handed_over_at;

/**
 * listActiveTakeaways (REQ-040, REQ-041): takeaways with no handed_over_at,
 * oldest first, whether paid before or after cooking.
 */
export function activeTakeaways(store: Reader): ActiveTakeaway[] {
  return ACTIVE_STATUSES
    .flatMap((s) => store.findBy('orders', 'status', s))
    .filter(isActiveTakeaway)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((o) => takeawayCard(store, o));
}

export class NotReadyForHandoverError extends ApiError {
  constructor(card: ActiveTakeaway) {
    const reasons = [...(isFoodReady(card.kitchen_status) ? [] : ['NOT_READY']), ...(card.paid ? [] : ['NOT_PAID'])];
    super(422, 'NOT_READY_FOR_HANDOVER', 'Hand over only when the food is Ready and the bill is Paid.',
      'खाना तैयार और भुगतान पूरा होने पर ही सौंपें।',
      { order_id: card.id, token: card.token, kitchen_status: card.kitchen_status, status: card.status, balance_due: card.balance_due, reasons });
  }
}

/**
 * handOverTakeaway (REQ-040): only a takeaway whose food is Ready and whose
 * order is PAID. Sets handed_over_at (so it leaves the active list); its READY
 * KOTs become SERVED and every KOT leaves the kitchen board 10 min later.
 */
export function handOver(tx: Tx, id: string, version: number, user: SessionUser): Order {
  const order = tx.expectVersion('orders', id, version);
  if (order.order_type !== 'TAKEAWAY') {
    throw new ApiError(422, 'NOT_A_TAKEAWAY', 'Only a takeaway can be handed over.', 'केवल टेकअवे ही सौंपा जा सकता है।', { order_id: id });
  }
  if (order.handed_over_at) {
    throw new ApiError(422, 'ALREADY_HANDED_OVER', 'This token was already handed over.', 'यह टोकन पहले ही सौंपा जा चुका है।',
      { order_id: id, handed_over_at: order.handed_over_at });
  }
  const card = takeawayCard(tx, order);
  if (!card.ready_to_hand_over) throw new NotReadyForHandoverError(card);

  const hideAt = addMinutes(tx.now, HIDE_AFTER_MINUTES);
  for (const kot of tx.findBy('kots', 'order_id', id)) {
    const patch: Partial<Kot> = {};
    if (kot.status === 'READY') Object.assign(patch, { status: 'SERVED', served_at: tx.now });
    if (!kot.hide_after) patch.hide_after = hideAt;
    if (!Object.keys(patch).length) continue;
    const updated = tx.update('kots', kot, patch, user.id);
    if (updated.status !== kot.status) {
      tx.emit('kot.status_changed', { kot_id: kot.id, kot_number: kot.kot_number, order_id: id, status: updated.status, row_version: updated.row_version, hide_after: updated.hide_after });
    }
  }
  const after = tx.update('orders', order, { handed_over_at: tx.now }, user.id);
  writeAudit(tx, {
    action: 'HANDOVER', entity_type: 'orders', entity_id: id, user_id: user.id, device_id: user.device_id,
    before_json: { handed_over_at: null, kitchen_status: card.kitchen_status }, after_json: { handed_over_at: after.handed_over_at, token: after.token },
  });
  tx.emit('order.updated', { order_id: id, token: after.token, handed_over_at: after.handed_over_at, row_version: after.row_version });
  tx.emit('dashboard.updated', {});
  return after;
}
