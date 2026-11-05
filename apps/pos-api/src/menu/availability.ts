// Daily item availability (REQ-074, REQ-056). Items.available_today is a
// today-only flag, separate from is_active. It resets to TRUE at business-day
// rollover (Settings.token_reset_time):
// - reads use `isAvailableToday`, so a FALSE set on an earlier business day
//   already counts as available the moment the day rolls over;
// - `AvailabilityRollover` (main.ts, every minute) and day close (WI-016,
//   `resetAvailability`) write the reset through the queue so the stored flag
//   matches.
import { Item } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { NotFoundError } from '../common/errors';
import { DEFAULT_RESET_TIME, businessDate } from '../storage/repository';
import { Tx } from '../storage/write-queue';
import { WorkbookStore } from '../storage/workbook-store';

type Reader = Pick<WorkbookStore, 'all'>;

/** Settings.token_reset_time (default 04:00). */
export function resetTimeOf(store: Reader): string {
  return store.all('settings')[0]?.token_reset_time || DEFAULT_RESET_TIME;
}

/** The current business date for `at`. */
export function todayOf(store: Reader, at: Date | string | number): string {
  return businessDate(new Date(at), resetTimeOf(store));
}

/**
 * Today's availability: the stored flag, except that a FALSE set on an earlier
 * business day has rolled over to TRUE. WI-008's send check should use this.
 */
export function isAvailableToday(item: Item, today: string, resetTime: string): boolean {
  return item.available_today || businessDate(item.updated_at, resetTime) < today;
}

/** The item with `available_today` as it is today (for responses). */
export function withTodayAvailability(item: Item, today: string, resetTime: string): Item {
  const available = isAvailableToday(item, today, resetTime);
  return available === item.available_today ? item : { ...item, available_today: available };
}

export type AvailabilitySource = 'TOGGLE' | 'KITCHEN' | 'ROLLOVER';

/** Bilingual cashier alert carried by a kitchen out-of-stock event (REQ-056). */
export function outOfStockAlert(item: Item) {
  return {
    message_en: `Kitchen: ${item.name_en} is out of stock today.`,
    message_hi: `रसोई: ${item.name_hi} आज उपलब्ध नहीं है।`,
  };
}

/**
 * Queue change: set one item's available_today. `ifMatch` null skips the
 * row_version check (the kitchen out-of-stock route has no If-Match). A request
 * that changes nothing returns the row without writing or emitting.
 */
export function setAvailability(
  tx: Tx,
  itemId: string,
  ifMatch: number | null,
  available: boolean,
  userId: string,
  source: Exclude<AvailabilitySource, 'ROLLOVER'>,
): Item {
  const current = ifMatch === null ? tx.get('items', itemId) : tx.expectVersion('items', itemId, ifMatch);
  if (!current) throw new NotFoundError('items', itemId);
  const resetTime = resetTimeOf(tx);
  const today = tx.businessDate();
  const before = isAvailableToday(current, today, resetTime);
  if (before === available && current.available_today === available) return current;
  const updated = tx.update('items', current, { available_today: available }, userId);
  writeAudit(tx, {
    action: available ? 'AVAILABLE' : 'OUT_OF_STOCK',
    entity_type: 'items',
    entity_id: itemId,
    user_id: userId,
    before_json: { available_today: before },
    after_json: { available_today: available, source },
  });
  tx.emit('menu.availability_changed', {
    item_id: itemId,
    name_en: updated.name_en,
    name_hi: updated.name_hi,
    available_today: available,
    row_version: updated.row_version,
    source,
    changed_by: userId,
    ...(source === 'KITCHEN' && !available ? { alert: outOfStockAlert(updated) } : {}),
  });
  return updated;
}

/** Items whose stored FALSE belongs to an earlier business day. */
export function staleUnavailable(store: Reader, today: string): Item[] {
  const resetTime = resetTimeOf(store);
  return store.all('items').filter((i) => !i.available_today && isAvailableToday(i, today, resetTime));
}

/**
 * Queue change: reset available_today to TRUE. `all` = every unavailable item
 * (day close); otherwise only those set on an earlier business day (rollover).
 * Returns the reset item ids; emits one menu.availability_changed when any.
 */
export function resetAvailability(tx: Tx, options: { all?: boolean; userId?: string; today?: string } = {}): string[] {
  const userId = options.userId ?? 'SYSTEM';
  const targets = options.all ? tx.all('items').filter((i) => !i.available_today) : staleUnavailable(tx, options.today ?? tx.businessDate());
  for (const item of targets) {
    tx.update('items', item, { available_today: true }, userId);
    writeAudit(tx, {
      action: 'AVAILABLE',
      entity_type: 'items',
      entity_id: item.id,
      user_id: userId,
      before_json: { available_today: false },
      after_json: { available_today: true, source: 'ROLLOVER' },
    });
  }
  if (targets.length) {
    tx.emit('menu.availability_changed', { item_ids: targets.map((i) => i.id), available_today: true, source: 'ROLLOVER' });
  }
  return targets.map((i) => i.id);
}

interface RolloverTarget {
  readonly store: Reader;
  readonly queue: { run<T>(change: (tx: Tx) => T): Promise<T> };
  readonly state?: string;
}

/** Writes the business-day availability reset once the day has rolled over (checked every minute by main.ts). */
export class AvailabilityRollover {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly storage: RolloverTarget, private readonly now: () => number = Date.now) {}

  /** Resets stale items if there are any; returns the reset ids. */
  async check(): Promise<string[]> {
    if (this.storage.state !== undefined && this.storage.state !== 'ready') return [];
    const today = todayOf(this.storage.store, this.now());
    if (!staleUnavailable(this.storage.store, today).length) return [];
    return this.storage.queue.run((tx) => resetAvailability(tx, { today }));
  }

  start(intervalMs = 60_000): void {
    this.stop();
    const tick = () => void this.check().catch((err) => console.error(`pos-api: availability rollover failed: ${(err as Error).message}`));
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
