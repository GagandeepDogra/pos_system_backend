// Every enum used by more than one app lives here and nowhere else.
// The backend's workbook schema and the PWA both import these lists.

export const ROLES = ['ADMIN', 'CASHIER', 'KITCHEN'] as const;
export type Role = (typeof ROLES)[number];

export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];

export const FOOD_TYPES = ['VEG', 'NON_VEG'] as const;
export type FoodType = (typeof FOOD_TYPES)[number];

export const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ['OPEN', 'BILLED', 'PAID', 'CLOSED_EXCEPTION', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Table status, derived from the table's OPEN/BILLED order and never stored (REQ-033):
 * no such order = AVAILABLE (green), OPEN = OCCUPIED (red), BILLED = READY_TO_CLOSE (orange).
 */
export const TABLE_STATUSES = ['AVAILABLE', 'OCCUPIED', 'READY_TO_CLOSE'] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const KOT_STATUSES = ['NEW', 'PREPARING', 'READY', 'SERVED', 'CANCELLED'] as const;
export type KotStatus = (typeof KOT_STATUSES)[number];

export const ORDER_ITEM_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['SUCCESS', 'VOIDED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const EXCEPTION_TYPES = [
  'DISCOUNT',
  'BILL_REOPEN',
  'CANCEL_AFTER_START',
  'CLOSE_WITH_BALANCE',
  'PAYMENT_VOID',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/** How a discount is given (REQ-061): a fixed rupee amount or a percent of the subtotal. */
export const DISCOUNT_TYPES = ['FIXED', 'PERCENT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** Reason codes for closing an order with a balance. */
export const CLOSE_REASON_CODES = ['COMPLIMENTARY', 'CUSTOMER_LEFT', 'STAFF_MEAL', 'OTHER'] as const;
export type CloseReasonCode = (typeof CLOSE_REASON_CODES)[number];

export const PRICE_CHANGE_REASONS = ['MARKET_RATE', 'NEW_SEASON', 'CORRECTION', 'OTHER'] as const;
export type PriceChangeReason = (typeof PRICE_CHANGE_REASONS)[number];

/** Why a backups/ snapshot was taken (part of its file name, e.g. snapshot-20261105-143000-auto.xlsx). */
export const SNAPSHOT_REASONS = ['auto', 'day-close', 'pre-restore'] as const;
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];

/**
 * Transaction sheets moved into archive/YYYY-MM.xlsx at month end (REQ-108). Reports read these from
 * the live workbook plus the archive files of the months a range needs.
 */
export const ARCHIVED_SHEETS = ['orders', 'kots', 'order_items', 'payments', 'exceptions', 'audit_log'] as const;
export type ArchivedSheet = (typeof ARCHIVED_SHEETS)[number];

/** The four primary dashboard buttons in 2×2 order (REQ-028); GET /dashboard lists the ones the role may use. */
export const DASHBOARD_BUTTONS = ['DINE_IN', 'TAKEAWAY', 'KITCHEN', 'PAYMENT'] as const;
export type DashboardButton = (typeof DASHBOARD_BUTTONS)[number];

/**
 * Socket.IO events pushed after each committed write (REQ-116). Payloads carry
 * ids and the new state; a reconnecting device refetches the GET endpoints.
 * `app.reload` is sent to every socket after a restore.
 */
export const REALTIME_EVENTS = [
  'kot.created',
  'kot.status_changed',
  'order.updated',
  'table.status_changed',
  'payment.recorded',
  'menu.availability_changed',
  'dashboard.updated',
  'app.reload',
] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];
