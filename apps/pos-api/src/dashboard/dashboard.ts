// Dashboard tiles (REQ-028, REQ-029, REQ-030, REQ-020, REQ-021, REQ-117).
// Counts come from memory; today's sales and the save alert are Admin only.
// The shape is built field by field so a Cashier or Kitchen body never has a
// sales key at all (not even null).
import { DASHBOARD_BUTTONS, DashboardButton, Role } from '@dhaba/shared';
import { fromPaise, toPaise } from '../billing/money';
import { PERMISSIONS } from '../auth/permissions';
import { todayOf } from '../menu/availability';
import { activeOrderForTable } from '../tables/table-status';
import { StorageService } from '../storage/storage.service';

/** Each button opens a screen whose main route needs this operation. */
const BUTTON_OPERATION: Record<DashboardButton, string> = {
  DINE_IN: 'openTableSession',
  TAKEAWAY: 'createTakeaway',
  KITCHEN: 'listKitchenKots',
  PAYMENT: 'listOpenBills',
};

export interface DashboardTiles {
  /** Active tables tile: tables with an OPEN order (status OCCUPIED, as GET /tables?status=OCCUPIED). */
  active_tables: number;
  /** Tables whose bill is printed (READY_TO_CLOSE). */
  ready_to_close_tables: number;
  /** KOTs still NEW or PREPARING. */
  pending_kots: number;
  /** Orders with at least one READY KOT still on the board. */
  ready_orders: number;
  /** Admin only: SUCCESS payments of today's business date, 2-dp string. */
  todays_sales?: string;
}

export interface Dashboard {
  business_date: string;
  role: Role;
  buttons: DashboardButton[];
  tiles: DashboardTiles;
  /** Admin only: 'Saving problem, call owner' while saving fails; null otherwise (REQ-117). */
  alert?: StorageService['saveAlert'];
}

export function dashboardButtons(role: Role): DashboardButton[] {
  return DASHBOARD_BUTTONS.filter((b) => PERMISSIONS[BUTTON_OPERATION[b]].includes(role));
}

export function buildDashboard(storage: StorageService, role: Role, nowMs: number): Dashboard {
  const store = storage.store;
  const today = todayOf(store, nowMs);

  let activeTables = 0;
  let readyToClose = 0;
  for (const t of store.all('tables')) {
    if (!t.is_active) continue;
    const order = activeOrderForTable(store, t.id);
    if (order?.status === 'OPEN') activeTables++;
    else if (order?.status === 'BILLED') readyToClose++;
  }

  let pendingKots = 0;
  const readyOrders = new Set<string>();
  for (const k of store.all('kots')) {
    if (k.status === 'NEW' || k.status === 'PREPARING') pendingKots++;
    else if (k.status === 'READY' && (!k.hide_after || Date.parse(k.hide_after) > nowMs)) readyOrders.add(k.order_id);
  }

  const tiles: DashboardTiles = {
    active_tables: activeTables,
    ready_to_close_tables: readyToClose,
    pending_kots: pendingKots,
    ready_orders: readyOrders.size,
  };
  const body: Dashboard = { business_date: today, role, buttons: dashboardButtons(role), tiles };
  if (role === 'ADMIN') {
    tiles.todays_sales = fromPaise(
      store.all('payments')
        .filter((p) => p.status === 'SUCCESS' && p.business_date === today)
        .reduce((sum, p) => sum + toPaise(p.amount), 0),
    );
    body.alert = storage.saveAlert;
  }
  return body;
}
