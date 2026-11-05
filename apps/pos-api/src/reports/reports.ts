// Sales reports (REQ-077) and order history search (REQ-078), Admin only.
// Both read the live in-memory workbook plus, for months that have left live,
// the read-only archive parts (archive/YYYY-MM[-n].xlsx, REQ-108). A row id found
// in several places resolves as: later archive part over earlier, live over any
// archive (a resumable archive run may leave a row in both until the prune).
import {
  Category, EXCEPTION_TYPES, ExceptionType, Item, Order, OrderException, OrderItem, PAYMENT_METHODS, Payment, PaymentMethod, Variant,
} from '@dhaba/shared';
import { fromPaise, toPaise } from '../billing/money';
import { listArchiveParts } from '../storage/archive';
import { WorkbookData } from '../storage/workbook-codec';
import { readWorkbookFile } from '../storage/workbook-file';
import { WorkbookStore } from '../storage/workbook-store';

export interface ReportSource {
  readonly store: WorkbookStore;
  readonly archiveDir: string;
}

/** Parsed archive parts, keyed by file path. Archive files are never rewritten, so a cached parse stays valid. */
const ARCHIVE_CACHE_SIZE = 6;
const archiveCache = new Map<string, Promise<WorkbookData>>();

export function readArchivePart(file: string): Promise<WorkbookData> {
  const hit = archiveCache.get(file);
  if (hit) {
    archiveCache.delete(file);
    archiveCache.set(file, hit);
    return hit;
  }
  const parsed = readWorkbookFile(file);
  parsed.catch(() => archiveCache.delete(file));
  archiveCache.set(file, parsed);
  while (archiveCache.size > ARCHIVE_CACHE_SIZE) archiveCache.delete(archiveCache.keys().next().value as string);
  return parsed;
}

/** Calendar months (YYYY-MM) from `from` to `to` (dates YYYY-MM-DD), inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

/** Transaction and reference rows for a set of months: archive parts (oldest first), then live on top. */
export interface ReportRows {
  orders: Order[];
  order_items: OrderItem[];
  payments: Payment[];
  exceptions: OrderException[];
  variants: Map<string, Variant>;
  items: Map<string, Item>;
  categories: Map<string, Category>;
  archive_files: string[];
}

export async function loadRows(src: ReportSource, months: string[]): Promise<ReportRows> {
  const orders = new Map<string, Order>();
  const lines = new Map<string, OrderItem>();
  const payments = new Map<string, Payment>();
  const exceptions = new Map<string, OrderException>();
  const variants = new Map<string, Variant>();
  const items = new Map<string, Item>();
  const categories = new Map<string, Category>();
  const archiveFiles: string[] = [];
  const put = <T extends { id: string }>(map: Map<string, T>, rows: readonly T[]) => { for (const r of rows) map.set(r.id, r); };
  const parts = months.flatMap((m) => listArchiveParts(src.archiveDir, m));
  for (const part of parts) {
    const data = await readArchivePart(part.file);
    archiveFiles.push(part.name);
    put(orders, data.orders);
    put(lines, data.order_items);
    put(payments, data.payments);
    put(exceptions, data.exceptions);
    put(variants, data.variants);
    put(items, data.items);
    put(categories, data.categories);
  }
  const s = src.store;
  put(orders, s.all('orders'));
  put(lines, s.all('order_items'));
  put(payments, s.all('payments'));
  put(exceptions, s.all('exceptions'));
  put(variants, s.all('variants'));
  put(items, s.all('items'));
  put(categories, s.all('categories'));
  return {
    orders: [...orders.values()], order_items: [...lines.values()], payments: [...payments.values()], exceptions: [...exceptions.values()],
    variants, items, categories, archive_files: archiveFiles,
  };
}

export interface MoneyCount { count: number; amount: string }

export interface SalesReport {
  from: string;
  to: string;
  /** Sum of SUCCESS payments whose business_date is in the range (voided payments excluded). */
  total_sales: string;
  payment_count: number;
  by_method: Record<PaymentMethod, MoneyCount>;
  voided_payments: MoneyCount;
  by_day: { business_date: string; total: string; payment_count: number }[];
  orders: { count: number; by_status: Record<string, number> };
  /** ACTIVE lines of the range's non-cancelled orders, at their snapshot price (before discount and tax). */
  by_category: { category_id: string | null; name_en: string; name_hi: string; quantity: number; amount: string }[];
  top_items: { item_id: string | null; name_en: string; name_hi: string; quantity: number; amount: string }[];
  cancelled_items: {
    count: number; quantity: number; amount: string;
    lines: { id: string; order_id: string; business_date: string; item_name: string; variant_name: string; quantity: number; line_total: string; cancel_reason: string | null }[];
  };
  discounts: { count: number; amount: string; orders: { order_id: string; business_date: string; bill_no: string | null; amount: string; reason: string | null }[] };
  exceptions: {
    by_type: Record<ExceptionType, MoneyCount>;
    rows: (OrderException & { business_date: string })[];
  };
  /** Archive files the report read. */
  archive_files: string[];
}

const TOP_ITEMS = 10;

const sumCount = (): { count: number; paise: number } => ({ count: 0, paise: 0 });
const out = (c: { count: number; paise: number }): MoneyCount => ({ count: c.count, amount: fromPaise(c.paise) });

/** Pure aggregation over already-merged rows (tests call it directly). */
export function aggregateSales(rows: ReportRows, from: string, to: string): SalesReport {
  const inRange = (d: string) => d >= from && d <= to;

  // Payments: by their own business_date.
  const methods = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, sumCount()])) as Record<PaymentMethod, { count: number; paise: number }>;
  const voided = sumCount();
  const days = new Map<string, { count: number; paise: number }>();
  let total = 0;
  let count = 0;
  for (const p of rows.payments) {
    if (!inRange(p.business_date)) continue;
    const paise = toPaise(p.amount);
    if (p.status !== 'SUCCESS') {
      voided.count++;
      voided.paise += paise;
      continue;
    }
    total += paise;
    count++;
    const m = methods[p.method] ?? (methods[p.method] = sumCount());
    m.count++;
    m.paise += paise;
    const d = days.get(p.business_date) ?? sumCount();
    d.count++;
    d.paise += paise;
    days.set(p.business_date, d);
  }

  // Orders of the range.
  const orders = rows.orders.filter((o) => inRange(o.business_date));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const byStatus: Record<string, number> = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

  // Lines: sales by category and item, cancellations.
  const categories = new Map<string, { category_id: string | null; name_en: string; name_hi: string; quantity: number; paise: number }>();
  const itemsAgg = new Map<string, { item_id: string | null; name_en: string; name_hi: string; quantity: number; paise: number }>();
  const cancelled: SalesReport['cancelled_items']['lines'] = [];
  let cancelledQty = 0;
  let cancelledPaise = 0;
  for (const line of rows.order_items) {
    const order = orderById.get(line.order_id);
    if (!order) continue;
    const paise = toPaise(line.line_total);
    if (line.status === 'CANCELLED') {
      cancelled.push({
        id: line.id, order_id: line.order_id, business_date: order.business_date, item_name: line.item_name_snapshot,
        variant_name: line.variant_name_snapshot, quantity: line.quantity, line_total: line.line_total, cancel_reason: line.cancel_reason,
      });
      cancelledQty += line.quantity;
      cancelledPaise += paise;
      continue;
    }
    if (order.status === 'CANCELLED') continue;
    const variant = rows.variants.get(line.variant_id);
    const item = variant ? rows.items.get(variant.item_id) : undefined;
    const category = item ? rows.categories.get(item.category_id) : undefined;
    const catKey = category?.id ?? '';
    const c = categories.get(catKey) ?? {
      category_id: category?.id ?? null, name_en: category?.name_en ?? 'Uncategorised', name_hi: category?.name_hi ?? 'बिना श्रेणी', quantity: 0, paise: 0,
    };
    c.quantity += line.quantity;
    c.paise += paise;
    categories.set(catKey, c);
    const itemKey = item?.id ?? `name:${line.item_name_snapshot}`;
    const it = itemsAgg.get(itemKey) ?? {
      item_id: item?.id ?? null, name_en: line.item_name_snapshot, name_hi: line.item_name_hi_snapshot, quantity: 0, paise: 0,
    };
    it.quantity += line.quantity;
    it.paise += paise;
    itemsAgg.set(itemKey, it);
  }

  // Discounts (stored on the order) and exceptions (of the range's orders).
  const discounted = orders.filter((o) => toPaise(o.discount_amount) > 0 && o.status !== 'CANCELLED');
  const excTypes = Object.fromEntries(EXCEPTION_TYPES.map((t) => [t, sumCount()])) as Record<ExceptionType, { count: number; paise: number }>;
  const excRows: (OrderException & { business_date: string })[] = [];
  for (const e of rows.exceptions) {
    const order = orderById.get(e.order_id);
    if (!order) continue;
    const t = excTypes[e.exception_type] ?? (excTypes[e.exception_type] = sumCount());
    t.count++;
    t.paise += e.amount ? toPaise(e.amount) : 0;
    excRows.push({ ...e, business_date: order.business_date });
  }
  excRows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  const money = <T extends { paise: number }>({ paise, ...rest }: T) => ({ ...rest, amount: fromPaise(paise) });
  return {
    from,
    to,
    total_sales: fromPaise(total),
    payment_count: count,
    by_method: Object.fromEntries(Object.entries(methods).map(([k, v]) => [k, out(v)])) as Record<PaymentMethod, MoneyCount>,
    voided_payments: out(voided),
    by_day: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([business_date, d]) => ({ business_date, total: fromPaise(d.paise), payment_count: d.count })),
    orders: { count: orders.length, by_status: byStatus },
    by_category: [...categories.values()].sort((a, b) => b.paise - a.paise || a.name_en.localeCompare(b.name_en)).map(money),
    top_items: [...itemsAgg.values()].sort((a, b) => b.quantity - a.quantity || b.paise - a.paise || a.name_en.localeCompare(b.name_en)).slice(0, TOP_ITEMS).map(money),
    cancelled_items: {
      count: cancelled.length, quantity: cancelledQty, amount: fromPaise(cancelledPaise),
      lines: cancelled.sort((a, b) => a.business_date.localeCompare(b.business_date) || a.id.localeCompare(b.id)),
    },
    discounts: {
      count: discounted.length,
      amount: fromPaise(discounted.reduce((s, o) => s + toPaise(o.discount_amount), 0)),
      orders: discounted.map((o) => ({ order_id: o.id, business_date: o.business_date, bill_no: o.bill_no, amount: o.discount_amount, reason: o.discount_reason })),
    },
    exceptions: {
      by_type: Object.fromEntries(Object.entries(excTypes).map(([k, v]) => [k, out(v)])) as Record<ExceptionType, MoneyCount>,
      rows: excRows,
    },
    archive_files: rows.archive_files,
  };
}

export async function salesReport(src: ReportSource, from: string, to: string): Promise<SalesReport> {
  return aggregateSales(await loadRows(src, monthsBetween(from, to)), from, to);
}

// ---- Order history search (REQ-078) ----

export interface OrderSearch {
  date?: string;
  bill_no?: string;
  table?: string;
  token?: string;
}

export type OrderHit = Order & { archived: boolean };

export const SEARCH_LIMIT = 200;

/** `3`, `003`, `t-3` and `T-003` all mean token T-003. */
export function normalizeToken(token: string): string {
  const digits = /^(?:t-?)?(\d{1,3})$/i.exec(token.trim());
  return digits ? `T-${digits[1].padStart(3, '0')}` : token.trim().toUpperCase();
}

/** The business date a bill number encodes (B-YYYYMMDD-NNN), if any. */
function billDate(billNo: string): string | null {
  const m = /^B-(\d{4})(\d{2})(\d{2})-\d+$/i.exec(billNo.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function matches(o: Order, q: OrderSearch, token: string | null): boolean {
  if (q.date && o.business_date !== q.date) return false;
  if (q.bill_no && (o.bill_no ?? '').toUpperCase() !== q.bill_no.trim().toUpperCase()) return false;
  if (q.table) {
    const t = q.table.trim().toUpperCase();
    if ((o.table_label_snapshot ?? '').toUpperCase() !== t && (o.table_id ?? '').toUpperCase() !== t) return false;
  }
  if (token && o.token !== token) return false;
  return true;
}

/**
 * Orders matching every given filter, newest first (at most SEARCH_LIMIT).
 * Live orders come from memory; an archived month is searched too when the
 * date or the bill number names it (table/token alone search live only).
 */
export async function searchOrders(src: ReportSource, q: OrderSearch): Promise<OrderHit[]> {
  const token = q.token ? normalizeToken(q.token) : null;
  const hits = new Map<string, OrderHit>();
  const month = (q.date ?? (q.bill_no ? billDate(q.bill_no) : null))?.slice(0, 7);
  if (month) {
    for (const part of listArchiveParts(src.archiveDir, month)) {
      const data = await readArchivePart(part.file);
      for (const o of data.orders) if (matches(o, q, token)) hits.set(o.id, { ...o, archived: true });
    }
  }
  const store = src.store;
  let live: readonly Order[];
  if (q.bill_no) live = [store.findUnique('orders', 'bill_no', q.bill_no.trim().toUpperCase())].filter((o): o is Order => !!o);
  else live = store.all('orders');
  for (const o of live) if (matches(o, q, token)) hits.set(o.id, { ...o, archived: false });
  return [...hits.values()]
    .sort((a, b) => b.business_date.localeCompare(a.business_date) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, SEARCH_LIMIT);
}
