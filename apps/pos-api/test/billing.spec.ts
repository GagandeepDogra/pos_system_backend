// Billing service over the §7.6 sample session (REQ-100) and its rules
// (REQ-058, REQ-059, REQ-060, REQ-061, REQ-102), on a fixed clock.
import { Role } from '@dhaba/shared';
import { ApprovalInvalidError } from '../src/auth/approvals';
import { SessionUser } from '../src/auth/decorators';
import { applyDiscount, discountPaise, DiscountInput, printBill, recomputeOrder } from '../src/billing/bill';
import { computeTotals } from '../src/billing/totals';
import { sendToKitchen } from '../src/kitchen/kots';
import { Tx } from '../src/storage/write-queue';
import { WorkbookStore } from '../src/storage/workbook-store';
import { WorkbookData } from '../src/storage/workbook-codec';
import { sampleSessionData, TABLE5_ORDER, TAKEAWAY_ORDER } from './support/sample-session';

const AT = '2026-11-05T14:00:00.000+05:30';
const user = (role: Role = 'CASHIER', id = 'USR-C'): SessionUser => ({ id, role, display_name: id, device_id: null } as unknown as SessionUser);
const noApproval = (token: string | null): string => {
  if (token === 'ok') return 'ADM-1';
  throw new ApprovalInvalidError(token ? 'unknown' : 'missing');
};

describe('billing service (WI-009)', () => {
  let data: WorkbookData;
  let store: WorkbookStore;
  const tx = (now = AT) => new Tx(store, now);
  const order = (id: string) => store.get('orders', id)!;
  const lines = (id: string) => store.findBy('order_items', 'order_id', id);
  const totalsOf = (id: string) => computeTotals(order(id), lines(id), store.findBy('payments', 'order_id', id), store.all('settings')[0]);
  const discount = (id: string, input: Partial<DiscountInput>, who = user()) =>
    applyDiscount(tx(), id, order(id).row_version, { discount_type: 'FIXED', value: '0', reason_code: 'OTHER', reason_text: 'Regular', approvalToken: null, ...input }, who, noApproval);

  beforeEach(() => {
    data = sampleSessionData();
    store = new WorkbookStore(data);
  });

  describe('§7.6 sample session fixture', () => {
    it('REQ-100: takeaway ORD-20261105-0008 recomputes to subtotal 260 and balance due 260', () => {
      expect(totalsOf(TAKEAWAY_ORDER)).toMatchObject({ subtotal: '260.00', grand_total: '260.00', balance_due: '260.00' });
    });

    it('REQ-100: takeaway T-003 excludes the Tandoori Roti line cancelled before cooking', () => {
      const cancelled = lines(TAKEAWAY_ORDER).filter((l) => l.status === 'CANCELLED');
      expect(order(TAKEAWAY_ORDER).token).toBe('T-003');
      expect(cancelled.map((l) => l.item_name_snapshot)).toEqual(['Tandoori Roti']);
      expect(store.get('kots', cancelled[0].kot_id)!.status).toBe('NEW');
      expect(totalsOf(TAKEAWAY_ORDER).subtotal).toBe('260.00'); // would be 280 with the roti
    });

    it('REQ-058/REQ-100: Table 5 excludes the cancelled Sweet Lassi line while the row stays in OrderItems', () => {
      const lassi = lines(TABLE5_ORDER).find((l) => l.item_name_snapshot === 'Sweet Lassi')!;
      expect(lassi.status).toBe('CANCELLED');
      expect(new Set(lines(TABLE5_ORDER).map((l) => l.kot_id)).size).toBe(2);
      // 220 + 4×20 + 180 + 2×20 = 520 (the lassi's 120 is not billed); split CASH 300 + UPI 220 settles it.
      expect(totalsOf(TABLE5_ORDER)).toMatchObject({ subtotal: '520.00', grand_total: '520.00', paid_amount: '520.00', balance_due: '0.00' });
    });

    it('REQ-058/REQ-100: the sample Butter Chicken Half line bills at ₹220, the price after the recorded change', () => {
      const change = store.all('price_changes')[0];
      expect(change).toMatchObject({ variant_id: 'VAR-1', old_price: '200.00', new_price: '220.00' });
      const bc = lines(TAKEAWAY_ORDER).find((l) => l.item_name_snapshot === 'Butter Chicken')!;
      expect(bc).toMatchObject({ variant_name_snapshot: 'Half', unit_price: '220.00', line_total: '220.00' });
    });
  });

  describe('printBill', () => {
    it('REQ-060: assigns B-YYYYMMDD-NNN from the business date, sets BILLED and keeps the number on reprint', () => {
      const billed = printBill(tx(), TAKEAWAY_ORDER, 1, user());
      expect(billed).toMatchObject({ status: 'BILLED', bill_no: 'B-20261105-002', subtotal: '260.00', grand_total: '260.00', balance_due: '260.00' });
      const again = printBill(tx(), TAKEAWAY_ORDER, billed.row_version, user());
      expect(again.bill_no).toBe('B-20261105-002');
      expect(store.all('audit_log').filter((a) => a.entity_id === TAKEAWAY_ORDER).map((a) => a.action)).toEqual(['BILL_PRINT', 'BILL_REPRINT']);
    });

    it('REQ-060: a bill number is unique across orders and follows the 04:00 business-day cut-off', () => {
      const a = printBill(tx(), TAKEAWAY_ORDER, 1, user());
      const b = printBill(tx(), 'ORD-20261105-0001', 1, user());
      expect(a.bill_no).not.toBe(b.bill_no);
      expect(store.all('orders').filter((o) => o.bill_no === b.bill_no)).toHaveLength(1);
      // 02:30 on the 6th still belongs to business date 2026-11-05.
      store = new WorkbookStore(sampleSessionData());
      expect(printBill(tx('2026-11-06T02:30:00.000+05:30'), TAKEAWAY_ORDER, 1, user()).bill_no).toMatch(/^B-20261105-\d{3}$/);
    });

    it('REQ-059: tax is 0 when GST is disabled; a ₹540.60 subtotal rounds to a ₹541 grand total', () => {
      const o = order('ORD-20261105-0001');
      store.replace('order_items', { ...lines(o.id)[0], unit_price: '90.10', quantity: 6, line_total: '540.60' });
      const billed = printBill(tx(), o.id, 1, user());
      expect(billed).toMatchObject({ subtotal: '540.60', tax_amount: '0.00', round_off: '0.40', grand_total: '541.00' });
    });

    it('REQ-059: a ₹500 subtotal with tax disabled bills tax ₹0 and grand total ₹500; with 5% GST tax is on top', () => {
      const o = order('ORD-20261105-0001');
      store.replace('order_items', { ...lines(o.id)[0], quantity: 25, line_total: '500.00' });
      expect(printBill(tx(), o.id, 1, user())).toMatchObject({ subtotal: '500.00', tax_amount: '0.00', grand_total: '500.00' });
      store.replace('settings', { ...store.all('settings')[0], gst_rate_percent: '5.00' });
      expect(printBill(tx(), o.id, 2, user())).toMatchObject({ tax_amount: '25.00', grand_total: '525.00' });
    });

    it('REQ-060: refuses a stale row_version, a closed order and an order with no ACTIVE line', () => {
      expect(() => printBill(tx(), TAKEAWAY_ORDER, 7, user())).toThrow(expect.objectContaining({ status: 409, code: 'ROW_VERSION_CONFLICT' }));
      expect(() => printBill(tx(), TABLE5_ORDER, 1, user())).toThrow(expect.objectContaining({ code: 'ORDER_NOT_OPEN' }));
      for (const l of lines(TAKEAWAY_ORDER)) store.replace('order_items', { ...l, status: 'CANCELLED' });
      expect(() => printBill(tx(), TAKEAWAY_ORDER, 1, user())).toThrow(expect.objectContaining({ status: 422, code: 'EMPTY_BILL' }));
    });

    it('REQ-060: sending a KOT on a BILLED order reopens it to OPEN with a BILL_REOPEN exception', () => {
      printBill(tx(), TAKEAWAY_ORDER, 1, user());
      sendToKitchen(tx(), TAKEAWAY_ORDER, [{ variant_id: 'VAR-2', quantity: 1 }], 'reopen-1', user());
      expect(order(TAKEAWAY_ORDER)).toMatchObject({ status: 'OPEN', bill_no: 'B-20261105-002', subtotal: '280.00' });
      expect(store.findBy('exceptions', 'order_id', TAKEAWAY_ORDER)).toEqual([expect.objectContaining({ exception_type: 'BILL_REOPEN', amount: null })]);
    });

    it('REQ-058: a price change after ordering does not change the existing line price', () => {
      store.replace('variants', { ...store.get('variants', 'VAR-1')!, price: '250.00' });
      const billed = printBill(tx(), TAKEAWAY_ORDER, 1, user());
      expect(lines(TAKEAWAY_ORDER).find((l) => l.variant_id === 'VAR-1')!.unit_price).toBe('220.00');
      expect(billed.subtotal).toBe('260.00');
    });
  });

  describe('applyDiscount', () => {
    it('REQ-061: a fixed discount within the limit applies without approval and writes a DISCOUNT exception', () => {
      const o = discount(TAKEAWAY_ORDER, { value: '60', reason_text: 'Regular customer' });
      expect(o).toMatchObject({ discount_amount: '60.00', discount_reason: 'Regular customer', grand_total: '200.00', balance_due: '200.00' });
      expect(store.findBy('exceptions', 'order_id', TAKEAWAY_ORDER)).toEqual([
        expect.objectContaining({ exception_type: 'DISCOUNT', amount: '60.00', requested_by: 'USR-C', approved_by: null }),
      ]);
    });

    it('REQ-061: a Cashier discount above the limit needs an approval token; the approver is recorded', () => {
      expect(() => discount(TAKEAWAY_ORDER, { value: '150' })).toThrow(expect.objectContaining({ status: 403, code: 'APPROVAL_INVALID' }));
      expect(order(TAKEAWAY_ORDER).discount_amount).toBe('0.00');
      discount(TAKEAWAY_ORDER, { value: '150', approvalToken: 'ok' });
      expect(store.findBy('exceptions', 'order_id', TAKEAWAY_ORDER)[0]).toMatchObject({ approved_by: 'ADM-1', amount: '150.00' });
      expect(store.all('audit_log').find((a) => a.action === 'DISCOUNT')).toMatchObject({ approver_id: 'ADM-1' });
    });

    it('REQ-061: an Admin needs no approval above the limit', () => {
      expect(discount(TAKEAWAY_ORDER, { value: '150' }, user('ADMIN', 'ADM-1')).discount_amount).toBe('150.00');
    });

    it('REQ-061: a discount larger than the subtotal is rejected', () => {
      expect(() => discount(TAKEAWAY_ORDER, { value: '260.01', approvalToken: 'ok' })).toThrow(expect.objectContaining({ status: 422, code: 'DISCOUNT_TOO_LARGE' }));
      expect(() => discount(TAKEAWAY_ORDER, { discount_type: 'PERCENT', value: '100.00', approvalToken: 'ok' })).not.toThrow();
    });

    it('REQ-102: a percent discount with 3 decimals is stored rounded to 2', () => {
      // 12.5% of 260.10 = 32.5125 → 32.51
      store.replace('order_items', { ...store.get('order_items', 'OI-000111')!, unit_price: '20.05', line_total: '40.10' });
      const o = discount(TAKEAWAY_ORDER, { discount_type: 'PERCENT', value: '12.5' });
      expect(o.discount_amount).toBe('32.51');
      expect(o.grand_total).toBe('228.00');
      expect(o.round_off).toBe('0.41');
      expect(discountPaise(26010, 'PERCENT', '12.5')).toBe(3251);
      expect(discountPaise(1, 'PERCENT', '50')).toBe(1); // 0.5 paisa rounds half-up
    });

    it('REQ-061: a zero discount clears the reason; the discount then survives a recompute', () => {
      discount(TAKEAWAY_ORDER, { value: '20' });
      expect(recomputeOrder(tx(), order(TAKEAWAY_ORDER), {}, 'USR-C').grand_total).toBe('240.00');
      expect(discount(TAKEAWAY_ORDER, { value: '0' })).toMatchObject({ discount_amount: '0.00', discount_reason: null, grand_total: '260.00' });
    });

    it('REQ-061: refuses a closed order', () => {
      expect(() => discount(TABLE5_ORDER, { value: '10' })).toThrow(expect.objectContaining({ code: 'ORDER_NOT_OPEN' }));
    });
  });
});
