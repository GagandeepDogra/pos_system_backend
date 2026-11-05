// GET /api/v1/admin/day-close (getDayCloseSummary) and POST /api/v1/admin/day-close
// (closeDay), Admin only. The POST's Idempotency-Key is kept in memory 24 h per
// user: a retry answers 200 with the first close's result instead of closing again.
import { Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { IdempotencyKey } from '../common/headers';
import { StorageService } from '../storage/storage.service';
import { DayCloseResult, DayCloseSummary, closeDay, dayCloseSummary } from './day-close';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

@Controller('admin/day-close')
export class DayCloseController {
  private readonly closes = new Map<string, { expiresMs: number; result: Promise<DayCloseResult> }>();

  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Get()
  @Roles(...PERMISSIONS.getDayCloseSummary)
  summary(): DayCloseSummary {
    return dayCloseSummary(this.storage.store, this.auth.now());
  }

  @Post()
  @Roles(...PERMISSIONS.closeDay)
  async close(@IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<DayCloseResult> {
    const now = Date.now();
    for (const [k, v] of this.closes) if (v.expiresMs <= now) this.closes.delete(k);
    const scoped = `${user.id}:${key}`;
    const hit = this.closes.get(scoped);
    if (hit) {
      const result = await hit.result;
      res.status(200);
      return result;
    }
    const result = closeDay(this.storage, user.id, this.auth.now());
    this.closes.set(scoped, { expiresMs: now + IDEMPOTENCY_TTL_MS, result });
    try {
      const body = await result;
      res.status(201);
      return body;
    } catch (err) {
      // A refused or failed close may be retried with the same key.
      this.closes.delete(scoped);
      throw err;
    }
  }
}
