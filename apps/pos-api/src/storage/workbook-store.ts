// All 15 sheets held in indexed memory. Reads never touch the file.
// Mutations here are low level: the write queue (built later) is the only
// caller allowed to use insert/replace, inside one serialised step.
import { SheetName, WorkbookRows } from '@dhaba/shared';
import { SHEETS, sheetDef } from './schema';
import { Row, WorkbookData } from './workbook-codec';

type Rows<S extends SheetName> = WorkbookRows[S];

export class StoreConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreConstraintError';
  }
}

export class WorkbookStore {
  private readonly rows = new Map<SheetName, Map<string, Row>>();
  /** sheet.column → value → id */
  private readonly unique = new Map<string, Map<unknown, string>>();
  /** sheet.column → value → ids */
  private readonly index = new Map<string, Map<unknown, Set<string>>>();

  constructor(data?: WorkbookData) {
    for (const def of SHEETS) {
      this.rows.set(def.name, new Map());
      for (const c of def.columns) {
        if (c.unique && c.name !== 'id') this.unique.set(`${def.name}.${c.name}`, new Map());
        if (c.indexed) this.index.set(`${def.name}.${c.name}`, new Map());
      }
    }
    if (data) for (const def of SHEETS) for (const r of data[def.name]) this.insert(def.name, r as never);
  }

  get<S extends SheetName>(sheet: S, id: string): Rows<S> | undefined {
    return this.rows.get(sheet)!.get(id) as unknown as Rows<S> | undefined;
  }

  all<S extends SheetName>(sheet: S): Rows<S>[] {
    return [...this.rows.get(sheet)!.values()] as unknown as Rows<S>[];
  }

  count(sheet: SheetName): number {
    return this.rows.get(sheet)!.size;
  }

  /** Looks a row up by a unique column (e.g. orders.client_request_id). */
  findUnique<S extends SheetName>(sheet: S, column: string, value: unknown): Rows<S> | undefined {
    const map = this.unique.get(`${sheet}.${column}`);
    if (!map) throw new Error(`${sheet}.${column} is not a unique column`);
    const id = map.get(value);
    return id === undefined ? undefined : this.get(sheet, id);
  }

  /** Rows whose indexed column equals value (e.g. order_items by order_id). */
  findBy<S extends SheetName>(sheet: S, column: string, value: unknown): Rows<S>[] {
    const map = this.index.get(`${sheet}.${column}`);
    if (!map) throw new Error(`${sheet}.${column} is not an indexed column`);
    return [...(map.get(value) ?? [])].map((id) => this.get(sheet, id)!) as unknown as Rows<S>[];
  }

  insert<S extends SheetName>(sheet: S, row: Rows<S>): void {
    const r = row as unknown as Row;
    const id = r.id as string;
    if (this.rows.get(sheet)!.has(id)) throw new StoreConstraintError(`${sheet}: duplicate id ${id}`);
    this.checkUnique(sheet, r, id);
    this.rows.get(sheet)!.set(id, r);
    this.addToIndexes(sheet, r);
  }

  /** Replaces the row with the same id. */
  replace<S extends SheetName>(sheet: S, row: Rows<S>): void {
    const r = row as unknown as Row;
    const id = r.id as string;
    const old = this.rows.get(sheet)!.get(id);
    if (!old) throw new StoreConstraintError(`${sheet}: no row ${id}`);
    this.checkUnique(sheet, r, id);
    this.removeFromIndexes(sheet, old);
    this.rows.get(sheet)!.set(id, r);
    this.addToIndexes(sheet, r);
  }

  /** Removes a row. Only the write queue's rollback of an uncommitted insert may use it. */
  remove(sheet: SheetName, id: string): void {
    const old = this.rows.get(sheet)!.get(id);
    if (!old) return;
    this.removeFromIndexes(sheet, old);
    this.rows.get(sheet)!.delete(id);
  }

  /** Plain copy of every sheet, for saving. */
  toData(): WorkbookData {
    return Object.fromEntries(SHEETS.map((d) => [d.name, [...this.rows.get(d.name)!.values()]])) as unknown as WorkbookData;
  }

  private checkUnique(sheet: SheetName, r: Row, id: string): void {
    for (const c of sheetDef(sheet).columns) {
      const map = this.unique.get(`${sheet}.${c.name}`);
      const v = r[c.name];
      if (!map || v === null || v === undefined) continue;
      const owner = map.get(v);
      if (owner !== undefined && owner !== id) {
        throw new StoreConstraintError(`${sheet}: duplicate ${c.name} "${String(v)}"`);
      }
    }
  }

  private addToIndexes(sheet: SheetName, r: Row): void {
    const id = r.id as string;
    for (const c of sheetDef(sheet).columns) {
      const key = `${sheet}.${c.name}`;
      const v = r[c.name];
      if (v === null || v === undefined) continue;
      this.unique.get(key)?.set(v, id);
      const idx = this.index.get(key);
      if (idx) {
        if (!idx.has(v)) idx.set(v, new Set());
        idx.get(v)!.add(id);
      }
    }
  }

  private removeFromIndexes(sheet: SheetName, r: Row): void {
    const id = r.id as string;
    for (const c of sheetDef(sheet).columns) {
      const key = `${sheet}.${c.name}`;
      const v = r[c.name];
      if (v === null || v === undefined) continue;
      if (this.unique.get(key)?.get(v) === id) this.unique.get(key)!.delete(v);
      const set = this.index.get(key)?.get(v);
      if (set) {
        set.delete(id);
        if (!set.size) this.index.get(key)!.delete(v);
      }
    }
  }
}
