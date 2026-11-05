// The v1 workbook schema: exactly 15 worksheets, their columns, types and enums.
import {
  CLOSE_REASON_CODES,
  EXCEPTION_TYPES,
  FOOD_TYPES,
  KOT_STATUSES,
  LANGUAGES,
  ORDER_ITEM_STATUSES,
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PRICE_CHANGE_REASONS,
  ROLES,
  SheetName,
} from '@dhaba/shared';

export const SCHEMA_VERSION = 1;

export type ColumnType = 'string' | 'int' | 'decimal' | 'bool' | 'timestamp' | 'date' | 'json';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  nullable: boolean;
  maxLength?: number;
  /** Allowed values; written as an Excel dropdown and enforced on load. */
  enum?: readonly string[];
  /** Unique across the sheet (nulls ignored). */
  unique?: boolean;
  /** Foreign key: the sheet whose id this column holds. */
  ref?: SheetName;
  /** Kept in a non-unique in-memory index for fast lookups. */
  indexed?: boolean;
}

export interface SheetDef {
  name: SheetName;
  columns: ColumnDef[];
}

const s = (name: string, maxLength: number, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  type: 'string',
  nullable: false,
  maxLength,
  ...extra,
});
const ns = (name: string, maxLength: number, extra: Partial<ColumnDef> = {}): ColumnDef =>
  s(name, maxLength, { nullable: true, ...extra });
const col = (name: string, type: ColumnType, nullable = false): ColumnDef => ({ name, type, nullable });
const id = (maxLength: number): ColumnDef => s('id', maxLength, { unique: true });
const fk = (name: string, ref: SheetName, nullable = false): ColumnDef =>
  s(name, 20, { ref, nullable, indexed: true });

const AUDIT: ColumnDef[] = [
  col('created_at', 'timestamp'),
  s('created_by', 20),
  col('updated_at', 'timestamp'),
  s('updated_by', 20),
  col('row_version', 'int'),
];

export const SHEETS: readonly SheetDef[] = [
  {
    name: 'meta',
    columns: [id(10), col('schema_version', 'int'), col('last_journal_seq', 'int'), col('updated_at', 'timestamp')],
  },
  {
    name: 'counters',
    columns: [
      id(40),
      s('counter_key', 40, { unique: true }),
      col('next_value', 'int'),
      col('updated_at', 'timestamp'),
      col('row_version', 'int'),
    ],
  },
  {
    name: 'settings',
    columns: [
      id(10),
      s('dhaba_name', 80),
      s('address', 200),
      s('phone', 15),
      ns('gst_number', 15),
      col('gst_rate_percent', 'decimal', true),
      s('receipt_footer', 200),
      s('token_reset_time', 5),
      ns('shift_end_time', 5),
      col('late_kot_minutes', 'int'),
      col('discount_limit_amount', 'decimal'),
      col('kitchen_print_enabled', 'bool'),
      ...AUDIT,
    ],
  },
  {
    name: 'users',
    columns: [
      id(20),
      s('display_name', 40),
      s('role', 10, { enum: ROLES }),
      s('pin_hash', 60),
      s('language', 2, { enum: LANGUAGES }),
      col('is_active', 'bool'),
      col('failed_pin_count', 'int'),
      col('locked_until', 'timestamp', true),
      col('token_version', 'int'),
      ...AUDIT,
    ],
  },
  {
    name: 'tables',
    columns: [
      id(20),
      s('table_number', 10, { unique: true }),
      ns('area', 30),
      col('seats', 'int', true),
      col('is_active', 'bool'),
      ...AUDIT,
    ],
  },
  {
    name: 'categories',
    columns: [
      id(20),
      s('name_en', 40, { unique: true }),
      s('name_hi', 40),
      col('sort_order', 'int'),
      col('is_active', 'bool'),
      ...AUDIT,
    ],
  },
  {
    name: 'items',
    columns: [
      id(20),
      fk('category_id', 'categories'),
      s('name_en', 60),
      s('name_hi', 60),
      s('short_code', 5, { unique: true }),
      s('food_type', 7, { enum: FOOD_TYPES }),
      ns('photo_url', 200),
      ns('kitchen_station', 30),
      col('is_active', 'bool'),
      col('available_today', 'bool'),
      ...AUDIT,
    ],
  },
  {
    name: 'variants',
    columns: [
      id(20),
      fk('item_id', 'items'),
      s('name', 30),
      col('price', 'decimal'),
      col('sort_order', 'int'),
      col('is_active', 'bool'),
      ...AUDIT,
    ],
  },
  {
    name: 'orders',
    columns: [
      id(20),
      s('order_type', 8, { enum: ORDER_TYPES }),
      { ...col('business_date', 'date'), indexed: true },
      fk('table_id', 'tables', true),
      ns('table_label_snapshot', 10),
      ns('token', 5),
      ns('customer_name', 40),
      ns('customer_phone', 10),
      col('guest_count', 'int', true),
      s('status', 16, { enum: ORDER_STATUSES, indexed: true }),
      ns('bill_no', 16, { unique: true }),
      col('subtotal', 'decimal'),
      col('discount_amount', 'decimal'),
      ns('discount_reason', 80),
      col('tax_amount', 'decimal'),
      col('round_off', 'decimal'),
      col('grand_total', 'decimal'),
      col('paid_amount', 'decimal'),
      col('balance_due', 'decimal'),
      fk('merged_into_order_id', 'orders', true),
      col('handed_over_at', 'timestamp', true),
      s('client_request_id', 64, { unique: true }),
      ...AUDIT,
    ],
  },
  {
    name: 'kots',
    columns: [
      id(20),
      col('kot_number', 'int'),
      { ...col('business_date', 'date'), indexed: true },
      fk('order_id', 'orders'),
      s('status', 10, { enum: KOT_STATUSES, indexed: true }),
      s('idempotency_key', 64, { unique: true }),
      col('sent_at', 'timestamp'),
      col('served_at', 'timestamp', true),
      col('hide_after', 'timestamp', true),
      ...AUDIT,
    ],
  },
  {
    name: 'order_items',
    columns: [
      id(20),
      fk('order_id', 'orders'),
      fk('kot_id', 'kots'),
      fk('variant_id', 'variants'),
      s('item_name_snapshot', 60),
      s('item_name_hi_snapshot', 60),
      s('variant_name_snapshot', 30),
      s('food_type_snapshot', 7, { enum: FOOD_TYPES }),
      col('unit_price', 'decimal'),
      col('quantity', 'int'),
      col('line_total', 'decimal'),
      ns('note', 80),
      s('status', 9, { enum: ORDER_ITEM_STATUSES }),
      ns('cancel_reason', 80),
      ...AUDIT,
    ],
  },
  {
    name: 'payments',
    columns: [
      id(20),
      fk('order_id', 'orders'),
      { ...col('business_date', 'date'), indexed: true },
      s('method', 4, { enum: PAYMENT_METHODS }),
      col('amount', 'decimal'),
      col('tendered_amount', 'decimal', true),
      ns('upi_ref', 30),
      s('status', 7, { enum: PAYMENT_STATUSES }),
      ns('void_reason', 80),
      ns('voided_by', 20),
      s('idempotency_key', 64, { unique: true }),
      ...AUDIT,
    ],
  },
  {
    name: 'exceptions',
    columns: [
      id(20),
      fk('order_id', 'orders'),
      s('exception_type', 20, { enum: EXCEPTION_TYPES }),
      s('reason_code', 20),
      ns('reason_text', 80),
      col('amount', 'decimal', true),
      s('requested_by', 20),
      fk('approved_by', 'users', true),
      col('created_at', 'timestamp'),
    ],
  },
  {
    name: 'price_changes',
    columns: [
      id(20),
      fk('variant_id', 'variants'),
      col('old_price', 'decimal'),
      col('new_price', 'decimal'),
      s('reason', 12, { enum: PRICE_CHANGE_REASONS }),
      s('changed_by', 20),
      col('created_at', 'timestamp'),
    ],
  },
  {
    name: 'audit_log',
    columns: [
      id(20),
      s('action', 30),
      s('entity_type', 20),
      s('entity_id', 20, { indexed: true }),
      // user_id may be a server job ("SYSTEM"), so it is not checked as a reference.
      s('user_id', 20),
      ns('approver_id', 20),
      ns('device_id', 40),
      col('before_json', 'json', true),
      col('after_json', 'json', true),
      col('created_at', 'timestamp'),
    ],
  },
];

export const SHEET_NAMES: readonly SheetName[] = SHEETS.map((d) => d.name);

/** Exception reason codes for a close are listed here for the services that build them. */
export const CLOSE_REASONS = CLOSE_REASON_CODES;

export function sheetDef(name: SheetName): SheetDef {
  const def = SHEETS.find((d) => d.name === name);
  if (!def) throw new Error(`Unknown sheet ${name}`);
  return def;
}

/** ID columns are locked in Excel: the row id and every foreign-key id. */
export function isIdColumn(c: ColumnDef): boolean {
  return c.name === 'id' || c.ref !== undefined;
}
