// Closed (PAID) orders with a KOT, lines, a payment, an exception and audit rows,
// for archive tests. Variants VAR-1 / VAR-2 come from fixtures.sampleData().
import { WorkbookData } from '../../src/storage/workbook-codec';

let n = 0;

/** Pushes `count` PAID orders of business date `date` (YYYY-MM-DD) into `data`; returns their ids. */
export function addClosedOrders(data: WorkbookData, date: string, count: number, linesPerOrder = 3): string[] {
  const ids: string[] = [];
  const t = `${date}T13:00:00.000+05:30`;
  const stamp = { created_at: t, created_by: 'SYSTEM', updated_at: t, updated_by: 'SYSTEM', row_version: 2 };
  const d = date.replace(/-/g, '');
  for (let i = 0; i < count; i++) {
    const k = ++n;
    const id = `ORD-${d}-${String(k).padStart(4, '0')}`;
    const kot = `KOT-${d}-${String(k).padStart(4, '0')}`;
    ids.push(id);
    data.orders.push({
      id, order_type: 'DINE_IN', business_date: date, table_id: 'TBL-1', table_label_snapshot: 'T1', token: null,
      customer_name: null, customer_phone: null, guest_count: 2, status: 'PAID', bill_no: `B-${d}-${String(k).padStart(3, '0')}`,
      subtotal: '440.00', discount_amount: '0.00', discount_reason: null, tax_amount: '0.00', round_off: '0.00', grand_total: '440.00',
      paid_amount: '440.00', balance_due: '0.00', merged_into_order_id: null, handed_over_at: null, client_request_id: `arc-req-${k}`, ...stamp,
    });
    data.kots.push({ id: kot, kot_number: k, business_date: date, order_id: id, status: 'SERVED', idempotency_key: `arc-kot-${k}`, sent_at: t, served_at: t, hide_after: t, ...stamp });
    for (let j = 0; j < linesPerOrder; j++) {
      data.order_items.push({
        id: `OI-A${k}-${j}`, order_id: id, kot_id: kot, variant_id: 'VAR-1', item_name_snapshot: 'Butter Chicken', item_name_hi_snapshot: 'बटर चिकन',
        variant_name_snapshot: 'Half', food_type_snapshot: 'NON_VEG', unit_price: '220.00', quantity: 2, line_total: '440.00', note: 'less spicy',
        status: j === 0 ? 'ACTIVE' : 'CANCELLED', cancel_reason: j === 0 ? null : 'Guest changed mind', ...stamp,
      });
    }
    data.payments.push({
      id: `PAY-A${k}`, order_id: id, business_date: date, method: 'CASH', amount: '440.00', tendered_amount: '500.00', upi_ref: null,
      status: 'SUCCESS', void_reason: null, voided_by: null, idempotency_key: `arc-pay-${k}`, ...stamp,
    });
    data.exceptions.push({ id: `EXC-A${k}`, order_id: id, exception_type: 'CANCEL_AFTER_START', reason_code: 'OTHER', reason_text: null, amount: null, requested_by: 'SYSTEM', approved_by: null, created_at: t });
    data.audit_log.push({
      id: `AUD-A${k}`, action: 'CREATE', entity_type: 'orders', entity_id: id, user_id: 'SYSTEM', approver_id: null, device_id: null,
      before_json: null, after_json: { status: 'OPEN', note: 'synthetic archive row' }, created_at: t,
    });
  }
  return ids;
}
