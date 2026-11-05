// Monthly archive workbooks (REQ-108, DEC-013). After a day close, every month
// that has ended (or ends with the closed business day) has its transaction rows
// copied into archive/YYYY-MM.xlsx, the copy is re-read and its row counts and
// ids verified, the file is made read-only, and only then are the rows removed
// from the live workbook (one journal entry with `d` ops).
//
// Resumable: a crash after the file is written but before the prune leaves rows
// that are already in an archive part; the next run prunes them without writing
// again. Rows of a month that arrive after its archive (e.g. orders after the
// month-end close but before the 04:00 cut-off) go into a further part,
// archive/YYYY-MM-2.xlsx, and so on. Archive files are never rewritten.
import fs from 'fs';
import path from 'path';
import { ARCHIVED_SHEETS, ArchivedSheet, SheetName } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { SCHEMA_VERSION, SHEETS } from './schema';
import { Row, WorkbookData, emptyData } from './workbook-codec';
import { ARCHIVE_FILE_RE, readWorkbookFile, writeArchiveFile } from './workbook-file';
import { WorkbookStore } from './workbook-store';
import { Tx } from './write-queue';

export type ArchiveCounts = Record<ArchivedSheet, number>;

export interface ArchivePart {
  month: string;
  part: number;
  name: string;
  file: string;
}

export interface MonthArchiveResult {
  month: string;
  status: 'ARCHIVED' | 'NOTHING_TO_ARCHIVE' | 'FAILED';
  /** Archive files written by this run. */
  files: string[];
  /** Rows removed from the live workbook by this run, per sheet. */
  pruned: ArchiveCounts;
  error?: string;
}

/** Runs one change immediately (the caller holds the write queue). */
export type Commit = <R>(change: (tx: Tx) => R) => R;

interface ArchiveHost {
  readonly store: WorkbookStore;
  readonly archiveDir: string;
  readonly sheetPassword: string;
  readonly journal: { readonly lastSeq: number };
}

const zeroCounts = (): ArchiveCounts => Object.fromEntries(ARCHIVED_SHEETS.map((s) => [s, 0])) as ArchiveCounts;

/** Calendar month (YYYY-MM) a row belongs to: orders by business_date, audit rows by IST created_at. */
function monthOfOrder(o: { business_date: string }): string {
  return o.business_date.slice(0, 7);
}

function monthOfAudit(a: { created_at: string }): string {
  return a.created_at.slice(0, 7);
}

/** True when `date` (YYYY-MM-DD) is the last day of its month. */
export function isLastDayOfMonth(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() === d;
}

/**
 * Months whose rows should leave the live workbook after closing business day
 * `closedDate`: every month before it still present in live, plus its own
 * month when it is the month's last day.
 */
export function monthsToArchive(store: WorkbookStore, closedDate: string): string[] {
  const current = closedDate.slice(0, 7);
  const months = new Set<string>();
  for (const o of store.all('orders')) months.add(monthOfOrder(o));
  for (const a of store.all('audit_log')) months.add(monthOfAudit(a));
  return [...months]
    .filter((m) => m < current || (m === current && isLastDayOfMonth(closedDate)))
    .sort();
}

/**
 * The rows of one month: its orders (by business_date) with their KOTs, lines,
 * payments and exceptions, and its audit rows (by created_at). Orders linked to
 * them by a merge or a line on a shared KOT come along, so no row left in live
 * (or in the archive) points at a row that is not there.
 */
export function selectMonth(store: WorkbookStore, month: string): Record<ArchivedSheet, Row[]> {
  const orders = store.all('orders');
  const kots = store.all('kots');
  const items = store.all('order_items');
  const orderIds = new Set(orders.filter((o) => monthOfOrder(o) === month).map((o) => o.id));
  const kotIds = new Set<string>();
  const itemIds = new Set<string>();
  let grew = true;
  while (grew) {
    const before = orderIds.size + kotIds.size + itemIds.size;
    for (const o of orders) {
      if (o.merged_into_order_id && orderIds.has(o.merged_into_order_id)) orderIds.add(o.id);
      if (orderIds.has(o.id) && o.merged_into_order_id) orderIds.add(o.merged_into_order_id);
    }
    for (const k of kots) if (orderIds.has(k.order_id)) kotIds.add(k.id);
    for (const i of items) {
      if (orderIds.has(i.order_id) || kotIds.has(i.kot_id)) {
        itemIds.add(i.id);
        orderIds.add(i.order_id);
        kotIds.add(i.kot_id);
      }
    }
    for (const k of kots) if (kotIds.has(k.id)) orderIds.add(k.order_id);
    grew = orderIds.size + kotIds.size + itemIds.size !== before;
  }
  const byOrder = <T extends { order_id: string }>(rows: T[]) => rows.filter((r) => orderIds.has(r.order_id));
  return {
    orders: orders.filter((o) => orderIds.has(o.id)) as unknown as Row[],
    kots: kots.filter((k) => kotIds.has(k.id)) as unknown as Row[],
    order_items: items.filter((i) => itemIds.has(i.id)) as unknown as Row[],
    payments: byOrder(store.all('payments')) as unknown as Row[],
    exceptions: byOrder(store.all('exceptions')) as unknown as Row[],
    audit_log: store.all('audit_log').filter((a) => monthOfAudit(a) === month) as unknown as Row[],
  };
}

/** Archive parts already written for `month`, oldest first. */
export function listArchiveParts(dir: string, month?: string): ArchivePart[] {
  if (!fs.existsSync(dir)) return [];
  const parts: ArchivePart[] = [];
  for (const name of fs.readdirSync(dir)) {
    const m = ARCHIVE_FILE_RE.exec(name);
    if (!m || (month && m[1] !== month)) continue;
    parts.push({ month: m[1], part: m[2] ? Number(m[2]) : 1, name, file: path.join(dir, name) });
  }
  return parts.sort((a, b) => a.month.localeCompare(b.month) || a.part - b.part);
}

export function archiveFileName(month: string, part: number): string {
  return part === 1 ? `${month}.xlsx` : `${month}-${part}.xlsx`;
}

/**
 * A self-contained archive workbook: the month's transaction rows plus the
 * reference sheets (users, tables, menu, settings, price history) as they are
 * now, so it passes the same validation as a live file and reports can read
 * names from it. Counters are left empty.
 */
function archiveData(store: WorkbookStore, rows: Record<ArchivedSheet, Row[]>, seq: number, now: string): WorkbookData {
  const data = emptyData();
  const archived = new Set<SheetName>(ARCHIVED_SHEETS);
  for (const def of SHEETS) {
    if (def.name === 'meta') {
      data.meta.push({ id: 'META', schema_version: SCHEMA_VERSION, last_journal_seq: seq, updated_at: now });
    } else if (def.name === 'counters') {
      continue;
    } else if (!archived.has(def.name)) {
      (data[def.name] as unknown as Row[]).push(...(store.all(def.name) as unknown as Row[]));
    }
  }
  for (const s of ARCHIVED_SHEETS) (data[s] as unknown as Row[]).push(...rows[s]);
  return data;
}

function sameVersion(live: Row, archived: Row | undefined): boolean {
  if (!archived) return false;
  // Sheets without row_version (exceptions, audit_log) are append-only.
  return !('row_version' in live) || live.row_version === archived.row_version;
}

/** Re-reads an archive file and checks it holds exactly `rows` (counts and ids) of each archived sheet. */
async function verifyArchive(file: string, rows: Record<ArchivedSheet, Row[]>): Promise<void> {
  const data = await readWorkbookFile(file);
  for (const s of ARCHIVED_SHEETS) {
    const got = (data[s] as unknown as Row[]).map((r) => r.id as string);
    const want = rows[s].map((r) => r.id as string);
    if (got.length !== want.length) throw new Error(`${path.basename(file)}: ${s} has ${got.length} rows, expected ${want.length}`);
    const ids = new Set(got);
    const missing = want.find((id) => !ids.has(id));
    if (missing) throw new Error(`${path.basename(file)}: ${s} is missing ${missing}`);
  }
}

export class MonthlyArchiver {
  constructor(private readonly host: ArchiveHost) {}

  /** Archives every month due after closing `closedDate`. The caller holds the write queue. */
  async archiveDue(commit: Commit, closedDate: string, userId: string, now: string): Promise<MonthArchiveResult[]> {
    const results: MonthArchiveResult[] = [];
    for (const month of monthsToArchive(this.host.store, closedDate)) {
      try {
        results.push(await this.archiveMonth(commit, month, userId, now));
      } catch (err) {
        results.push({ month, status: 'FAILED', files: [], pruned: zeroCounts(), error: (err as Error).message });
      }
    }
    return results;
  }

  /** Writes (or resumes) the archive of one month and prunes its rows from live. */
  async archiveMonth(commit: Commit, month: string, userId: string, now: string): Promise<MonthArchiveResult> {
    const store = this.host.store;
    const selected = selectMonth(store, month);
    const parts = listArchiveParts(this.host.archiveDir, month);

    // Rows already safe in an earlier part (an interrupted run) are pruned without rewriting them.
    const alreadyArchived = Object.fromEntries(ARCHIVED_SHEETS.map((s) => [s, new Map<string, Row>()])) as Record<ArchivedSheet, Map<string, Row>>;
    for (const part of parts) {
      const data = await readWorkbookFile(part.file);
      for (const s of ARCHIVED_SHEETS) for (const r of data[s] as unknown as Row[]) alreadyArchived[s].set(r.id as string, r);
    }
    const toPrune = zeroRows();
    const toWrite = zeroRows();
    for (const s of ARCHIVED_SHEETS) {
      for (const r of selected[s]) {
        if (sameVersion(r, alreadyArchived[s].get(r.id as string))) toPrune[s].push(r);
        else toWrite[s].push(r);
      }
    }

    const files: string[] = [];
    if (ARCHIVED_SHEETS.some((s) => toWrite[s].length)) {
      const part = (parts.at(-1)?.part ?? 0) + 1;
      const file = path.join(this.host.archiveDir, archiveFileName(month, part));
      await writeArchiveFile(file, archiveData(store, toWrite, this.host.journal.lastSeq, now), this.host.sheetPassword);
      try {
        await verifyArchive(file, toWrite);
      } catch (err) {
        fs.rmSync(file, { force: true });
        throw new Error(`archive ${path.basename(file)} failed verification: ${(err as Error).message}`);
      }
      files.push(file);
      for (const s of ARCHIVED_SHEETS) toPrune[s].push(...toWrite[s]);
    }

    const pruned = zeroCounts();
    for (const s of ARCHIVED_SHEETS) pruned[s] = toPrune[s].length;
    if (!ARCHIVED_SHEETS.some((s) => pruned[s])) return { month, status: 'NOTHING_TO_ARCHIVE', files, pruned };

    commit((tx) => {
      for (const s of ARCHIVED_SHEETS) for (const r of toPrune[s]) tx.remove(s, r.id as string);
      writeAudit(tx, {
        action: 'ARCHIVE',
        entity_type: 'archive',
        entity_id: month,
        user_id: userId,
        after_json: { files: files.map((f) => path.basename(f)), pruned },
      });
    });
    return { month, status: 'ARCHIVED', files, pruned };
  }
}

function zeroRows(): Record<ArchivedSheet, Row[]> {
  return Object.fromEntries(ARCHIVED_SHEETS.map((s) => [s, [] as Row[]])) as Record<ArchivedSheet, Row[]>;
}
