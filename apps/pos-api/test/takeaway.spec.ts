// Takeaway tokens, the active list and the handover rule (REQ-038..041) on a
// raw Tx with a fixed clock.
import { Kot } from '@dhaba/shared';
import { SessionUser } from '../src/auth/decorators';
import { activeTakeaways, createTakeaway, handOver, kitchenStatus } from '../src/orders/takeaway';
import { Tx } from '../src/storage/write-queue';
import { WorkbookStore } from '../src/storage/workbook-store';
import { sampleSessionData, TAKEAWAY_ORDER } from './support/sample-session';

const AT = '2026-11-05T14:00:00.000+05:30';
const user = { id: 'USR-C', role: 'CASHIER', display_name: 'Ravi', device_id: null } as unknown as SessionUser;

describe('takeaway service (WI-011)', () => {
  let store: WorkbookStore;
  const tx = (now = AT) => new Tx(store, now);
  const order = (id: string) => store.get('orders', id)!;
  const kotsOf = (id: string) => store.findBy('kots', 'order_id', id);
  const setKots = (id: string, status: Kot['status']) => { for (const k of kotsOf(id)) store.replace('kots', { ...k, status }); };
  const markPaid = (id: string) => store.replace('orders', { ...order(id), status: 'PAID', paid_amount: '260.00', balance_due: '0.00' });
  const card = (id: string) => activeTakeaways(store).find((c) => c.id === id);
  /** The status and response body of a refused handover of the sample takeaway. */
  const handoverError = () => {
    try {
      handOver(tx(), TAKEAWAY_ORDER, order(TAKEAWAY_ORDER).row_version, user);
    } catch (e) {
      const err = e as { getStatus(): number; getResponse(): object };
      return { status: err.getStatus(), ...err.getResponse() };
    }
    throw new Error('handover was not refused');
  };

  beforeEach(() => { store = new WorkbookStore(sampleSessionData()); });

  it('REQ-038: tokens continue the business day counter one after another', () => {
    const a = createTakeaway(tx(), {}, 'k-a', user);
    const b = createTakeaway(tx(), {}, 'k-b', user);
    expect([a.token, b.token]).toEqual(['T-004', 'T-005']);
    expect(a).toMatchObject({ order_type: 'TAKEAWAY', business_date: '2026-11-05', status: 'OPEN', table_id: null, client_request_id: 'k-a', handed_over_at: null });
  });

  it('REQ-038/REQ-097: before the 04:00 cut-off the token continues; the first takeaway after it gets T-001', () => {
    const late = createTakeaway(tx('2026-11-06T03:59:00.000+05:30'), {}, 'k-late', user);
    expect(late).toMatchObject({ business_date: '2026-11-05', token: 'T-004' });
    const first = createTakeaway(tx('2026-11-06T04:01:00.000+05:30'), {}, 'k-first', user);
    expect(first).toMatchObject({ business_date: '2026-11-06', token: 'T-001' });
    expect(createTakeaway(tx('2026-11-06T04:02:00.000+05:30'), {}, 'k-second', user).token).toBe('T-002');
  });

  it('REQ-038: a token that already exists for the business date is rejected with 409', () => {
    const counter = store.findUnique('counters', 'counter_key', 'TOKEN:2026-11-05')!;
    store.replace('counters', { ...counter, next_value: 3 }); // T-003 is the sample takeaway
    expect(() => createTakeaway(tx(), {}, 'k-dup', user)).toThrow(expect.objectContaining({ status: 409, code: 'TOKEN_EXISTS' }));
  });

  it('REQ-039: customer details are optional; blanks become null and 4 phone digits are kept', () => {
    expect(createTakeaway(tx(), { customer_name: '  ', customer_phone: '' }, 'k-1', user)).toMatchObject({ customer_name: null, customer_phone: null });
    expect(createTakeaway(tx(), { customer_name: 'Meena', customer_phone: '4321' }, 'k-2', user)).toMatchObject({ customer_name: 'Meena', customer_phone: '4321' });
  });

  it('REQ-040: the list shows token, item count, kitchen status and paid state', () => {
    expect(card(TAKEAWAY_ORDER)).toMatchObject({ token: 'T-003', item_count: 3, kitchen_status: 'NEW', paid: false, ready_to_hand_over: false });
    const fresh = createTakeaway(tx(), {}, 'k-new', user);
    expect(card(fresh.id)).toMatchObject({ item_count: 0, kitchen_status: 'NONE' });
    expect(activeTakeaways(store).every((c) => c.order_type === 'TAKEAWAY')).toBe(true);
  });

  it('REQ-040: kitchen status is the least advanced live KOT', () => {
    const k = (status: Kot['status']) => ({ status }) as Kot;
    expect(kitchenStatus([])).toBe('NONE');
    expect(kitchenStatus([k('CANCELLED')])).toBe('NONE');
    expect(kitchenStatus([k('READY'), k('PREPARING')])).toBe('PREPARING');
    expect(kitchenStatus([k('READY'), k('CANCELLED'), k('SERVED')])).toBe('READY');
  });

  it('REQ-041: a Ready but unpaid takeaway stays in the list as unpaid and cannot be handed over', () => {
    setKots(TAKEAWAY_ORDER, 'READY');
    expect(card(TAKEAWAY_ORDER)).toMatchObject({ kitchen_status: 'READY', paid: false, ready_to_hand_over: false });
    expect(handoverError()).toMatchObject({ status: 422, code: 'NOT_READY_FOR_HANDOVER', details: { reasons: ['NOT_PAID'] } });
    expect(card(TAKEAWAY_ORDER)).toBeDefined();
  });

  it('REQ-041: a paid takeaway still cooking cannot be handed over', () => {
    markPaid(TAKEAWAY_ORDER);
    expect(card(TAKEAWAY_ORDER)).toMatchObject({ paid: true, kitchen_status: 'NEW' });
    expect(handoverError()).toMatchObject({ status: 422, details: { reasons: ['NOT_READY'] } });
  });

  it('REQ-040: handing over a Ready, Paid token removes it from the list, serves its KOT and writes an audit row', () => {
    setKots(TAKEAWAY_ORDER, 'READY');
    markPaid(TAKEAWAY_ORDER);
    const t = tx();
    const after = handOver(t, TAKEAWAY_ORDER, order(TAKEAWAY_ORDER).row_version, user);
    expect(after.handed_over_at).toBe(AT);
    expect(card(TAKEAWAY_ORDER)).toBeUndefined();
    expect(kotsOf(TAKEAWAY_ORDER)).toEqual([expect.objectContaining({ status: 'SERVED', served_at: AT, hide_after: '2026-11-05T14:10:00.000+05:30' })]);
    expect(store.all('audit_log').some((a) => a.action === 'HANDOVER' && a.entity_id === TAKEAWAY_ORDER)).toBe(true);
    expect(t.events.map((e) => e.event)).toEqual(expect.arrayContaining(['kot.status_changed', 'order.updated']));
    expect(() => handOver(tx(), TAKEAWAY_ORDER, after.row_version, user)).toThrow(expect.objectContaining({ status: 422, code: 'ALREADY_HANDED_OVER' }));
  });

  it('REQ-113: a stale If-Match is a 409; a dine-in order is not a takeaway', () => {
    expect(() => handOver(tx(), TAKEAWAY_ORDER, 99, user)).toThrow(expect.objectContaining({ status: 409 }));
    const dineIn = store.all('orders').find((o) => o.order_type === 'DINE_IN')!;
    expect(() => handOver(tx(), dineIn.id, dineIn.row_version, user)).toThrow(expect.objectContaining({ status: 422, code: 'NOT_A_TAKEAWAY' }));
  });

  it('REQ-040: paid-off, cancelled and written-off takeaways are not active', () => {
    store.replace('orders', { ...order(TAKEAWAY_ORDER), status: 'CANCELLED' });
    expect(card(TAKEAWAY_ORDER)).toBeUndefined();
    store.replace('orders', { ...order(TAKEAWAY_ORDER), status: 'CLOSED_EXCEPTION' });
    expect(card(TAKEAWAY_ORDER)).toBeUndefined();
  });
});
