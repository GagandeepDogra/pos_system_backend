// Idempotency-Key handling for creating POSTs on sheets without an idempotency
// column (DEC-004): the key is kept in memory for 24 h per user and checked
// inside the queue change. A repeat returns the created row (200) without writing.
import type { Response } from 'express';
import { SheetName } from '@dhaba/shared';
import { Tx, WriteQueue } from '../storage/write-queue';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export class MemoryIdempotency {
  private readonly keys = new Map<string, { sheet: SheetName; id: string; expiresMs: number }>();

  constructor(private readonly queue: () => WriteQueue) {}

  /**
   * Runs `create` once per `scoped` key (status 201); a repeat answers 200 with
   * `replay(stored row)`. `scoped` should include the user id and operation.
   */
  async once<T extends { id: string }>(
    sheet: SheetName, scoped: string, res: Response, create: (tx: Tx) => T, replay: (row: unknown) => T = (row) => row as T,
  ): Promise<T> {
    const now = Date.now();
    let replayed = false;
    const row = await this.queue().run((tx) => {
      const hit = this.keys.get(scoped);
      const stored = hit && hit.expiresMs > now ? tx.get(hit.sheet, hit.id) : undefined;
      if (stored) {
        replayed = true;
        return replay(stored);
      }
      const created = create(tx);
      this.keys.set(scoped, { sheet, id: created.id, expiresMs: now + IDEMPOTENCY_TTL_MS });
      return created;
    }).catch((err) => {
      if (!replayed) this.keys.delete(scoped);
      throw err;
    });
    res.status(replayed ? 200 : 201);
    this.prune(now);
    return row;
  }

  private prune(now: number): void {
    if (this.keys.size < 1000) return;
    for (const [k, v] of this.keys) if (v.expiresMs <= now) this.keys.delete(k);
  }
}
