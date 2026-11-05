// Server-computed order totals (REQ-059, REQ-102). All maths in integer paise:
// subtotal = sum of ACTIVE line_total; tax = (subtotal − discount) × GST rate
// (DEC-011, off when gst_rate_percent is null); the grand total is rounded
// half-up to the nearest rupee with the difference in round_off;
// paid = sum of SUCCESS payments; balance = grand − paid.
import { Order, OrderItem, Payment, Setting } from '@dhaba/shared';
import { fromPaise, toPaise } from './money';

export type OrderTotals = Pick<Order, 'subtotal' | 'discount_amount' | 'tax_amount' | 'round_off' | 'grand_total' | 'paid_amount' | 'balance_due'>;

/** Rounds a non-negative paise amount half-up to whole rupees. */
function roundToRupee(paise: number): number {
  return Math.floor((paise + 50) / 100) * 100;
}

export function computeTotals(
  order: Pick<Order, 'discount_amount'>,
  lines: OrderItem[],
  payments: Payment[],
  settings?: Pick<Setting, 'gst_rate_percent'> | null,
): OrderTotals {
  const subtotal = lines.filter((l) => l.status === 'ACTIVE').reduce((sum, l) => sum + toPaise(l.line_total), 0);
  const discount = Math.min(toPaise(order.discount_amount || '0'), subtotal);
  const taxable = subtotal - discount;
  // gst_rate_percent "5.00" → 500 hundredths of a percent.
  const rate = settings?.gst_rate_percent != null ? toPaise(settings.gst_rate_percent) : 0;
  const tax = Math.round((taxable * rate) / 10000);
  const exact = taxable + tax;
  const grand = roundToRupee(exact);
  const paid = payments.filter((p) => p.status === 'SUCCESS').reduce((sum, p) => sum + toPaise(p.amount), 0);
  return {
    subtotal: fromPaise(subtotal),
    discount_amount: fromPaise(discount),
    tax_amount: fromPaise(tax),
    round_off: fromPaise(grand - exact),
    grand_total: fromPaise(grand),
    paid_amount: fromPaise(paid),
    balance_due: fromPaise(grand - paid),
  };
}
