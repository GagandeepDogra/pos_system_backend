import { OrderItem, Payment } from '@dhaba/shared';
import { computeTotals } from './totals';

const line = (line_total: string, status: OrderItem['status'] = 'ACTIVE') => ({ line_total, status }) as OrderItem;
const pay = (amount: string, status: Payment['status'] = 'SUCCESS') => ({ amount, status }) as Payment;

describe('computeTotals', () => {
  it('REQ-059/REQ-100: sums ACTIVE lines only; no GST → tax 0 (Butter Chicken Half 220 + 2 roti = 260)', () => {
    const t = computeTotals({ discount_amount: '0.00' }, [line('220.00'), line('40.00'), line('99.00', 'CANCELLED')], []);
    expect(t).toEqual({ subtotal: '260.00', discount_amount: '0.00', tax_amount: '0.00', round_off: '0.00', grand_total: '260.00', paid_amount: '0.00', balance_due: '260.00' });
  });

  it('REQ-102: GST on (subtotal − discount), grand total rounded half-up to the rupee, SUCCESS payments only', () => {
    const t = computeTotals({ discount_amount: '10.50' }, [line('260.00')], [pay('100.00'), pay('50.00', 'VOIDED')], { gst_rate_percent: '5.00' });
    // taxable 249.50, tax 12.475 → 12.48, exact 261.98 → 262.00, round_off 0.02
    expect(t).toMatchObject({ discount_amount: '10.50', tax_amount: '12.48', round_off: '0.02', grand_total: '262.00', paid_amount: '100.00', balance_due: '162.00' });
  });

  it('REQ-102: a discount never exceeds the subtotal; rounding down shows a negative round_off', () => {
    expect(computeTotals({ discount_amount: '500.00' }, [line('100.00')], [])).toMatchObject({ discount_amount: '100.00', grand_total: '0.00' });
    expect(computeTotals({ discount_amount: '0.00' }, [line('100.40')], [])).toMatchObject({ round_off: '-0.40', grand_total: '100.00' });
  });
});
