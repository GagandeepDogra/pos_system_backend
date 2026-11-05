// Admin tables, staff and settings routes: createTable, updateTable, createUser,
// updateUser, resetUserPin, updateSettings (Admin only), and getSettings (all
// roles). bcrypt (hashing, Admin PIN clash pre-check) runs before the queue.
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { DiningTable, LANGUAGES, Language, ROLES, Role, Setting, User } from '@dhaba/shared';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { hashPin } from '../auth/pin';
import { IdempotencyKey, IfMatch } from '../common/headers';
import { MemoryIdempotency } from '../common/memory-idempotency';
import { publicUser } from '../auth/auth.service';
import { StorageService } from '../storage/storage.service';
import { AdminPinClashError, adminPinClashes, createTable, createUser, currentSettings, resetUserPin, updateSettings, updateTable, updateUser } from './admin-staff';

const PIN = /^\d{4,12}$/;
const PIN_MESSAGE = 'pin must be 4 to 12 digits';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const moneyText = ({ value }: { value: unknown }) => (typeof value === 'number' ? String(value) : value);
const nullable = (_: object, v: unknown) => v !== null;

export class CreateTableDto {
  @IsString() @IsNotEmpty() @MaxLength(10) table_number!: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(30) area?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsInt() @Min(1) @Max(99) seats?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpdateTableDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(10) table_number?: string;
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(30) area?: string | null;
  @IsOptional() @ValidateIf(nullable) @IsInt() @Min(1) @Max(99) seats?: number | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class CreateUserDto {
  @IsString() @IsNotEmpty() @MaxLength(40) display_name!: string;
  @IsIn(ROLES) role!: Role;
  /** 4+ digits (REQ-119); stored only as a bcrypt hash. */
  @IsString() @Matches(PIN, { message: PIN_MESSAGE }) pin!: string;
  @IsOptional() @IsIn(LANGUAGES) language?: Language;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpdateUserDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(40) display_name?: string;
  @IsOptional() @IsIn(ROLES) role?: Role;
  @IsOptional() @IsIn(LANGUAGES) language?: Language;
  @IsOptional() @IsBoolean() is_active?: boolean;
  /** true = Admin unlock: clears locked_until and failed_pin_count (REQ-025). */
  @IsOptional() @IsBoolean() unlock?: boolean;
  /** Also an unlock when sent as null / 0 (the fields themselves are server-owned). */
  @IsOptional() @IsIn([null]) locked_until?: null;
  @IsOptional() @IsIn([0]) failed_pin_count?: 0;
}

export class PinResetDto {
  @IsString() @Matches(PIN, { message: PIN_MESSAGE }) pin!: string;
}

export class SettingsDto {
  @IsString() @IsNotEmpty() @MaxLength(80) dhaba_name!: string;
  @IsString() @MaxLength(200) address!: string;
  @IsString() @MaxLength(15) phone!: string;
  /** Optional: null / omitted = not GST-registered. */
  @IsOptional() @ValidateIf(nullable) @IsString() @MaxLength(15) gst_number?: string | null;
  /** Optional: null / omitted = no tax line. 0–100, up to 2 decimals (checked by the service). */
  @IsOptional() @Transform(moneyText) @ValidateIf(nullable) @IsString() gst_rate_percent?: string | null;
  @IsString() @MaxLength(200) receipt_footer!: string;
  @Matches(HHMM, { message: 'token_reset_time must be HH:mm' }) token_reset_time!: string;
  @IsOptional() @ValidateIf(nullable) @Matches(HHMM, { message: 'shift_end_time must be HH:mm' }) shift_end_time?: string | null;
  @IsInt() @Min(1) @Max(240) late_kot_minutes!: number;
  @Transform(moneyText) @IsString() @IsNotEmpty() discount_limit_amount!: string;
  @IsOptional() @IsBoolean() kitchen_print_enabled?: boolean;
}

@Controller('admin')
export class AdminStaffController {
  private readonly idempotency = new MemoryIdempotency(() => this.storage.queue);

  constructor(private readonly storage: StorageService) {}

  @Post('tables')
  @Roles(...PERMISSIONS.createTable)
  createTable(@Body() dto: CreateTableDto, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<DiningTable> {
    return this.idempotency.once('tables', `${user.id}:createTable:${key}`, res, (tx) => createTable(tx, dto, user.id));
  }

  @Patch('tables/:id')
  @Roles(...PERMISSIONS.updateTable)
  updateTable(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateTableDto, @CurrentUser() user: SessionUser): Promise<DiningTable> {
    return this.storage.queue.run((tx) => updateTable(tx, id, version, dto, user.id));
  }

  @Post('users')
  @Roles(...PERMISSIONS.createUser)
  async createUser(@Body() dto: CreateUserDto, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<User> {
    const pinHash = await hashPin(dto.pin);
    const admin = dto.role === 'ADMIN' && dto.is_active !== false;
    const { checked, clash } = admin ? await adminPinClashes(this.storage.store.all('users'), dto.pin) : { checked: new Set<string>(), clash: false };
    return this.idempotency.once('users', `${user.id}:createUser:${key}`, res, (tx) => {
      // Thrown inside the change so a replayed key still answers 200.
      if (clash) throw new AdminPinClashError();
      return createUser(tx, { display_name: dto.display_name, role: dto.role, language: dto.language, is_active: dto.is_active }, dto.pin, pinHash, checked, user.id);
    }, (row) => publicUser(row as never));
  }

  @Patch('users/:id')
  @Roles(...PERMISSIONS.updateUser)
  updateUser(@Param('id') id: string, @IfMatch() version: number, @Body() dto: UpdateUserDto, @CurrentUser() user: SessionUser): Promise<User> {
    const unlock = dto.unlock === true || dto.locked_until === null || dto.failed_pin_count === 0;
    return this.storage.queue.run((tx) =>
      updateUser(tx, id, version, { display_name: dto.display_name, role: dto.role, language: dto.language, is_active: dto.is_active, unlock }, user.id));
  }

  @Post('users/:id/pin-reset')
  @HttpCode(200)
  @Roles(...PERMISSIONS.resetUserPin)
  async resetUserPin(@Param('id') id: string, @IfMatch() version: number, @Body() dto: PinResetDto, @CurrentUser() user: SessionUser): Promise<User> {
    const pinHash = await hashPin(dto.pin);
    const { checked, clash } = await adminPinClashes(this.storage.store.all('users'), dto.pin, id);
    return this.storage.queue.run((tx) => {
      // The pre-check matters only if the target is (still) an active Admin.
      const now = tx.get('users', id);
      if (clash && now && now.role === 'ADMIN' && now.is_active && now.row_version === version) throw new AdminPinClashError();
      return resetUserPin(tx, id, version, dto.pin, pinHash, checked, user.id);
    });
  }

  @Put('settings')
  @Roles(...PERMISSIONS.updateSettings)
  updateSettings(@IfMatch() version: number, @Body() dto: SettingsDto, @CurrentUser() user: SessionUser): Promise<Setting> {
    return this.storage.queue.run((tx) => updateSettings(tx, version, {
      dhaba_name: dto.dhaba_name, address: dto.address, phone: dto.phone, gst_number: dto.gst_number ?? null, gst_rate_percent: dto.gst_rate_percent ?? null,
      receipt_footer: dto.receipt_footer, token_reset_time: dto.token_reset_time, shift_end_time: dto.shift_end_time ?? null,
      late_kot_minutes: dto.late_kot_minutes, discount_limit_amount: dto.discount_limit_amount, kitchen_print_enabled: dto.kitchen_print_enabled ?? false,
    }, user.id));
  }
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly storage: StorageService) {}

  /** Dhaba settings for every role (receipt header, late-KOT minutes, the Admin form). */
  @Get()
  @Roles(...PERMISSIONS.getSettings)
  get(): Setting {
    return currentSettings(this.storage.store);
  }
}
