// The §7.6 sample session used as the billing fixture (REQ-100): on business
// date 2026-11-05, Table 5 has one dine-in session with two KOTs (a Sweet Lassi
// line cancelled, the row kept) settled by a split Cash + UPI payment, and
// takeaway T-003 (ORD-20261105-0008) has a Tandoori Roti line cancelled before
// cooking. Butter Chicken Half went from ₹200 to ₹220 at 11:00 (PriceChanges);
// both sample Butter Chicken lines were ordered after that, at ₹220.
import { Item, Kot, Order, OrderItem, Payment, Variant } from '@dhaba/shared';
import { WorkbookData } from '../../src/storage/workbook-codec';
import { NOW, item, roti, rotiVariant, sampleData, variant } from '../fixtures';

const at = (hhmm: string) => `2026-11-05T${hhmm}:00.000+05:30`;
const stamp = (t: string) => ({ created_at: t, created_by: 'USR-C', updated_at: t, updated_by: 'USR-C', row_version: 1 });

export const lassi: Item = { ...item, id: 'ITM-4', name_en: 'Sweet Lassi', name_hi: 'मीठी लस्सी', short_code: 'SL', food_type: 'VEG' };
export const lassiVariant: Variant = { ...variant, id: 'VAR-4', item_id: 'ITM-4', name: 'Glass', price: '60.00' };
export const dal: Item = { ...item, id: 'ITM-5', name_en: 'Dal Makhani', name_hi: 'दाल मखनी', short_code: 'DM', food_type: 'VEG' };
export const dalVariant: Variant = { ...variant, id: 'VAR-5', item_id: 'ITM-5', name: 'Full', price: '180.00' };

export const TABLE5_ORDER = 'ORD-20261105-0005';
export const TAKEAWAY_ORDER = 'ORD-20261105-0008';

function order(fields: Partial<Order> & Pick<Order, 'id' | 'order_type'>): Order {
  // Stored totals are deliberately stale (0): the tests prove they come only from the lines.
  return {
    business_date: '2026-11-05', table_id: null, table_label_snapshot: null, token: null, customer_name: null, customer_phone: null,
    guest_count: null, status: 'OPEN', bill_no: null, subtotal: '0.00', discount_amount: '0.00', discount_reason: null, tax_amount: '0.00',
    round_off: '0.00', grand_total: '0.00', paid_amount: '0.00', balance_due: '0.00', merged_into_order_id: null, handed_over_at: null,
    client_request_id: `req-${fields.id}`, ...stamp(at('12:00')), ...fields,
  };
}

function kot(id: string, n: number, orderId: string, status: Kot['status'], sent: string): Kot {
  return { id, kot_number: n, business_date: '2026-11-05', order_id: orderId, status, idempotency_key: `key-${id}`, sent_at: sent, served_at: null, hide_after: null, ...stamp(sent) };
}

function line(id: string, orderId: string, kotId: string, it: Item, v: Variant, quantity: number, unitPrice: string, cancel?: string): OrderItem {
  const paise = Math.round(Number(unitPrice) * 100) * quantity;
  return {
    id, order_id: orderId, kot_id: kotId, variant_id: v.id, item_name_snapshot: it.name_en, item_name_hi_snapshot: it.name_hi,
    variant_name_snapshot: v.name, food_type_snapshot: it.food_type, unit_price: unitPrice, quantity,
    line_total: `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, '0')}`, note: null,
    status: cancel ? 'CANCELLED' : 'ACTIVE', cancel_reason: cancel ?? null, ...stamp(at('12:10')),
  };
}

function payment(id: string, orderId: string, method: Payment['method'], amount: string): Payment {
  return {
    id, order_id: orderId, business_date: '2026-11-05', method, amount, tendered_amount: method === 'CASH' ? '500.00' : null,
    upi_ref: null, status: 'SUCCESS', void_reason: null, voided_by: null, idempotency_key: `key-${id}`, ...stamp(at('13:30')),
  };
}

/** sampleData() plus the §7.6 sample session, with counters past every sample id. */
export function sampleSessionData(): WorkbookData {
  const data = sampleData();
  data.items.push({ ...lassi }, { ...dal });
  data.variants.push({ ...lassiVariant }, { ...dalVariant });
  // Butter Chicken Half price change 200 → 220 before the sample lines were ordered.
  data.price_changes.push({ id: 'PRC-000001', variant_id: variant.id, old_price: '200.00', new_price: '220.00', reason: 'MARKET_RATE', changed_by: 'SYSTEM', created_at: at('11:00') });
  data.tables.push({ id: 'TBL-5', table_number: '5', area: 'Hall', seats: 4, is_active: true, ...stamp(NOW) });

  // Table 5: KOT 2 (BC Half, 4 roti, 2 lassi — lassi cancelled) and KOT 3 (dal, 2 roti). Split CASH 300 + UPI 220.
  data.orders.push(order({ id: TABLE5_ORDER, order_type: 'DINE_IN', table_id: 'TBL-5', table_label_snapshot: '5', guest_count: 3, status: 'PAID', bill_no: 'B-20261105-001' }));
  data.kots.push(kot('KOT-20261105-0002', 2, TABLE5_ORDER, 'SERVED', at('12:10')), kot('KOT-20261105-0003', 3, TABLE5_ORDER, 'SERVED', at('12:40')));
  data.order_items.push(
    line('OI-000101', TABLE5_ORDER, 'KOT-20261105-0002', item, variant, 1, '220.00'),
    line('OI-000102', TABLE5_ORDER, 'KOT-20261105-0002', roti, rotiVariant, 4, '20.00'),
    line('OI-000103', TABLE5_ORDER, 'KOT-20261105-0002', lassi, lassiVariant, 2, '60.00', 'Guest changed mind'),
    line('OI-000104', TABLE5_ORDER, 'KOT-20261105-0003', dal, dalVariant, 1, '180.00'),
    line('OI-000105', TABLE5_ORDER, 'KOT-20261105-0003', roti, rotiVariant, 2, '20.00'),
  );
  data.payments.push(payment('PAY-000001', TABLE5_ORDER, 'CASH', '300.00'), payment('PAY-000002', TABLE5_ORDER, 'UPI', '220.00'));

  // Takeaway T-003: BC Half + 2 roti; a third roti cancelled while the KOT was still NEW.
  data.orders.push(order({ id: TAKEAWAY_ORDER, order_type: 'TAKEAWAY', token: 'T-003', customer_name: 'Sharma ji' }));
  data.kots.push(kot('KOT-20261105-0008', 8, TAKEAWAY_ORDER, 'NEW', at('13:00')));
  data.order_items.push(
    line('OI-000110', TAKEAWAY_ORDER, 'KOT-20261105-0008', item, variant, 1, '220.00'),
    line('OI-000111', TAKEAWAY_ORDER, 'KOT-20261105-0008', roti, rotiVariant, 2, '20.00'),
    line('OI-000112', TAKEAWAY_ORDER, 'KOT-20261105-0008', roti, rotiVariant, 1, '20.00', 'Cancelled before cooking'),
  );

  const counters: Record<string, number> = { ORDER: 9, 'KOT:2026-11-05': 9, ORDER_ITEM: 113, 'BILL:2026-11-05': 2, 'TOKEN:2026-11-05': 4, PAYMENT: 3, PRICE_CHANGE: 2 };
  for (const [key, next] of Object.entries(counters)) data.counters.push({ id: key, counter_key: key, next_value: next, updated_at: NOW, row_version: 1 });
  return data;
}
