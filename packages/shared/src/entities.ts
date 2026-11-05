// Row shapes of the 15 workbook sheets, shared by the API and the PWA.
// Money is a decimal string with 2 places ("120.00"); timestamps are ISO 8601
// with a +05:30 offset; dates are YYYY-MM-DD.
import type {
  ExceptionType,
  FoodType,
  KotStatus,
  Language,
  OrderItemStatus,
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  PriceChangeReason,
  Role,
} from './enums';

export type Decimal = string;
export type Timestamp = string;
export type IsoDate = string;

export interface AuditColumns {
  created_at: Timestamp;
  created_by: string;
  updated_at: Timestamp;
  updated_by: string;
  row_version: number;
}

export interface Meta {
  id: string;
  schema_version: number;
  last_journal_seq: number;
  updated_at: Timestamp;
}

export interface Counter {
  id: string;
  counter_key: string;
  next_value: number;
  updated_at: Timestamp;
  row_version: number;
}

export interface Setting extends AuditColumns {
  id: string;
  dhaba_name: string;
  address: string;
  phone: string;
  gst_number: string | null;
  gst_rate_percent: Decimal | null;
  receipt_footer: string;
  token_reset_time: string;
  shift_end_time: string | null;
  late_kot_minutes: number;
  discount_limit_amount: Decimal;
  kitchen_print_enabled: boolean;
}

/** Stored user row. pin_hash must never leave the server. */
export interface UserRow extends AuditColumns {
  id: string;
  display_name: string;
  role: Role;
  pin_hash: string;
  language: Language;
  is_active: boolean;
  failed_pin_count: number;
  locked_until: Timestamp | null;
  token_version: number;
}

/** User as returned by the API. */
export type User = Omit<UserRow, 'pin_hash'>;

export interface DiningTable extends AuditColumns {
  id: string;
  table_number: string;
  area: string | null;
  seats: number | null;
  is_active: boolean;
}

export interface Category extends AuditColumns {
  id: string;
  name_en: string;
  name_hi: string;
  sort_order: number;
  is_active: boolean;
}

export interface Item extends AuditColumns {
  id: string;
  category_id: string;
  name_en: string;
  name_hi: string;
  short_code: string;
  food_type: FoodType;
  photo_url: string | null;
  kitchen_station: string | null;
  is_active: boolean;
  available_today: boolean;
}

export interface Variant extends AuditColumns {
  id: string;
  item_id: string;
  name: string;
  price: Decimal;
  sort_order: number;
  is_active: boolean;
}

export interface Order extends AuditColumns {
  id: string;
  order_type: OrderType;
  business_date: IsoDate;
  table_id: string | null;
  table_label_snapshot: string | null;
  token: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  guest_count: number | null;
  status: OrderStatus;
  bill_no: string | null;
  subtotal: Decimal;
  discount_amount: Decimal;
  discount_reason: string | null;
  tax_amount: Decimal;
  round_off: Decimal;
  grand_total: Decimal;
  paid_amount: Decimal;
  balance_due: Decimal;
  merged_into_order_id: string | null;
  handed_over_at: Timestamp | null;
  client_request_id: string;
}

export interface Kot extends AuditColumns {
  id: string;
  kot_number: number;
  business_date: IsoDate;
  order_id: string;
  status: KotStatus;
  idempotency_key: string;
  sent_at: Timestamp;
  served_at: Timestamp | null;
  hide_after: Timestamp | null;
}

export interface OrderItem extends AuditColumns {
  id: string;
  order_id: string;
  kot_id: string;
  variant_id: string;
  item_name_snapshot: string;
  item_name_hi_snapshot: string;
  variant_name_snapshot: string;
  food_type_snapshot: FoodType;
  unit_price: Decimal;
  quantity: number;
  line_total: Decimal;
  note: string | null;
  status: OrderItemStatus;
  cancel_reason: string | null;
}

export interface Payment extends AuditColumns {
  id: string;
  order_id: string;
  business_date: IsoDate;
  method: PaymentMethod;
  amount: Decimal;
  tendered_amount: Decimal | null;
  upi_ref: string | null;
  status: PaymentStatus;
  void_reason: string | null;
  voided_by: string | null;
  idempotency_key: string;
}

export interface OrderException {
  id: string;
  order_id: string;
  exception_type: ExceptionType;
  reason_code: string;
  reason_text: string | null;
  amount: Decimal | null;
  requested_by: string;
  approved_by: string | null;
  created_at: Timestamp;
}

export interface PriceChange {
  id: string;
  variant_id: string;
  old_price: Decimal;
  new_price: Decimal;
  reason: PriceChangeReason;
  changed_by: string;
  created_at: Timestamp;
}

export interface AuditLog {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  approver_id: string | null;
  device_id: string | null;
  before_json: unknown | null;
  after_json: unknown | null;
  created_at: Timestamp;
}

/** Sheet name → row type, for the 15 worksheets of the live workbook. */
export interface WorkbookRows {
  meta: Meta;
  counters: Counter;
  settings: Setting;
  users: UserRow;
  tables: DiningTable;
  categories: Category;
  items: Item;
  variants: Variant;
  orders: Order;
  kots: Kot;
  order_items: OrderItem;
  payments: Payment;
  exceptions: OrderException;
  price_changes: PriceChange;
  audit_log: AuditLog;
}

export type SheetName = keyof WorkbookRows;
