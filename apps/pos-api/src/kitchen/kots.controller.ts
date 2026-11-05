// Send to kitchen, the kitchen board, KOT status and item cancel:
// sendToKitchen, listKitchenKots, updateKotStatus, cancelOrderItem
// (REQ-049, REQ-045, REQ-048, REQ-060, REQ-051..055, REQ-083, REQ-021).
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { Kot, OrderItem } from '@dhaba/shared';
import { AuthService } from '../auth/auth.service';
import { ApprovalToken, CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { ApiError } from '../common/errors';
import { IdempotencyKey, IfMatch } from '../common/headers';
import { ServerDerived } from '../common/validation';
import { OrderView, orderView } from '../orders/dine-in';
import { StorageService } from '../storage/storage.service';
import { KitchenKot, advanceKot, cancelLine, kitchenBoard, sendToKitchen } from './kots';

export class CartLineDto {
  @IsString() @MaxLength(20) variant_id!: string;
  /** 1–99 (REQ-047). */
  @IsInt() @Min(1) @Max(99) quantity!: number;
  /** Chips plus free text, e.g. "No onion, extra gravy"; null = none (REQ-048). */
  @IsOptional() @IsString() @MaxLength(80) note?: string | null;
  // The server prices and names every line (REQ-114).
  @ServerDerived() unit_price?: unknown;
  @ServerDerived() line_total?: unknown;
  @ServerDerived() item_name_snapshot?: unknown;
  @ServerDerived() variant_name_snapshot?: unknown;
}

export class SendToKitchenDto {
  /** The cart lines not yet sent; one KOT is made of exactly these. */
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CartLineDto) lines!: CartLineDto[];
}

export class UpdateKotStatusDto {
  @IsIn(['PREPARING', 'READY', 'SERVED']) status!: 'PREPARING' | 'READY' | 'SERVED';
}

export class CancelOrderItemDto {
  /** Why the line is cancelled (stored as cancel_reason). `reason` is accepted as an alias. */
  @IsOptional() @IsString() @MaxLength(80) cancel_reason?: string;
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
}

export type SentKot = Kot & { lines: OrderItem[] };

@Controller()
export class KotsController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Post('orders/:id/kots')
  @Roles(...PERMISSIONS.sendToKitchen)
  async sendToKitchen(
    @Param('id') id: string,
    @IdempotencyKey() key: string,
    @Body() dto: SendToKitchenDto,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SentKot> {
    if (!dto.lines.length) {
      throw new ApiError(400, 'EMPTY_CART', 'The cart is empty. Add items before sending.', 'कार्ट खाली है। भेजने से पहले आइटम जोड़ें।', {});
    }
    const { replayed, row } = await this.storage.queue.runIdempotent('kots', 'idempotency_key', key, (tx) => sendToKitchen(tx, id, dto.lines, key, user));
    res.status(replayed ? 200 : 201);
    return { ...row, lines: this.storage.store.findBy('order_items', 'kot_id', row.id) };
  }

  @Get('kitchen/kots')
  @Roles(...PERMISSIONS.listKitchenKots)
  listKitchenKots(): KitchenKot[] {
    return kitchenBoard(this.storage.store, this.auth.now());
  }

  @Patch('kots/:id/status')
  @Roles(...PERMISSIONS.updateKotStatus)
  updateKotStatus(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateKotStatusDto, @CurrentUser() user: SessionUser): Promise<Kot> {
    return this.storage.queue.run((tx) => advanceKot(tx, id, version, dto.status, user));
  }

  @Post('order-items/:id/cancel')
  @HttpCode(200)
  @Roles(...PERMISSIONS.cancelOrderItem)
  async cancelOrderItem(
    @Param('id') id: string,
    @IfMatch() version: number,
    @ApprovalToken() approvalToken: string | null,
    @Body() dto: CancelOrderItemDto,
    @CurrentUser() user: SessionUser,
  ): Promise<OrderView> {
    const reason = (dto.cancel_reason ?? dto.reason ?? '').trim();
    if (!reason) {
      throw new ApiError(400, 'REASON_REQUIRED', 'Give a reason for cancelling.', 'रद्द करने का कारण बताएँ।', { field: 'cancel_reason' });
    }
    const order = await this.storage.queue.run((tx) =>
      cancelLine(tx, id, version, { reason, approvalToken }, user, (token, userId) => this.auth.approvals.consume(token, userId)));
    return orderView(this.storage.store, order);
  }
}
