// Builds an order line with the menu values copied at the moment of ordering.
// Later menu edits never touch these snapshot columns, so old bills and reports
// stay as they were.
import { Item, OrderItem, Variant } from '@dhaba/shared';
import { lineTotal } from './money';

export interface NewLineInput {
  id: string;
  order_id: string;
  kot_id: string;
  quantity: number;
  note: string | null;
  user_id: string;
  now: string;
}

export function buildOrderLine(item: Item, variant: Variant, input: NewLineInput): OrderItem {
  if (variant.item_id !== item.id) throw new Error(`Variant ${variant.id} does not belong to item ${item.id}`);
  return {
    id: input.id,
    order_id: input.order_id,
    kot_id: input.kot_id,
    variant_id: variant.id,
    item_name_snapshot: item.name_en,
    item_name_hi_snapshot: item.name_hi,
    variant_name_snapshot: variant.name,
    food_type_snapshot: item.food_type,
    unit_price: variant.price,
    quantity: input.quantity,
    line_total: lineTotal(variant.price, input.quantity),
    note: input.note,
    status: 'ACTIVE',
    cancel_reason: null,
    created_at: input.now,
    created_by: input.user_id,
    updated_at: input.now,
    updated_by: input.user_id,
    row_version: 1,
  };
}
