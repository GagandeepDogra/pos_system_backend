// The food-selection menu, read from memory (REQ-042, REQ-043, REQ-044,
// REQ-046, REQ-104): active items of active categories, each with its active
// variants, starting price, today's availability and whether it can be ordered.
import { Category, FoodType, Item, Variant } from '@dhaba/shared';
import { fromPaise, toPaise } from '../billing/money';
import { WorkbookStore } from '../storage/workbook-store';
import { isAvailableToday, resetTimeOf, todayOf } from './availability';

export type MenuVariant = Pick<Variant, 'id' | 'name' | 'sort_order'> & { price?: string };

export interface MenuItem {
  id: string;
  category_id: string;
  category_name_en: string;
  category_name_hi: string;
  category_sort_order: number;
  name_en: string;
  name_hi: string;
  short_code: string;
  food_type: FoodType;
  photo_url: string | null;
  kitchen_station: string | null;
  is_active: boolean;
  available_today: boolean;
  row_version: number;
  /** Lowest active variant price; omitted for Kitchen; null when there is no active variant. */
  starting_price?: string | null;
  /** Active variants by sort_order; one variant = add in one tap, several = variant sheet. */
  variants: MenuVariant[];
  /** Available today and has at least one active variant. */
  orderable: boolean;
}

const byOrder = (a: { sort_order: number; name_en?: string; name?: string }, b: typeof a) =>
  a.sort_order - b.sort_order || (a.name_en ?? a.name ?? '').localeCompare(b.name_en ?? b.name ?? '');

/** Case-insensitive match on name_en, name_hi or short_code. */
export function matchesSearch(item: Item, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase();
  return [item.name_en, item.name_hi, item.short_code].some((v) => v.toLocaleLowerCase().includes(needle));
}

export function menuItem(category: Category, item: Item, variants: Variant[], available: boolean, withPrices: boolean): MenuItem {
  const active = variants.filter((v) => v.is_active).sort(byOrder);
  const prices = active.map((v) => toPaise(v.price));
  const out: MenuItem = {
    id: item.id,
    category_id: item.category_id,
    category_name_en: category.name_en,
    category_name_hi: category.name_hi,
    category_sort_order: category.sort_order,
    name_en: item.name_en,
    name_hi: item.name_hi,
    short_code: item.short_code,
    food_type: item.food_type,
    photo_url: item.photo_url,
    kitchen_station: item.kitchen_station,
    is_active: item.is_active,
    available_today: available,
    row_version: item.row_version,
    variants: active.map((v) => (withPrices ? { id: v.id, name: v.name, sort_order: v.sort_order, price: v.price } : { id: v.id, name: v.name, sort_order: v.sort_order })),
    orderable: available && active.length > 0,
  };
  if (withPrices) out.starting_price = prices.length ? fromPaise(Math.min(...prices)) : null;
  return out;
}

/** The active menu at `now`, ordered by category then item; `q` (2+ chars, checked by the caller) narrows it. */
export function readMenu(store: WorkbookStore, now: number, options: { q?: string; withPrices: boolean }): MenuItem[] {
  const resetTime = resetTimeOf(store);
  const today = todayOf(store, now);
  const categories = new Map(store.all('categories').filter((c) => c.is_active).map((c) => [c.id, c]));
  const out: MenuItem[] = [];
  for (const item of store.all('items')) {
    const category = categories.get(item.category_id);
    if (!item.is_active || !category) continue;
    if (options.q !== undefined && !matchesSearch(item, options.q)) continue;
    out.push(menuItem(category, item, store.findBy('variants', 'item_id', item.id), isAvailableToday(item, today, resetTime), options.withPrices));
  }
  const q = options.q?.trim().toLocaleLowerCase();
  return out.sort((a, b) => {
    // An exact short-code hit comes first in a search.
    if (q) {
      const ea = a.short_code.toLocaleLowerCase() === q ? 0 : 1;
      const eb = b.short_code.toLocaleLowerCase() === q ? 0 : 1;
      if (ea !== eb) return ea - eb;
    }
    return a.category_sort_order - b.category_sort_order || a.category_name_en.localeCompare(b.category_name_en) || a.name_en.localeCompare(b.name_en);
  });
}
