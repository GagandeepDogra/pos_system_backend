import fs from 'fs';
import os from 'os';
import path from 'path';
import { Category, Item, Variant } from '@dhaba/shared';
import { initialData } from '../src/storage/storage.service';
import { WorkbookData } from '../src/storage/workbook-codec';

export const NOW = '2026-11-05T12:00:00.000+05:30';

const audit = { created_at: NOW, created_by: 'SYSTEM', updated_at: NOW, updated_by: 'SYSTEM', row_version: 1 };

export const category: Category = { id: 'CAT-1', name_en: 'Main Course', name_hi: 'मुख्य व्यंजन', sort_order: 1, is_active: true, ...audit };
export const item: Item = {
  id: 'ITM-1', category_id: 'CAT-1', name_en: 'Butter Chicken', name_hi: 'बटर चिकन', short_code: 'BC',
  food_type: 'NON_VEG', photo_url: null, kitchen_station: null, is_active: true, available_today: true, ...audit,
};
export const variant: Variant = { id: 'VAR-1', item_id: 'ITM-1', name: 'Half', price: '220.00', sort_order: 1, is_active: true, ...audit };
export const roti: Item = { ...item, id: 'ITM-2', name_en: 'Tandoori Roti', name_hi: 'तंदूरी रोटी', short_code: 'TR', food_type: 'VEG' };
export const rotiVariant: Variant = { ...variant, id: 'VAR-2', item_id: 'ITM-2', name: 'Plain', price: '20.00' };

/** Initial workbook plus a small menu, one order, KOT and line. */
export function sampleData(): WorkbookData {
  const data = initialData(NOW);
  data.categories.push({ ...category });
  data.items.push({ ...item }, { ...roti });
  data.variants.push({ ...variant }, { ...rotiVariant });
  data.tables.push({ id: 'TBL-1', table_number: 'T1', area: 'Hall', seats: 4, is_active: true, ...audit });
  data.orders.push({
    id: 'ORD-20261105-0001', order_type: 'DINE_IN', business_date: '2026-11-05', table_id: 'TBL-1',
    table_label_snapshot: 'T1', token: null, customer_name: null, customer_phone: null, guest_count: 2,
    status: 'OPEN', bill_no: null, subtotal: '120.00', discount_amount: '0.00', discount_reason: null,
    tax_amount: '0.00', round_off: '0.00', grand_total: '120.00', paid_amount: '0.00', balance_due: '120.00',
    merged_into_order_id: null, handed_over_at: null, client_request_id: 'req-1', ...audit,
  });
  data.kots.push({
    id: 'KOT-20261105-0001', kot_number: 1, business_date: '2026-11-05', order_id: 'ORD-20261105-0001',
    status: 'NEW', idempotency_key: 'kot-key-1', sent_at: NOW, served_at: null, hide_after: null, ...audit,
  });
  data.order_items.push({
    id: 'OI-1', order_id: 'ORD-20261105-0001', kot_id: 'KOT-20261105-0001', variant_id: 'VAR-2',
    item_name_snapshot: 'Tandoori Roti', item_name_hi_snapshot: 'तंदूरी रोटी', variant_name_snapshot: 'Plain',
    food_type_snapshot: 'VEG', unit_price: '20.00', quantity: 6, line_total: '120.00', note: null,
    status: 'ACTIVE', cancel_reason: null, ...audit,
  });
  data.audit_log.push({
    id: 'AUD-1', action: 'CREATE', entity_type: 'orders', entity_id: 'ORD-20261105-0001', user_id: 'SYSTEM',
    approver_id: null, device_id: null, before_json: null, after_json: { status: 'OPEN' }, created_at: NOW,
  });
  return data;
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-api-test-'));
}
