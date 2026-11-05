// Test-only routes that exercise the core (queue, repository, validation,
// errors, realtime) the way the feature controllers will. Not part of src/.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import { Public } from '../../src/auth/decorators';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { Order } from '@dhaba/shared';
import { buildOrderLine } from '../../src/billing/order-line';
import { fromPaise, toPaise } from '../../src/billing/money';
import { ApiError, NotFoundError } from '../../src/common/errors';
import { IdempotencyKey, IfMatch } from '../../src/common/headers';
import { ServerDerived } from '../../src/common/validation';
import { counterKeys, idFormats } from '../../src/storage/repository';
import { StorageService } from '../../src/storage/storage.service';
import { WriteQueue } from '../../src/storage/write-queue';

const USER = 'USR-1';

export class CreateTakeawayDto {
  @IsOptional() @IsString() @MaxLength(40) customer_name?: string | null;
}

export class UpdateOrderDto {
  @IsOptional() @IsString() @MaxLength(40) customer_name?: string | null;
}

export class KotLineDto {
  @IsString() variant_id!: string;
  @IsInt() @Min(1) @Max(99) quantity!: number;
  @IsOptional() @IsString() @MaxLength(80) note?: string | null;
  @ServerDerived() price?: unknown;
  @ServerDerived() unit_price?: unknown;
}

export class SendKotDto {
  @ValidateNested({ each: true }) @Type(() => KotLineDto) @ArrayMinSize(1) lines!: KotLineDto[];
}

export class OpenTableDto {
  @IsString() table_id!: string;
}

@Public()
@Controller('demo')
export class DemoController {
  constructor(private readonly queue: WriteQueue, private readonly storage: StorageService) {}

  @Get('menu')
  menu() {
    return this.storage.store.all('items').filter((i) => i.is_active);
  }

  @Post('orders/takeaway')
  async takeaway(@IdempotencyKey() key: string, @Body() dto: CreateTakeawayDto, @Res({ passthrough: true }) res: Response) {
    const { replayed, row } = await this.queue.runIdempotent('orders', 'client_request_id', key, (tx) => {
      const bd = tx.businessDate();
      const order = tx.create('orders', {
        ...blankOrder(), id: idFormats.order(bd, tx.nextCounter(counterKeys.order())), order_type: 'TAKEAWAY',
        business_date: bd, token: idFormats.token(tx.nextCounter(counterKeys.token(bd))),
        customer_name: dto.customer_name ?? null, client_request_id: key,
      }, USER);
      tx.emit('order.updated', { order_id: order.id, status: order.status });
      return order;
    });
    res.status(replayed ? 200 : 201);
    return row;
  }

  @Post('orders/dine-in')
  async dineIn(@IdempotencyKey() key: string, @Body() dto: OpenTableDto) {
    return (await this.queue.runIdempotent('orders', 'client_request_id', key, (tx) => {
      const table = tx.get('tables', dto.table_id);
      if (!table) throw new NotFoundError('tables', dto.table_id);
      const busy = tx.findBy('orders', 'table_id', table.id).find((o) => o.status === 'OPEN' || o.status === 'BILLED');
      if (busy) throw new ApiError(409, 'TABLE_BUSY', 'This table already has an open order.', 'इस टेबल पर पहले से ऑर्डर खुला है।', { order: busy });
      const bd = tx.businessDate();
      const order = tx.create('orders', {
        ...blankOrder(), id: idFormats.order(bd, tx.nextCounter(counterKeys.order())), order_type: 'DINE_IN',
        business_date: bd, table_id: table.id, table_label_snapshot: table.table_number, client_request_id: key,
      }, USER);
      tx.emit('table.status_changed', { table_id: table.id, status: 'OCCUPIED', order_id: order.id });
      return order;
    })).row;
  }

  @Patch('orders/:id')
  update(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateOrderDto) {
    return this.queue.run((tx) => {
      const order = tx.expectVersion('orders', id, version);
      const next = tx.update('orders', order, { customer_name: dto.customer_name ?? null }, USER);
      tx.emit('order.updated', { order_id: id, row_version: next.row_version });
      return next;
    });
  }

  @Post('orders/:id/kots')
  @HttpCode(201)
  async sendKot(@Param('id') id: string, @IdempotencyKey() key: string, @Body() dto: SendKotDto) {
    return (await this.queue.runIdempotent('kots', 'idempotency_key', key, (tx) => {
      const order = tx.get('orders', id);
      if (!order) throw new NotFoundError('orders', id);
      const bd = tx.businessDate();
      const n = tx.nextCounter(counterKeys.kot(bd));
      const kot = tx.create('kots', {
        id: idFormats.kot(bd, n), kot_number: n, business_date: bd, order_id: id, status: 'NEW',
        idempotency_key: key, sent_at: tx.now, served_at: null, hide_after: null,
      }, USER);
      let added = 0;
      for (const l of dto.lines) {
        const variant = tx.get('variants', l.variant_id);
        if (!variant) throw new NotFoundError('variants', l.variant_id);
        const line = buildOrderLine(tx.get('items', variant.item_id)!, variant, {
          id: idFormats.seq('OI', tx.nextCounter(counterKeys.seq('ORDER_ITEM'))), order_id: id, kot_id: kot.id,
          quantity: l.quantity, note: l.note ?? null, user_id: USER, now: tx.now,
        });
        tx.insert('order_items', line);
        added += toPaise(line.line_total);
      }
      const subtotal = toPaise(order.subtotal) + added;
      tx.update('orders', order, { subtotal: fromPaise(subtotal), grand_total: fromPaise(subtotal), balance_due: fromPaise(subtotal - toPaise(order.paid_amount)) }, USER);
      tx.emit('kot.created', { kot_id: kot.id, order_id: id, kot_number: n });
      if (order.table_id) tx.emit('table.status_changed', { table_id: order.table_id, status: 'OCCUPIED', order_id: id });
      return kot;
    })).row;
  }
}

function blankOrder(): Omit<Order, 'id' | 'order_type' | 'business_date' | 'client_request_id' | 'created_at' | 'created_by' | 'updated_at' | 'updated_by' | 'row_version'> {
  return {
    table_id: null, table_label_snapshot: null, token: null, customer_name: null, customer_phone: null,
    guest_count: null, status: 'OPEN', bill_no: null, subtotal: '0.00', discount_amount: '0.00',
    discount_reason: null, tax_amount: '0.00', round_off: '0.00', grand_total: '0.00', paid_amount: '0.00',
    balance_due: '0.00', merged_into_order_id: null, handed_over_at: null,
  };
}
