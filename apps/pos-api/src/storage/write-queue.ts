// The single write queue (REQ-106). Every change runs here, one at a time
// across the whole server. A change is a synchronous function over a Tx:
// it re-checks rules and row_version, allocates ids and writes rows; the Tx
// then appends one journal line and fsyncs it. Only after that does the
// change count as committed. If the change throws or the journal write fails,
// every row it touched is put back as it was, so readers never see it.
import { RealtimeEvent, SheetName, WorkbookRows } from '@dhaba/shared';
import { JournalUnavailableError, NotFoundError, RowVersionConflictError } from '../common/errors';
import { nowIst } from '../common/time';
import { Journal, JournalEntry, JournalOp, JournalWriteError } from './journal';
import { AuditColumns, DEFAULT_RESET_TIME, businessDate, createStamp, updateStamp } from './repository';
import { Row } from './workbook-codec';
import { WorkbookStore } from './workbook-store';

type Rows<S extends SheetName> = WorkbookRows[S];

export interface QueueHost {
  readonly store: WorkbookStore;
  readonly journal: Journal;
  /** Throws (e.g. WritesBlockedError) when writes are not allowed right now. */
  assertWritable(): void;
  /** Told about every journal write result, for /health. */
  journalResult(error: Error | null): void;
}

/** A realtime event queued by a change; sent only after its journal line is on disk. */
export interface TxEvent {
  event: RealtimeEvent;
  payload: Record<string, unknown>;
}

type Undo = { t: 'i'; s: SheetName; id: string } | { t: 'u'; s: SheetName; old: Row };

export class Tx {
  readonly ops: JournalOp[] = [];
  readonly undo: Undo[] = [];
  readonly events: TxEvent[] = [];

  constructor(
    private readonly store: WorkbookStore,
    /** Timestamp of this change, +05:30. */
    readonly now: string,
  ) {}

  get<S extends SheetName>(sheet: S, id: string): Rows<S> | undefined {
    return this.store.get(sheet, id);
  }

  all<S extends SheetName>(sheet: S): Rows<S>[] {
    return this.store.all(sheet);
  }

  findUnique<S extends SheetName>(sheet: S, column: string, value: unknown): Rows<S> | undefined {
    return this.store.findUnique(sheet, column, value);
  }

  findBy<S extends SheetName>(sheet: S, column: string, value: unknown): Rows<S>[] {
    return this.store.findBy(sheet, column, value);
  }

  insert<S extends SheetName>(sheet: S, row: Rows<S>): Rows<S> {
    const copy = structuredClone(row);
    this.store.insert(sheet, copy);
    this.undo.push({ t: 'i', s: sheet, id: (copy as unknown as Row).id as string });
    this.ops.push({ t: 'i', s: sheet, r: structuredClone(copy) as unknown as Row });
    return copy;
  }

  replace<S extends SheetName>(sheet: S, row: Rows<S>): Rows<S> {
    const id = (row as unknown as Row).id as string;
    const old = this.store.get(sheet, id);
    if (!old) throw new NotFoundError(sheet, id);
    const copy = structuredClone(row);
    this.store.replace(sheet, copy);
    this.undo.push({ t: 'u', s: sheet, old: old as unknown as Row });
    this.ops.push({ t: 'u', s: sheet, r: structuredClone(copy) as unknown as Row });
    return copy;
  }

  /** Returns the row if its row_version equals the If-Match value; otherwise 404 or 409 with the current row. */
  expectVersion<S extends SheetName>(sheet: S, id: string, ifMatch: number): Rows<S> {
    const row = this.store.get(sheet, id);
    if (!row) throw new NotFoundError(sheet, id);
    if ((row as unknown as Row).row_version !== ifMatch) throw new RowVersionConflictError(row);
    return row;
  }

  /** Inserts a new row with audit columns stamped for `userId` (row_version 1). */
  create<S extends SheetName>(sheet: S, fields: Omit<Rows<S>, keyof AuditColumns>, userId: string): Rows<S> {
    return this.insert(sheet, { ...fields, ...createStamp(this.now, userId) } as unknown as Rows<S>);
  }

  /** Replaces `row` with `patch` applied, stamping updated_at/by and row_version + 1. */
  update<S extends SheetName>(sheet: S, row: Rows<S>, patch: Partial<Rows<S>>, userId: string): Rows<S> {
    return this.replace(sheet, updateStamp(row as never, patch as never, this.now, userId) as Rows<S>);
  }

  /** business_date of this change, rolling over at Settings.token_reset_time (REQ-097). */
  businessDate(): string {
    const settings = this.store.all('settings')[0];
    return businessDate(this.now, settings?.token_reset_time || DEFAULT_RESET_TIME);
  }

  /** Queues a realtime event; it is emitted only if this change commits (REQ-116). */
  emit(event: RealtimeEvent, payload: Record<string, unknown>): void {
    this.events.push({ event, payload });
  }

  /** Next value of a counter (e.g. ORDER, TOKEN:2026-11-05); the first call returns 1. */
  nextCounter(key: string): number {
    const row = this.store.findUnique('counters', 'counter_key', key);
    if (!row) {
      this.insert('counters', { id: key, counter_key: key, next_value: 2, updated_at: this.now, row_version: 1 });
      return 1;
    }
    this.replace('counters', { ...row, next_value: row.next_value + 1, updated_at: this.now, row_version: row.row_version + 1 });
    return row.next_value;
  }

  rollback(): void {
    for (const u of [...this.undo].reverse()) {
      if (u.t === 'i') this.store.remove(u.s, u.id);
      else this.store.replace(u.s, u.old as never);
    }
    this.undo.length = 0;
    this.ops.length = 0;
    this.events.length = 0;
  }
}

export interface IdempotentResult<R> {
  /** true when the key was seen before and the stored row is returned (HTTP 200, not 201). */
  replayed: boolean;
  row: R;
}

export type CommitListener = (entry: JournalEntry, events: TxEvent[]) => void;

export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners: CommitListener[] = [];
  private pending = 0;

  constructor(private readonly host: QueueHost) {}

  /** Changes waiting or running. */
  get depth(): number {
    return this.pending;
  }

  /** Called after each commit (realtime events, coalesced save). Listener errors are ignored. */
  onCommit(listener: CommitListener): void {
    this.listeners.push(listener);
  }

  /** Runs one change alone. Resolves only after its journal line is on disk. */
  run<T>(change: (tx: Tx) => T): Promise<T> {
    this.pending++;
    const result = this.tail.then(() => this.execute(change));
    this.tail = result.catch(() => undefined).finally(() => this.pending--);
    return result;
  }

  /**
   * A creating change keyed by an Idempotency-Key stored in a unique column
   * (orders.client_request_id, kots.idempotency_key, payments.idempotency_key).
   * A key already in memory returns the stored row without enqueuing; a key
   * that arrives while its twin is still queued is caught again inside the queue.
   */
  async runIdempotent<S extends SheetName>(
    sheet: S,
    column: string,
    key: string,
    change: (tx: Tx) => Rows<S>,
  ): Promise<IdempotentResult<Rows<S>>> {
    this.host.assertWritable();
    const existing = this.host.store.findUnique(sheet, column, key);
    if (existing) return { replayed: true, row: existing };
    return this.run((tx) => {
      const twin = tx.findUnique(sheet, column, key);
      if (twin) return { replayed: true, row: twin };
      return { replayed: false, row: change(tx) };
    });
  }

  private execute<T>(change: (tx: Tx) => T): T {
    this.host.assertWritable();
    const tx = new Tx(this.host.store, nowIst());
    let result: T;
    try {
      result = change(tx);
      if (result instanceof Promise) throw new Error('write-queue changes must be synchronous');
    } catch (err) {
      tx.rollback();
      throw err;
    }
    if (!tx.ops.length) return result;
    let entry: JournalEntry;
    try {
      entry = this.host.journal.append(tx.ops, tx.now);
    } catch (err) {
      tx.rollback();
      const error = err instanceof Error ? err : new JournalWriteError(err);
      this.host.journalResult(error);
      throw new JournalUnavailableError(error.message);
    }
    this.host.journalResult(null);
    for (const l of this.listeners) {
      try {
        l(entry, tx.events);
      } catch {
        // A listener must never undo a committed change.
      }
    }
    return result;
  }
}
