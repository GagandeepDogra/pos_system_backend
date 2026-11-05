// The role matrix of every bearer route in the API contract (REQ-018,
// REQ-019, REQ-020, REQ-021). Feature controllers use it as
// `@Roles(...PERMISSIONS.recordPayment)` so the matrix test and the routes
// agree. Admin-only actions a cashier may do with an Admin PIN (void, close
// with balance, cancel after start, discount above the limit) are allowed for
// CASHIER here; the handler then requires an X-Approval-Token.
import { ROLES, Role } from '@dhaba/shared';

const [ADMIN, CASHIER, KITCHEN] = ROLES;
const ALL: Role[] = [...ROLES];
const COUNTER: Role[] = [ADMIN, CASHIER];
const ADMIN_ONLY: Role[] = [ADMIN];

/** operationId → roles allowed to call it. Routes with no auth (health, staff, login) are not listed. */
export const PERMISSIONS: Record<string, Role[]> = {
  createApproval: ALL,
  updateMyLanguage: ALL,
  getDashboard: ALL,
  listTables: ALL,
  openTableSession: COUNTER,
  createTakeaway: COUNTER,
  getOrder: COUNTER,
  sendToKitchen: COUNTER,
  getMenu: ALL,
  listKitchenKots: ALL,
  updateKotStatus: ALL,
  setItemAvailability: ALL,
  markItemOutOfStock: [ADMIN, KITCHEN],
  cancelOrderItem: COUNTER,
  moveOrder: COUNTER,
  mergeOrders: COUNTER,
  printBill: COUNTER,
  applyDiscount: COUNTER,
  listOpenBills: COUNTER,
  recordPayment: COUNTER,
  voidPayment: COUNTER,
  closeWithException: COUNTER,
  recordReceiptPrint: COUNTER,
  listActiveTakeaways: COUNTER,
  handOverTakeaway: COUNTER,
  createCategory: ADMIN_ONLY,
  updateCategory: ADMIN_ONLY,
  createItem: ADMIN_ONLY,
  updateItem: ADMIN_ONLY,
  createVariant: ADMIN_ONLY,
  updateVariant: ADMIN_ONLY,
  changeVariantPrice: ADMIN_ONLY,
  createTable: ADMIN_ONLY,
  updateTable: ADMIN_ONLY,
  createUser: ADMIN_ONLY,
  updateUser: ADMIN_ONLY,
  resetUserPin: ADMIN_ONLY,
  getSalesReport: ADMIN_ONLY,
  searchOrders: ADMIN_ONLY,
  downloadBackup: ADMIN_ONLY,
  previewRestore: ADMIN_ONLY,
  confirmRestore: ADMIN_ONLY,
  getSettings: ALL,
  updateSettings: ADMIN_ONLY,
  getDayCloseSummary: ADMIN_ONLY,
  closeDay: ADMIN_ONLY,
};
