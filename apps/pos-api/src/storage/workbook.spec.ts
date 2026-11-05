import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { NOW, sampleData, tempDir } from '../../test/fixtures';
import { SHEET_NAMES, sheetDef } from './schema';
import { WorkbookValidationError, buildWorkbook, emptyData, parseWorkbook } from './workbook-codec';
import { readWorkbookFile, writeWorkbookFile } from './workbook-file';

const PASSWORD = 'secret';

async function saveAndReopen(data = sampleData()): Promise<{ file: string; wb: ExcelJS.Workbook }> {
  const file = path.join(tempDir(), 'live.xlsx');
  await writeWorkbookFile(file, data, PASSWORD);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return { file, wb };
}

async function rewrite(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const copy = new ExcelJS.Workbook();
  await copy.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()) as unknown as ArrayBuffer);
  return copy;
}

describe('live workbook file (REQ-002, REQ-099, REQ-103)', () => {
  it('REQ-002: the saved workbook has exactly the 15 schema worksheets', async () => {
    const { wb } = await saveAndReopen();
    expect(wb.worksheets.map((w) => w.name)).toEqual([...SHEET_NAMES]);
    expect(wb.worksheets).toHaveLength(15);
  });

  it('REQ-002: round-trips every row through the file unchanged', async () => {
    const data = sampleData();
    const { file } = await saveAndReopen(data);
    expect(await readWorkbookFile(file)).toEqual(data);
  });

  it('REQ-107: saves via temp file and rename, leaving no temp file behind', async () => {
    const { file } = await saveAndReopen();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['live.xlsx']);
  });

  it('REQ-103: header rows are bold and frozen', async () => {
    const { wb } = await saveAndReopen();
    for (const ws of wb.worksheets) {
      expect(ws.getRow(1).getCell(1).font?.bold).toBe(true);
      expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    }
  });

  it('REQ-103: sheets are password-protected and ID columns are locked, other columns editable', async () => {
    const { wb } = await saveAndReopen();
    const ws = wb.getWorksheet('order_items')!;
    const protection = (ws as unknown as { sheetProtection: Record<string, unknown> }).sheetProtection;
    expect(protection.sheet).toBe(true);
    expect(protection.hashValue).toBeTruthy();
    const cols = sheetDef('order_items').columns.map((c) => c.name);
    const cell = (name: string) => ws.getRow(2).getCell(cols.indexOf(name) + 1);
    expect(cell('id').protection?.locked).not.toBe(false);
    expect(cell('order_id').protection?.locked).not.toBe(false);
    expect(cell('note').protection?.locked).toBe(false);
    expect(cell('quantity').protection?.locked).toBe(false);
  });

  it('REQ-103: enum columns carry a stop-style dropdown validation', async () => {
    const { wb } = await saveAndReopen();
    const ws = wb.getWorksheet('orders')!;
    const statusCol = sheetDef('orders').columns.findIndex((c) => c.name === 'status') + 1;
    const dv = ws.getRow(2).getCell(statusCol).dataValidation;
    expect(dv).toMatchObject({ type: 'list', showErrorMessage: true, errorStyle: 'stop' });
    expect(dv.formulae[0]).toBe('"OPEN,BILLED,PAID,CLOSED_EXCEPTION,CANCELLED"');
    // A future row typed by hand is covered too.
    expect(ws.getRow(500).getCell(statusCol).dataValidation).toMatchObject({ type: 'list' });
  });

  it('REQ-110: a hand-edited invalid status is rejected on load', async () => {
    const { wb } = await saveAndReopen();
    const ws = wb.getWorksheet('orders')!;
    const statusCol = sheetDef('orders').columns.findIndex((c) => c.name === 'status') + 1;
    ws.getRow(2).getCell(statusCol).value = 'DONE';
    expect(() => parseWorkbook(wb)).toThrow(WorkbookValidationError);
    expect(() => parseWorkbook(wb)).toThrow(/status has invalid value "DONE"/);
  });

  it('REQ-010: a workbook with a sheet outside the 15 listed fails the schema check', async () => {
    const { wb } = await saveAndReopen();
    wb.addWorksheet('einvoice');
    expect(() => parseWorkbook(wb)).toThrow(/unexpected sheet "einvoice"/);
  });

  it('REQ-110: a missing sheet or column fails the schema check', async () => {
    const { wb } = await saveAndReopen();
    wb.removeWorksheet(wb.getWorksheet('audit_log')!.id);
    expect(() => parseWorkbook(wb)).toThrow(/missing sheet "audit_log"/);

    const second = await saveAndReopen();
    second.wb.getWorksheet('items')!.getRow(1).getCell(2).value = 'cat';
    expect(() => parseWorkbook(second.wb)).toThrow(/items: missing columns category_id/);
  });

  it('REQ-110: rejects duplicate ids, broken references, bad types and a wrong schema version', async () => {
    const dup = sampleData();
    dup.items.push({ ...dup.items[0], short_code: 'XX' });
    await expect(saveAndReopen(dup).then(({ wb }) => parseWorkbook(wb))).rejects.toThrow(/duplicate id "ITM-1"/);

    const broken = sampleData();
    broken.variants[0].item_id = 'NOPE';
    await expect(saveAndReopen(broken).then(({ wb }) => parseWorkbook(wb))).rejects.toThrow(/item_id "NOPE" does not exist/);

    const version = sampleData();
    version.meta[0].schema_version = 99;
    await expect(saveAndReopen(version).then(({ wb }) => parseWorkbook(wb))).rejects.toThrow(/schema_version 99/);

    const { wb } = await saveAndReopen();
    const items = wb.getWorksheet('order_items')!;
    const cols = sheetDef('order_items').columns.map((c) => c.name);
    items.getRow(2).getCell(cols.indexOf('quantity') + 1).value = 'six';
    items.getRow(2).getCell(cols.indexOf('unit_price') + 1).value = 20.123;
    items.getRow(2).getCell(cols.indexOf('created_at') + 1).value = 'yesterday';
    items.getRow(2).getCell(cols.indexOf('note') + 1).value = { formula: 'HYPERLINK("x")', result: 'x' } as never;
    items.getRow(2).getCell(cols.indexOf('item_name_snapshot') + 1).value = 'x'.repeat(61);
    items.getRow(2).getCell(cols.indexOf('line_total') + 1).value = null;
    const errors = (() => {
      try {
        parseWorkbook(wb);
        return [];
      } catch (e) {
        return (e as WorkbookValidationError).errors;
      }
    })();
    expect(errors.join('\n')).toMatch(/quantity must be a whole number/);
    expect(errors.join('\n')).toMatch(/unit_price must be a number with at most 2 decimals/);
    expect(errors.join('\n')).toMatch(/created_at must be an ISO 8601 timestamp/);
    expect(errors.join('\n')).toMatch(/note must not hold a formula/);
    expect(errors.join('\n')).toMatch(/item_name_snapshot is longer than 60/);
    expect(errors.join('\n')).toMatch(/line_total is required/);
  });

  it('accepts values Excel turns into other cell types (rich text, string booleans, dates)', async () => {
    const { wb } = await saveAndReopen();
    const ws = wb.getWorksheet('tables')!;
    const cols = sheetDef('tables').columns.map((c) => c.name);
    ws.getRow(2).getCell(cols.indexOf('area') + 1).value = { richText: [{ text: 'Ga' }, { text: 'rden' }] };
    ws.getRow(2).getCell(cols.indexOf('is_active') + 1).value = 'FALSE';
    const orders = wb.getWorksheet('orders')!;
    const dateCol = sheetDef('orders').columns.findIndex((c) => c.name === 'business_date') + 1;
    orders.getRow(2).getCell(dateCol).value = new Date('2026-11-06T00:00:00Z');
    const dateCell = orders.getRow(2).getCell(dateCol);
    dateCell.style = { ...dateCell.style, numFmt: 'yyyy-mm-dd' };
    const data = parseWorkbook(await rewrite(wb));
    expect(data.tables[0]).toMatchObject({ area: 'Garden', is_active: false });
    expect(data.orders[0].business_date).toBe('2026-11-06');
  });

  it('ignores blank rows and keeps json columns as objects', async () => {
    const wb = await buildWorkbook(sampleData(), PASSWORD);
    wb.getWorksheet('audit_log')!.addRow([]);
    const data = parseWorkbook(await rewrite(wb));
    expect(data.audit_log).toHaveLength(1);
    expect(data.audit_log[0].after_json).toEqual({ status: 'OPEN' });
    expect(data.audit_log[0].created_at).toBe(NOW);
  });

  it('requires exactly one meta row', async () => {
    const data = emptyData();
    const wb = await buildWorkbook(data, PASSWORD);
    expect(() => parseWorkbook(wb)).toThrow(/meta: expected exactly 1 row/);
  });
});
