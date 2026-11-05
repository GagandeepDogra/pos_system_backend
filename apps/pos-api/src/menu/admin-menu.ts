// Admin menu management (REQ-070..073, REQ-082): category, item and variant
// create/edit/deactivate, and the price change with its history row. Every
// function is a write-queue change: uniqueness is re-checked inside the queue,
// nothing is ever deleted (deactivate = is_active false), and a variant's price
// changes only through `changeVariantPrice`, which writes the variant, the
// PriceChange row and the audit row in one journal entry. Existing OrderItems
// keep their unit_price snapshot, so only new lines use the new price.
import { Category, FoodType, Item, PriceChange, PriceChangeReason, SheetName, Variant } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { fromPaise, toPaise } from '../billing/money';
import { ApiError, NotFoundError } from '../common/errors';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Next free PFX-NNNNNN id from a global counter (skips ids already in the sheet, e.g. seeded rows). */
export function nextId(tx: Tx, sheet: SheetName, prefix: string, counter: string): string {
  for (;;) {
    const id = idFormats.seq(prefix, tx.nextCounter(counterKeys.seq(counter)));
    if (!tx.get(sheet, id)) return id;
  }
}

function menuChanged(tx: Tx, payload: Record<string, unknown>): void {
  // Menus refetch on this event (REQ-042).
  tx.emit('menu.availability_changed', { source: 'ADMIN', ...payload });
}

/** Price as a 2-dp string; 400 PRICE_NOT_POSITIVE when ≤ 0. */
export function positivePrice(value: string | number, field = 'price'): string {
  let paise = NaN;
  try {
    paise = toPaise(value);
  } catch {
    // not a rupee amount with up to 2 decimals
  }
  if (!Number.isFinite(paise) || paise <= 0) {
    throw new ApiError(400, 'PRICE_NOT_POSITIVE', 'Price must be more than ₹0.', 'कीमत ₹0 से ज़्यादा होनी चाहिए।', { field });
  }
  return fromPaise(paise);
}

/** 400 SHORT_CODE_LENGTH unless the trimmed code has 2–5 characters. */
export function checkShortCode(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length < 2 || trimmed.length > 5) {
    throw new ApiError(400, 'SHORT_CODE_LENGTH', 'Short code must be 2 to 5 characters.', 'शॉर्ट कोड 2 से 5 अक्षर का होना चाहिए।', { field: 'short_code', min: 2, max: 5 });
  }
  return trimmed;
}

const duplicate = (code: string, en: string, hi: string, details: Record<string, unknown>) => new ApiError(409, code, en, hi, details);

function checkCategoryName(tx: Tx, name: string, selfId: string | null): void {
  const clash = tx.all('categories').find((c) => c.id !== selfId && same(c.name_en, name));
  if (clash) throw duplicate('DUPLICATE_NAME', 'A category with this name already exists.', 'इस नाम की कैटेगरी पहले से है।', { field: 'name_en', existing_id: clash.id });
}

function checkItemName(tx: Tx, categoryId: string, name: string, selfId: string | null): void {
  const clash = tx.all('items').find((i) => i.id !== selfId && i.category_id === categoryId && same(i.name_en, name));
  if (clash) throw duplicate('DUPLICATE_NAME', 'An item with this name already exists in the category.', 'इस कैटेगरी में इस नाम का आइटम पहले से है।', { field: 'name_en', existing_id: clash.id });
}

function checkShortCodeFree(tx: Tx, code: string, selfId: string | null): void {
  const clash = tx.all('items').find((i) => i.id !== selfId && same(i.short_code, code));
  if (clash) throw duplicate('DUPLICATE_SHORT_CODE', 'Another item already uses this short code.', 'यह शॉर्ट कोड किसी और आइटम का है।', { field: 'short_code', existing_id: clash.id });
}

function checkVariantName(tx: Tx, itemId: string, name: string, selfId: string | null): void {
  const clash = tx.all('variants').find((v) => v.id !== selfId && v.item_id === itemId && same(v.name, name));
  if (clash) throw duplicate('DUPLICATE_NAME', 'This item already has a variant with this name.', 'इस आइटम में इस नाम का वेरिएंट पहले से है।', { field: 'name', existing_id: clash.id });
}

function category(tx: Tx, id: string): Category {
  const row = tx.get('categories', id);
  if (!row) throw new NotFoundError('categories', id);
  return row;
}

/** Only the fields that actually change, for audit before/after. */
export function diff<T extends object>(row: T, patch: Partial<T>): { before: Partial<T>; after: Partial<T> } {
  const before: Partial<T> = {};
  const after: Partial<T> = {};
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] === undefined || patch[key] === row[key]) continue;
    before[key] = row[key];
    after[key] = patch[key];
  }
  return { before, after };
}

function auditUpdate(tx: Tx, entity_type: string, id: string, userId: string, before: object, after: object): void {
  const deactivated = (after as { is_active?: boolean }).is_active;
  const action = deactivated === false ? 'DEACTIVATE' : deactivated === true ? 'REACTIVATE' : 'UPDATE';
  writeAudit(tx, { action, entity_type, entity_id: id, user_id: userId, before_json: before, after_json: after });
}

// ---- categories ----

export interface CategoryInput {
  name_en: string;
  name_hi: string;
  sort_order?: number;
  is_active?: boolean;
}

export function createCategory(tx: Tx, input: CategoryInput, userId: string): Category {
  const name_en = input.name_en.trim();
  checkCategoryName(tx, name_en, null);
  const sort_order = input.sort_order ?? Math.max(0, ...tx.all('categories').map((c) => c.sort_order)) + 1;
  const row = tx.create('categories', { id: nextId(tx, 'categories', 'CAT', 'CATEGORY'), name_en, name_hi: input.name_hi.trim(), sort_order, is_active: input.is_active ?? true }, userId);
  writeAudit(tx, { action: 'CREATE', entity_type: 'categories', entity_id: row.id, user_id: userId, after_json: row });
  menuChanged(tx, { category_id: row.id });
  return row;
}

export function updateCategory(tx: Tx, id: string, ifMatch: number, patch: Partial<CategoryInput>, userId: string): Category {
  const current = tx.expectVersion('categories', id, ifMatch);
  const clean: Partial<Category> = { ...patch, name_en: patch.name_en?.trim(), name_hi: patch.name_hi?.trim() };
  if (clean.name_en !== undefined) checkCategoryName(tx, clean.name_en, id);
  const { before, after } = diff(current, clean);
  if (!Object.keys(after).length) return current;
  const row = tx.update('categories', current, after, userId);
  auditUpdate(tx, 'categories', id, userId, before, after);
  // Deactivating hides the category's items from the menu; reactivating restores them (REQ-070).
  menuChanged(tx, { category_id: id, is_active: row.is_active });
  return row;
}

// ---- items ----

export interface ItemInput {
  category_id: string;
  name_en: string;
  name_hi: string;
  short_code: string;
  food_type: FoodType;
  photo_url?: string | null;
  kitchen_station?: string | null;
  is_active?: boolean;
}

const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v === null || !v.trim() ? null : v.trim());

export function createItem(tx: Tx, input: ItemInput, userId: string): Item {
  const short_code = checkShortCode(input.short_code);
  const name_en = input.name_en.trim();
  category(tx, input.category_id);
  checkItemName(tx, input.category_id, name_en, null);
  checkShortCodeFree(tx, short_code, null);
  const row = tx.create('items', {
    id: nextId(tx, 'items', 'ITM', 'ITEM'),
    category_id: input.category_id,
    name_en,
    name_hi: input.name_hi.trim(),
    short_code,
    food_type: input.food_type,
    photo_url: blankToNull(input.photo_url) ?? null,
    kitchen_station: blankToNull(input.kitchen_station) ?? null,
    is_active: input.is_active ?? true,
    available_today: true,
  }, userId);
  writeAudit(tx, { action: 'CREATE', entity_type: 'items', entity_id: row.id, user_id: userId, after_json: row });
  menuChanged(tx, { item_id: row.id });
  return row;
}

export function updateItem(tx: Tx, id: string, ifMatch: number, patch: Partial<ItemInput>, userId: string): Item {
  const current = tx.expectVersion('items', id, ifMatch);
  const clean: Partial<Item> = {
    ...patch,
    name_en: patch.name_en?.trim(),
    name_hi: patch.name_hi?.trim(),
    short_code: patch.short_code === undefined ? undefined : checkShortCode(patch.short_code),
    photo_url: blankToNull(patch.photo_url),
    kitchen_station: blankToNull(patch.kitchen_station),
  };
  if (clean.category_id !== undefined) category(tx, clean.category_id);
  const categoryId = clean.category_id ?? current.category_id;
  if (clean.name_en !== undefined || clean.category_id !== undefined) checkItemName(tx, categoryId, clean.name_en ?? current.name_en, id);
  if (clean.short_code !== undefined) checkShortCodeFree(tx, clean.short_code, id);
  const { before, after } = diff(current, clean);
  if (!Object.keys(after).length) return current;
  const row = tx.update('items', current, after, userId);
  auditUpdate(tx, 'items', id, userId, before, after);
  menuChanged(tx, { item_id: id, is_active: row.is_active });
  return row;
}

// ---- variants ----

export interface VariantInput {
  name: string;
  price: string;
  sort_order?: number;
  is_active?: boolean;
}

export function createVariant(tx: Tx, itemId: string, input: VariantInput, userId: string): Variant {
  if (!tx.get('items', itemId)) throw new NotFoundError('items', itemId);
  const price = positivePrice(input.price);
  const name = input.name.trim();
  checkVariantName(tx, itemId, name, null);
  const siblings = tx.findBy('variants', 'item_id', itemId);
  const sort_order = input.sort_order ?? Math.max(0, ...siblings.map((v) => v.sort_order)) + 1;
  const row = tx.create('variants', { id: nextId(tx, 'variants', 'VAR', 'VARIANT'), item_id: itemId, name, price, sort_order, is_active: input.is_active ?? true }, userId);
  writeAudit(tx, { action: 'CREATE', entity_type: 'variants', entity_id: row.id, user_id: userId, after_json: row });
  menuChanged(tx, { item_id: itemId, variant_id: row.id });
  return row;
}

/** Rename, reorder or (de)activate. `price` is never part of the patch (REQ-072). */
export function updateVariant(tx: Tx, id: string, ifMatch: number, patch: Partial<Omit<VariantInput, 'price'>>, userId: string): Variant {
  const current = tx.expectVersion('variants', id, ifMatch);
  const clean: Partial<Variant> = { name: patch.name?.trim(), sort_order: patch.sort_order, is_active: patch.is_active };
  if (clean.name !== undefined) checkVariantName(tx, current.item_id, clean.name, id);
  const { before, after } = diff(current, clean);
  if (!Object.keys(after).length) return current;
  const row = tx.update('variants', current, after, userId);
  auditUpdate(tx, 'variants', id, userId, before, after);
  menuChanged(tx, { item_id: row.item_id, variant_id: id, is_active: row.is_active });
  return row;
}

export interface PriceChangeInput {
  new_price: string;
  reason: PriceChangeReason;
}

/**
 * The only price path (REQ-073): variant price + PriceChange row + PRICE_CHANGE
 * audit commit together in this one change (one journal entry). OrderItems are
 * never touched — their unit_price is the snapshot taken when sent.
 */
export function changeVariantPrice(tx: Tx, variantId: string, ifMatch: number, input: PriceChangeInput, userId: string): PriceChange {
  const current = tx.expectVersion('variants', variantId, ifMatch);
  const new_price = positivePrice(input.new_price, 'new_price');
  const old_price = fromPaise(toPaise(current.price));
  if (new_price === old_price) {
    throw new ApiError(422, 'PRICE_UNCHANGED', 'The new price is the same as the old price.', 'नई कीमत पुरानी कीमत जैसी ही है।', { old_price, new_price });
  }
  const variant = tx.update('variants', current, { price: new_price }, userId);
  const change = tx.insert('price_changes', {
    id: nextId(tx, 'price_changes', 'PRC', 'PRICE_CHANGE'),
    variant_id: variantId,
    old_price,
    new_price,
    reason: input.reason,
    changed_by: userId,
    created_at: tx.now,
  });
  writeAudit(tx, {
    action: 'PRICE_CHANGE',
    entity_type: 'variants',
    entity_id: variantId,
    user_id: userId,
    before_json: { price: old_price },
    after_json: { price: new_price, reason: input.reason, price_change_id: change.id },
  });
  menuChanged(tx, { item_id: variant.item_id, variant_id: variantId, price_changed: true });
  return change;
}
