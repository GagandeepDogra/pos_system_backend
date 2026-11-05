// Admin menu routes: createCategory, updateCategory, createItem, updateItem,
// createVariant, updateVariant, changeVariantPrice (REQ-070..073, REQ-094).
// Admin only (PERMISSIONS; a denial writes an ACCESS_DENIED audit row in the
// AuthGuard). These sheets have no idempotency column, so creating POSTs keep
// their Idempotency-Key in memory for 24 h per user (DEC-004), checked inside
// the queue change: a repeat returns the created row with 200.
import { Body, Controller, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import { Category, FOOD_TYPES, FoodType, Item, PRICE_CHANGE_REASONS, PriceChange, PriceChangeReason, SheetName, Variant } from '@dhaba/shared';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { IdempotencyKey, IfMatch } from '../common/headers';
import { ServerDerived } from '../common/validation';
import { StorageService } from '../storage/storage.service';
import { Tx } from '../storage/write-queue';
import { changeVariantPrice, createCategory, createItem, createVariant, updateCategory, updateItem, updateVariant } from './admin-menu';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const moneyText = ({ value }: { value: unknown }) => (typeof value === 'number' ? String(value) : value);

export class CreateCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(40) name_en!: string;
  @IsString() @IsNotEmpty() @MaxLength(40) name_hi!: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) name_en?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) name_hi?: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class CreateItemDto {
  @IsString() @IsNotEmpty() @MaxLength(20) category_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) name_en!: string;
  @IsString() @IsNotEmpty() @MaxLength(60) name_hi!: string;
  /** 2–5 characters; checked by the service (400 SHORT_CODE_LENGTH). */
  @IsString() short_code!: string;
  @IsIn(FOOD_TYPES) food_type!: FoodType;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) photo_url?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(30) kitchen_station?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  /** Toggled through the availability routes, not here. */
  @ServerDerived() available_today?: unknown;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(20) category_id?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name_en?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name_hi?: string;
  @IsOptional() @IsString() short_code?: string;
  @IsOptional() @IsIn(FOOD_TYPES) food_type?: FoodType;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(200) photo_url?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(30) kitchen_station?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @ServerDerived() available_today?: unknown;
}

export class CreateVariantDto {
  @IsString() @IsNotEmpty() @MaxLength(30) name!: string;
  /** > 0, up to 2 decimals; checked by the service (400 PRICE_NOT_POSITIVE). */
  @Transform(moneyText) @IsString() @IsNotEmpty() price!: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @ServerDerived() item_id?: unknown;
}

export class UpdateVariantDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(30) name?: string;
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
  /** Ignored: only POST /admin/variants/:id/price-changes changes a price (REQ-072). */
  @ServerDerived() price?: unknown;
  @ServerDerived() item_id?: unknown;
}

export class PriceChangeDto {
  @Transform(moneyText) @IsString() @IsNotEmpty() new_price!: string;
  /** Mandatory reason picker (REQ-094): MARKET_RATE | NEW_SEASON | CORRECTION | OTHER. */
  @IsIn(PRICE_CHANGE_REASONS, { message: `reason must be one of ${PRICE_CHANGE_REASONS.join(', ')}` }) reason!: PriceChangeReason;
  @ServerDerived() old_price?: unknown;
  @ServerDerived() variant_id?: unknown;
}

@Controller('admin')
export class AdminMenuController {
  /** `${user}:${op}:${key}` → the created row, kept 24 h in memory. */
  private readonly createdKeys = new Map<string, { sheet: SheetName; id: string; expiresMs: number }>();

  constructor(private readonly storage: StorageService) {}

  @Post('categories')
  @Roles(...PERMISSIONS.createCategory)
  createCategory(@Body() dto: CreateCategoryDto, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<Category> {
    return this.once('categories', `${user.id}:createCategory:${key}`, res, (tx) => createCategory(tx, dto, user.id));
  }

  @Patch('categories/:id')
  @Roles(...PERMISSIONS.updateCategory)
  updateCategory(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateCategoryDto, @CurrentUser() user: SessionUser): Promise<Category> {
    return this.storage.queue.run((tx) => updateCategory(tx, id, version, dto, user.id));
  }

  @Post('items')
  @Roles(...PERMISSIONS.createItem)
  createItem(@Body() dto: CreateItemDto, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<Item> {
    return this.once('items', `${user.id}:createItem:${key}`, res, (tx) => createItem(tx, dto, user.id));
  }

  @Patch('items/:id')
  @Roles(...PERMISSIONS.updateItem)
  updateItem(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateItemDto, @CurrentUser() user: SessionUser): Promise<Item> {
    return this.storage.queue.run((tx) => updateItem(tx, id, version, dto, user.id));
  }

  @Post('items/:id/variants')
  @Roles(...PERMISSIONS.createVariant)
  createVariant(@Param('id') itemId: string, @Body() dto: CreateVariantDto, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<Variant> {
    return this.once('variants', `${user.id}:createVariant:${itemId}:${key}`, res, (tx) => createVariant(tx, itemId, { name: dto.name, price: dto.price, sort_order: dto.sort_order, is_active: dto.is_active }, user.id));
  }

  @Patch('variants/:id')
  @Roles(...PERMISSIONS.updateVariant)
  updateVariant(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateVariantDto, @CurrentUser() user: SessionUser): Promise<Variant> {
    return this.storage.queue.run((tx) => updateVariant(tx, id, version, { name: dto.name, sort_order: dto.sort_order, is_active: dto.is_active }, user.id));
  }

  @Post('variants/:id/price-changes')
  @Roles(...PERMISSIONS.changeVariantPrice)
  changeVariantPrice(@Param('id') id: string, @IfMatch() version: number, @Body() dto: PriceChangeDto, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<PriceChange> {
    return this.once('price_changes', `${user.id}:changeVariantPrice:${id}:${key}`, res, (tx) => changeVariantPrice(tx, id, version, { new_price: dto.new_price, reason: dto.reason }, user.id));
  }

  /** Runs a creating change once per key (201); a repeat returns the stored row (200) without writing. */
  private async once<T extends { id: string }>(sheet: SheetName, scoped: string, res: Response, create: (tx: Tx) => T): Promise<T> {
    const now = Date.now();
    let replayed = false;
    const row = await this.storage.queue.run((tx) => {
      const hit = this.createdKeys.get(scoped);
      const stored = hit && hit.expiresMs > now ? (tx.get(hit.sheet, hit.id) as unknown as T | undefined) : undefined;
      if (stored) {
        replayed = true;
        return stored;
      }
      const created = create(tx);
      this.createdKeys.set(scoped, { sheet, id: created.id, expiresMs: now + IDEMPOTENCY_TTL_MS });
      return created;
    }).catch((err) => {
      if (!replayed) this.createdKeys.delete(scoped);
      throw err;
    });
    res.status(replayed ? 200 : 201);
    this.prune(now);
    return row;
  }

  private prune(now: number): void {
    if (this.createdKeys.size < 1000) return;
    for (const [k, v] of this.createdKeys) if (v.expiresMs <= now) this.createdKeys.delete(k);
  }
}
