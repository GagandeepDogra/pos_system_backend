// Derived table status (REQ-033, DEC-003): never stored. A table's status
// comes only from its OPEN/BILLED order; KOT state is never consulted, and
// only PAID, CLOSED_EXCEPTION or CANCELLED frees a table.
import { DiningTable, Order, TableStatus } from '@dhaba/shared';

type OrderReader = { findBy(sheet: 'orders', column: string, value: unknown): Order[] };

/** The one OPEN or BILLED order on a table, if any. */
export function activeOrderForTable(store: OrderReader, tableId: string): Order | undefined {
  return store.findBy('orders', 'table_id', tableId).find((o) => o.status === 'OPEN' || o.status === 'BILLED');
}

export function tableStatus(order: Order | undefined): TableStatus {
  if (!order) return 'AVAILABLE';
  return order.status === 'BILLED' ? 'READY_TO_CLOSE' : 'OCCUPIED';
}

/** One table-grid card: the table, its derived status and, if occupied, the running bill. */
export interface TableCard extends DiningTable {
  status: TableStatus;
  order_id: string | null;
  bill_no: string | null;
  guest_count: number | null;
  opened_at: string | null;
  minutes_open: number | null;
  /** Running bill (grand_total); omitted for Kitchen (REQ-021). */
  running_total?: string | null;
  /** Omitted for Kitchen. */
  balance_due?: string | null;
}

export function tableCard(table: DiningTable, order: Order | undefined, nowMs: number, withAmounts: boolean): TableCard {
  const opened = order ? Date.parse(order.created_at) : NaN;
  const card: TableCard = {
    ...table,
    status: tableStatus(order),
    order_id: order?.id ?? null,
    bill_no: order?.bill_no ?? null,
    guest_count: order?.guest_count ?? null,
    opened_at: order?.created_at ?? null,
    minutes_open: order && !Number.isNaN(opened) ? Math.max(0, Math.floor((nowMs - opened) / 60000)) : null,
  };
  if (withAmounts) {
    card.running_total = order?.grand_total ?? null;
    card.balance_due = order?.balance_due ?? null;
  }
  return card;
}

/** Natural order of table numbers: T2 before T10. */
export function compareTableNumbers(a: DiningTable, b: DiningTable): number {
  return a.table_number.localeCompare(b.table_number, undefined, { numeric: true, sensitivity: 'base' });
}
