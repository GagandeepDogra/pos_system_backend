// Admin tables, staff and settings (REQ-075, REQ-076, REQ-119, REQ-080,
// REQ-025, REQ-120). Every exported function except `adminPinClashes` is a
// synchronous write-queue change. Nothing is deleted: deactivate = is_active
// false. User rows never leave this module with pin_hash (publicUser).
import bcrypt from 'bcryptjs';
import { DiningTable, Language, Role, Setting, User, UserRow } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { deactivatePatch, pinResetPatch, publicUser, unlockPatch } from '../auth/auth.service';
import { USER_COUNTER } from '../auth/first-admin';
import { verifyPin } from '../auth/pin';
import { fromPaise, toPaise } from '../billing/money';
import { ApiError, NotFoundError, RowVersionConflictError } from '../common/errors';
import { diff, nextId } from '../menu/admin-menu';
import { activeOrderForTable } from '../tables/table-status';
import { Tx } from '../storage/write-queue';

/** Counter key of tables.id (TBL-NNNNNN). */
export const TABLE_COUNTER = 'TABLE';
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function auditChange(tx: Tx, entity_type: string, id: string, userId: string, before: object, after: object): void {
  const active = (after as { is_active?: boolean }).is_active;
  const action = active === false ? 'DEACTIVATE' : active === true ? 'REACTIVATE' : 'UPDATE';
  writeAudit(tx, { action, entity_type, entity_id: id, user_id: userId, before_json: before, after_json: after });
}

// ---- tables ----

export interface TableInput {
  table_number: string;
  area?: string | null;
  seats?: number | null;
  is_active?: boolean;
}

function checkTableNumber(tx: Tx, tableNumber: string, selfId: string | null): void {
  // Over active and inactive tables: the sheet's table_number column is unique.
  const clash = tx.all('tables').find((t) => t.id !== selfId && same(t.table_number, tableNumber));
  if (clash) {
    throw new ApiError(409, 'DUPLICATE_TABLE_NUMBER', 'A table with this number already exists.', 'इस नंबर की टेबल पहले से है।', { field: 'table_number', existing_id: clash.id });
  }
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || !v.trim() ? null : v.trim());

function tablesChanged(tx: Tx, table: DiningTable): void {
  tx.emit('table.status_changed', { table_id: table.id, table_number: table.table_number, is_active: table.is_active, source: 'ADMIN' });
  tx.emit('dashboard.updated', {});
}

export function createTable(tx: Tx, input: TableInput, userId: string): DiningTable {
  const table_number = input.table_number.trim();
  checkTableNumber(tx, table_number, null);
  const row = tx.create('tables', {
    id: nextId(tx, 'tables', 'TBL', TABLE_COUNTER), table_number, area: blankToNull(input.area) ?? null, seats: input.seats ?? null, is_active: input.is_active ?? true,
  }, userId);
  writeAudit(tx, { action: 'CREATE', entity_type: 'tables', entity_id: row.id, user_id: userId, after_json: row });
  tablesChanged(tx, row);
  return row;
}

/** Rename, set area/seats, deactivate or reactivate. Past orders keep their table_label_snapshot. */
export function updateTable(tx: Tx, id: string, ifMatch: number, patch: Partial<TableInput>, userId: string): DiningTable {
  const current = tx.expectVersion('tables', id, ifMatch);
  const clean: Partial<DiningTable> = { ...patch, table_number: patch.table_number?.trim(), area: blankToNull(patch.area) };
  if (clean.table_number !== undefined) checkTableNumber(tx, clean.table_number, id);
  if (clean.is_active === false && current.is_active) {
    const open = activeOrderForTable(tx, id);
    if (open) {
      throw new ApiError(409, 'TABLE_HAS_OPEN_ORDER', 'This table has an open order. Close it before removing the table.',
        'इस टेबल का ऑर्डर खुला है। टेबल हटाने से पहले उसे बंद करें।', { order: open });
    }
  }
  const { before, after } = diff(current, clean);
  if (!Object.keys(after).length) return current;
  const row = tx.update('tables', current, after, userId);
  auditChange(tx, 'tables', id, userId, before, after);
  tablesChanged(tx, row);
  return row;
}

// ---- users ----

export class AdminPinClashError extends ApiError {
  constructor() {
    super(409, 'ADMIN_PIN_CLASH', 'Another Admin already uses this PIN. Choose a different PIN.', 'यह PIN किसी और एडमिन का है। दूसरा PIN चुनें।', { field: 'pin' });
  }
}

/**
 * Before the queue (bcrypt is slow): the pin_hash values of the active Admins
 * (other than `exceptUserId`) checked against `pin`, and whether one matched.
 * Inside the queue `assertNoAdminPinClash` re-checks only Admins added or
 * changed since, so the rule holds even if two requests race.
 */
export async function adminPinClashes(users: UserRow[], pin: string, exceptUserId?: string): Promise<{ checked: Set<string>; clash: boolean }> {
  const checked = new Set<string>();
  for (const u of users) {
    if (u.role !== 'ADMIN' || !u.is_active || u.id === exceptUserId) continue;
    if (await verifyPin(pin, u.pin_hash)) return { checked, clash: true };
    checked.add(u.pin_hash);
  }
  return { checked, clash: false };
}

function assertNoAdminPinClash(tx: Tx, pin: string, checked: Set<string>, exceptUserId?: string): void {
  for (const u of tx.all('users')) {
    if (u.role !== 'ADMIN' || !u.is_active || u.id === exceptUserId || checked.has(u.pin_hash)) continue;
    if (bcrypt.compareSync(pin, u.pin_hash)) throw new AdminPinClashError();
  }
}

function checkDisplayName(tx: Tx, name: string, selfId: string | null): void {
  const clash = tx.all('users').find((u) => u.id !== selfId && u.is_active && same(u.display_name, name));
  if (clash) {
    throw new ApiError(409, 'DUPLICATE_NAME', 'An active staff member already has this name.', 'इस नाम का स्टाफ पहले से है।', { field: 'display_name', existing_id: clash.id });
  }
}

/** Users' 409 carries the public user, never the row (pin_hash). */
function expectUser(tx: Tx, id: string, ifMatch: number): UserRow {
  const row = tx.get('users', id);
  if (!row) throw new NotFoundError('users', id);
  if (row.row_version !== ifMatch) throw new RowVersionConflictError(publicUser(row));
  return row;
}

function assertKeepsAnAdmin(tx: Tx, row: UserRow, next: { role: Role; is_active: boolean }): void {
  if (row.role !== 'ADMIN' || !row.is_active || (next.role === 'ADMIN' && next.is_active)) return;
  if (!tx.all('users').some((u) => u.id !== row.id && u.role === 'ADMIN' && u.is_active)) {
    throw new ApiError(409, 'LAST_ADMIN', 'This is the only active Admin. Add another Admin first.', 'यह अकेला सक्रिय एडमिन है। पहले दूसरा एडमिन जोड़ें।', { user_id: row.id });
  }
}

const auditUser = (u: Partial<UserRow>) => {
  const { pin_hash: _omit, ...rest } = u;
  return rest;
};

export interface CreateUserInput {
  display_name: string;
  role: Role;
  language?: Language;
  is_active?: boolean;
}

/** `pinHash` = hashPin(pin) and `checked` = adminPinClashes(...).checked, both computed before the queue. */
export function createUser(tx: Tx, input: CreateUserInput, pin: string, pinHash: string, checked: Set<string>, userId: string): User {
  const display_name = input.display_name.trim();
  const is_active = input.is_active ?? true;
  if (is_active) checkDisplayName(tx, display_name, null);
  if (input.role === 'ADMIN' && is_active) assertNoAdminPinClash(tx, pin, checked);
  const row = tx.create('users', {
    id: nextId(tx, 'users', 'USR', USER_COUNTER), display_name, role: input.role, pin_hash: pinHash, language: input.language ?? 'en',
    is_active, failed_pin_count: 0, locked_until: null, token_version: 1,
  }, userId);
  writeAudit(tx, { action: 'CREATE', entity_type: 'users', entity_id: row.id, user_id: userId, after_json: auditUser(row) });
  return publicUser(row);
}

export interface UpdateUserInput {
  display_name?: string;
  role?: Role;
  language?: Language;
  is_active?: boolean;
  /** Clears locked_until and failed_pin_count (REQ-025). */
  unlock?: boolean;
}

/**
 * Change name, role or language, unlock, deactivate (token_version bumped:
 * the user's tokens get 401 on the next request, REQ-120) or reactivate.
 * The last active Admin cannot be deactivated or demoted (409 LAST_ADMIN).
 */
export function updateUser(tx: Tx, id: string, ifMatch: number, input: UpdateUserInput, userId: string): User {
  const current = expectUser(tx, id, ifMatch);
  const patch: Partial<UserRow> = { display_name: input.display_name?.trim(), role: input.role, language: input.language };
  const nextActive = input.is_active ?? current.is_active;
  if (input.is_active === false && current.is_active) Object.assign(patch, deactivatePatch(current));
  if (input.is_active === true && !current.is_active) patch.is_active = true;
  if (input.unlock && (current.failed_pin_count !== 0 || current.locked_until !== null)) Object.assign(patch, unlockPatch());
  if (nextActive && (patch.display_name !== undefined || patch.is_active === true)) checkDisplayName(tx, patch.display_name ?? current.display_name, id);
  assertKeepsAnAdmin(tx, current, { role: input.role ?? current.role, is_active: nextActive });
  const { before, after } = diff(current, patch);
  if (!Object.keys(after).length) return publicUser(current);
  const row = tx.update('users', current, after, userId);
  const unlockOnly = Object.keys(after).every((k) => k === 'failed_pin_count' || k === 'locked_until');
  const action = after.is_active === false ? 'DEACTIVATE' : after.is_active === true ? 'REACTIVATE' : unlockOnly ? 'UNLOCK' : 'UPDATE';
  writeAudit(tx, { action, entity_type: 'users', entity_id: id, user_id: userId, before_json: auditUser(before), after_json: auditUser(after) });
  return publicUser(row);
}

/** Forced PIN reset: new hash, token_version bumped (old tokens 401), lock cleared; the old PIN stops working (REQ-119). */
export function resetUserPin(tx: Tx, id: string, ifMatch: number, pin: string, pinHash: string, checked: Set<string>, userId: string): User {
  const current = expectUser(tx, id, ifMatch);
  if (current.role === 'ADMIN' && current.is_active) assertNoAdminPinClash(tx, pin, checked, id);
  const row = tx.update('users', current, pinResetPatch(current, pinHash), userId);
  writeAudit(tx, {
    action: 'PIN_RESET', entity_type: 'users', entity_id: id, user_id: userId,
    before_json: { token_version: current.token_version }, after_json: { token_version: row.token_version },
  });
  return publicUser(row);
}

// ---- settings ----

export type SettingsInput = Pick<Setting,
  'dhaba_name' | 'address' | 'phone' | 'gst_number' | 'gst_rate_percent' | 'receipt_footer' | 'token_reset_time' | 'shift_end_time' | 'late_kot_minutes' | 'discount_limit_amount' | 'kitchen_print_enabled'>;

const badSetting = (field: string, en: string, hi: string) => new ApiError(400, 'INVALID_SETTING', en, hi, { field });

/** 2-dp money/percent text, or a 400 INVALID_SETTING. */
function decimal(value: string, field: string, max?: number): string {
  let paise = NaN;
  try {
    paise = toPaise(value);
  } catch {
    // not a number with up to 2 decimals
  }
  if (!Number.isFinite(paise) || paise < 0 || (max !== undefined && paise > max * 100)) {
    throw badSetting(field, `${field} must be a number${max !== undefined ? ` from 0 to ${max}` : ' of 0 or more'} with up to 2 decimals.`, `${field} सही संख्या नहीं है।`);
  }
  return fromPaise(paise);
}

export function currentSettings(reader: { all: Tx['all'] }): Setting {
  const row = reader.all('settings')[0];
  if (!row) throw new NotFoundError('settings', 'SETTINGS');
  return row;
}

/** PUT semantics: the whole row is replaced; an omitted GST number / rate / shift end becomes null. */
export function updateSettings(tx: Tx, ifMatch: number, input: SettingsInput, userId: string): Setting {
  const current = currentSettings(tx);
  tx.expectVersion('settings', current.id, ifMatch);
  const next: Partial<Setting> = {
    dhaba_name: input.dhaba_name.trim(),
    address: input.address.trim(),
    phone: input.phone.trim(),
    gst_number: blankToNull(input.gst_number) ?? null,
    gst_rate_percent: input.gst_rate_percent === null || input.gst_rate_percent === undefined || input.gst_rate_percent === '' ? null : decimal(input.gst_rate_percent, 'gst_rate_percent', 100),
    receipt_footer: input.receipt_footer.trim(),
    token_reset_time: input.token_reset_time,
    shift_end_time: blankToNull(input.shift_end_time) ?? null,
    late_kot_minutes: input.late_kot_minutes,
    discount_limit_amount: decimal(input.discount_limit_amount, 'discount_limit_amount'),
    kitchen_print_enabled: input.kitchen_print_enabled,
  };
  const { before, after } = diff(current, next);
  if (!Object.keys(after).length) return current;
  const row = tx.update('settings', current, after, userId);
  writeAudit(tx, { action: 'UPDATE', entity_type: 'settings', entity_id: row.id, user_id: userId, before_json: before, after_json: after });
  return row;
}
