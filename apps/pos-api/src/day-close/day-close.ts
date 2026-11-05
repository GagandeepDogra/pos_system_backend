// Day close (REQ-096, REQ-109, REQ-108, REQ-074). The summary lists every OPEN
// or BILLED order (shown in red; each must be paid or closed by exception) and
// the SUCCESS cash total of the business day for drawer counting. Closing holds
// the write queue throughout: it refuses while unsettled orders remain, resets
// today's availability, flushes the save, takes the day-close snapshot and then
// archives any finished month (resumable, see storage/archive.ts).
//
// Token, KOT and bill numbers need no reset here: their counters are keyed by
// business date (TOKEN:/KOT:/BILL:<date>) and restart at 1 after the cut-off.
import { Order } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { fromPaise, toPaise } from '../billing/money';
import { ApiError } from '../common/errors';
import { nowIst } from '../common/time';
import { resetAvailability, todayOf } from '../menu/availability';
import { isOpenOrder } from '../orders/dine-in';
import { MonthArchiveResult, MonthlyArchiver } from '../storage/archive';
import type { StorageService } from '../storage/storage.service';
import { WorkbookStore } from '../storage/workbook-store';
import { Tx } from '../storage/write-queue';

type Reader = Pick<WorkbookStore, 'all'> | Pick<Tx, 'all'>;

export interface UnsettledOrder {
  id: string;
  label: string;
  order_type: Order['order_type'];
  status: Order['status'];
  business_date: string;
  bill_no: string | null;
  grand_total: string;
  paid_amount: string;
  balance_due: string;
  created_at: string;
  /** Always true: the screen shows every unsettled order in red (REQ-096). */
  highlight: true;
}

export interface DayCloseSummary {
  business_date: string;
  /** OPEN/BILLED orders of any date, oldest first; each must be paid or closed by exception. */
  open_orders: UnsettledOrder[];
  /** SUCCESS CASH payments of the business day (VOIDED excluded), 2-dp string. */
  cash_total: string;
  cash_payment_count: number;
  can_close: boolean;
}

export interface DayCloseResult {
  business_date: string;
  closed_at: string;
  cash_total: string;
  /** Items set back to available_today = TRUE. */
  availability_reset: string[];
  /** The day-close snapshot, and the snapshots now in backups/. */
  snapshot: { name: string; reason: string; journal_seq: number };
  snapshots: string[];
  archives: MonthArchiveResult[];
}

function unsettled(store: Reader): UnsettledOrder[] {
  return store.all('orders')
    .filter(isOpenOrder)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    .map((o) => ({
      id: o.id,
      label: o.table_label_snapshot ?? o.token ?? o.id,
      order_type: o.order_type,
      status: o.status,
      business_date: o.business_date,
      bill_no: o.bill_no ?? null,
      grand_total: o.grand_total,
      paid_amount: o.paid_amount,
      balance_due: o.balance_due,
      created_at: o.created_at,
      highlight: true,
    }));
}

function cash(store: Reader, businessDate: string): { total: string; count: number } {
  const rows = store.all('payments').filter((p) => p.method === 'CASH' && p.status === 'SUCCESS' && p.business_date === businessDate);
  return { total: fromPaise(rows.reduce((sum, p) => sum + toPaise(p.amount), 0)), count: rows.length };
}

export function dayCloseSummary(store: WorkbookStore, nowMs: number): DayCloseSummary {
  const businessDate = todayOf(store, nowMs);
  const open = unsettled(store);
  const { total, count } = cash(store, businessDate);
  return { business_date: businessDate, open_orders: open, cash_total: total, cash_payment_count: count, can_close: open.length === 0 };
}

export class OrdersRemainOpenError extends ApiError {
  constructor(orders: UnsettledOrder[]) {
    super(409, 'OPEN_ORDERS_REMAIN',
      `${orders.length} order(s) are still open or billed. Take payment or close them by exception first.`,
      `${orders.length} ऑर्डर अभी खुले या बिल किए हुए हैं। पहले भुगतान लें या अपवाद से बंद करें।`,
      { orders });
  }
}

export class SnapshotFailedError extends ApiError {
  constructor(reason: string) {
    super(503, 'SNAPSHOT_FAILED', 'The day-close backup could not be saved. Try again or call the owner.',
      'दिन बंद का बैकअप सेव नहीं हुआ। फिर से कोशिश करें या मालिक को बुलाएँ।', { reason });
  }
}

/**
 * Closes the business day. Writes wait while it runs. Steps: refuse (409) if
 * any OPEN/BILLED order remains; reset availability + DAY_CLOSE audit (one
 * journal entry); flush the save; day-close snapshot; month-end archive.
 */
export function closeDay(storage: StorageService, userId: string, nowMs: number): Promise<DayCloseResult> {
  const archiver = new MonthlyArchiver(storage);
  return storage.queue.exclusive(async (commit) => {
    storage.assertWritable();
    const businessDate = todayOf(storage.store, nowMs);
    const { availability, cashTotal, closedAt } = commit((tx) => {
      const open = unsettled(tx);
      if (open.length) throw new OrdersRemainOpenError(open);
      const reset = resetAvailability(tx, { all: true, userId });
      const { total } = cash(tx, businessDate);
      writeAudit(tx, {
        action: 'DAY_CLOSE',
        entity_type: 'day_close',
        entity_id: businessDate,
        user_id: userId,
        after_json: { business_date: businessDate, cash_total: total, availability_reset: reset.length },
      });
      tx.emit('dashboard.updated', {});
      return { availability: reset, cashTotal: total, closedAt: tx.now };
    });

    await storage.save();
    let snapshot;
    try {
      snapshot = await storage.backups.dayCloseSnapshot();
    } catch (err) {
      throw new SnapshotFailedError((err as Error).message);
    }

    const archives = await archiver.archiveDue(commit, businessDate, userId, nowIst());
    if (archives.some((a) => a.status === 'ARCHIVED')) await storage.save();

    return {
      business_date: businessDate,
      closed_at: closedAt,
      cash_total: cashTotal,
      availability_reset: availability,
      snapshot: { name: snapshot.name, reason: snapshot.reason, journal_seq: snapshot.journal_seq },
      snapshots: storage.backups.folder.list().map((s) => s.name).sort(),
      archives,
    };
  });
}
