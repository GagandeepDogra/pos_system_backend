// Dine-in sessions and the order view: openTableSession, getOrder, moveOrder,
// mergeOrders (REQ-034, REQ-035, REQ-037, REQ-020).
import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { ApiError, NotFoundError } from '../common/errors';
import { IdempotencyKey, IfMatch } from '../common/headers';
import { StorageService } from '../storage/storage.service';
import { OrderView, isOpenOrder, mergeSessions, moveSession, openSession, orderView } from './dine-in';

export class OpenTableSessionDto {
  @IsString() @MaxLength(20) table_id!: string;
  /** Optional; null or omitted = skipped (REQ-034). */
  @IsOptional() @IsInt() @Min(1) @Max(99) guest_count?: number | null;
  @IsOptional() @IsString() @MaxLength(40) customer_name?: string | null;
  @IsOptional() @IsString() @Matches(/^\d{4,10}$/) customer_phone?: string | null;
}

export class MoveOrderDto {
  /** The free table to move to. */
  @IsString() @MaxLength(20) table_id!: string;
}

export class MergeOrdersDto {
  /** The other table's open order; it is folded into the order in the path. */
  @IsString() @MaxLength(20) source_order_id!: string;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly storage: StorageService) {}

  @Post('dine-in')
  @Roles(...PERMISSIONS.openTableSession)
  async openTableSession(
    @IdempotencyKey() key: string,
    @Body() dto: OpenTableSessionDto,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { replayed, row } = await this.storage.queue.runIdempotent('orders', 'client_request_id', key, (tx) => openSession(tx, dto, key, user));
    res.status(replayed ? 200 : 201);
    return row;
  }

  @Get(':id')
  @Roles(...PERMISSIONS.getOrder)
  getOrder(@Param('id') id: string, @CurrentUser() user: SessionUser): OrderView {
    const store = this.storage.store;
    const order = store.get('orders', id);
    if (!order) throw new NotFoundError('orders', id);
    // RSK-002: a Cashier sees every open session (tables are shared) but only
    // their own closed orders.
    if (user.role === 'CASHIER' && !isOpenOrder(order) && order.created_by !== user.id) {
      throw new ApiError(403, 'ORDER_NOT_VISIBLE', "This is another cashier's closed order.", 'यह किसी दूसरे कैशियर का बंद ऑर्डर है।', { order_id: id });
    }
    return orderView(store, order);
  }

  @Post(':id/move')
  @HttpCode(200)
  @Roles(...PERMISSIONS.moveOrder)
  moveOrder(@Param('id') id: string, @IfMatch() version: number, @Body() dto: MoveOrderDto, @CurrentUser() user: SessionUser) {
    return this.storage.queue.run((tx) => moveSession(tx, id, version, dto.table_id, user));
  }

  @Post(':id/merge')
  @HttpCode(200)
  @Roles(...PERMISSIONS.mergeOrders)
  async mergeOrders(@Param('id') id: string, @IfMatch() version: number, @Body() dto: MergeOrdersDto, @CurrentUser() user: SessionUser): Promise<OrderView> {
    const merged = await this.storage.queue.run((tx) => mergeSessions(tx, id, version, dto.source_order_id, user));
    return orderView(this.storage.store, merged);
  }
}
