// Every bearer route of the API contract, for the permission-matrix test.
// Routes whose feature controller does not exist yet are served by a stub
// carrying the same @Roles(...PERMISSIONS[op]); when a feature ticket adds
// the real controller, pass its operationIds in `implemented` and register it.
import { Controller, HttpCode, RequestMapping, RequestMethod, Type } from '@nestjs/common';
import { Roles } from '../../src/auth/decorators';
import { PERMISSIONS } from '../../src/auth/permissions';

export interface ContractRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  op: string;
}

const r = (method: ContractRoute['method'], path: string, op: string): ContractRoute => ({ method, path, op });

export const CONTRACT_ROUTES: ContractRoute[] = [
  r('POST', 'auth/approvals', 'createApproval'),
  r('PATCH', 'me/language', 'updateMyLanguage'),
  r('GET', 'dashboard', 'getDashboard'),
  r('GET', 'tables', 'listTables'),
  r('POST', 'orders/dine-in', 'openTableSession'),
  r('POST', 'orders/takeaway', 'createTakeaway'),
  r('GET', 'orders/:id', 'getOrder'),
  r('POST', 'orders/:id/kots', 'sendToKitchen'),
  r('GET', 'menu', 'getMenu'),
  r('GET', 'kitchen/kots', 'listKitchenKots'),
  r('PATCH', 'kots/:id/status', 'updateKotStatus'),
  r('PATCH', 'items/:id/availability', 'setItemAvailability'),
  r('POST', 'kitchen/items/:id/out-of-stock', 'markItemOutOfStock'),
  r('POST', 'order-items/:id/cancel', 'cancelOrderItem'),
  r('POST', 'orders/:id/move', 'moveOrder'),
  r('POST', 'orders/:id/merge', 'mergeOrders'),
  r('POST', 'orders/:id/bill', 'printBill'),
  r('POST', 'orders/:id/discount', 'applyDiscount'),
  r('GET', 'bills/open', 'listOpenBills'),
  r('POST', 'orders/:id/payments', 'recordPayment'),
  r('POST', 'payments/:id/void', 'voidPayment'),
  r('POST', 'orders/:id/close-exception', 'closeWithException'),
  r('POST', 'orders/:id/receipt-prints', 'recordReceiptPrint'),
  r('GET', 'takeaways', 'listActiveTakeaways'),
  r('POST', 'takeaways/:id/handover', 'handOverTakeaway'),
  r('POST', 'admin/categories', 'createCategory'),
  r('PATCH', 'admin/categories/:id', 'updateCategory'),
  r('POST', 'admin/items', 'createItem'),
  r('PATCH', 'admin/items/:id', 'updateItem'),
  r('POST', 'admin/items/:id/variants', 'createVariant'),
  r('PATCH', 'admin/variants/:id', 'updateVariant'),
  r('POST', 'admin/variants/:id/price-changes', 'changeVariantPrice'),
  r('POST', 'admin/tables', 'createTable'),
  r('PATCH', 'admin/tables/:id', 'updateTable'),
  r('POST', 'admin/users', 'createUser'),
  r('PATCH', 'admin/users/:id', 'updateUser'),
  r('POST', 'admin/users/:id/pin-reset', 'resetUserPin'),
  r('GET', 'admin/reports/sales', 'getSalesReport'),
  r('GET', 'admin/orders', 'searchOrders'),
  r('GET', 'admin/backups/download', 'downloadBackup'),
  r('POST', 'admin/restores', 'previewRestore'),
  r('POST', 'admin/restores/:id/confirm', 'confirmRestore'),
  r('GET', 'settings', 'getSettings'),
  r('PUT', 'admin/settings', 'updateSettings'),
  r('GET', 'admin/day-close', 'getDayCloseSummary'),
  r('POST', 'admin/day-close', 'closeDay'),
];

/** A controller answering 200 `{stub: op}` on each route not in `implemented`, with the matrix roles. */
export function stubController(implemented: Set<string>): Type {
  class ContractStubController {}
  const proto = ContractStubController.prototype as unknown as Record<string, unknown>;
  for (const route of CONTRACT_ROUTES) {
    if (implemented.has(route.op)) continue;
    proto[route.op] = () => ({ stub: route.op });
    const descriptor = Object.getOwnPropertyDescriptor(proto, route.op)!;
    RequestMapping({ path: route.path, method: RequestMethod[route.method] })(proto, route.op, descriptor);
    HttpCode(200)(proto, route.op, descriptor);
    Roles(...PERMISSIONS[route.op])(proto, route.op, descriptor);
  }
  Controller()(ContractStubController);
  return ContractStubController;
}
