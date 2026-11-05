// Print bill and discounts: printBill, applyDiscount (REQ-059, REQ-060, REQ-061, REQ-102).
import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DISCOUNT_TYPES, DiscountType } from '@dhaba/shared';
import { AuthService } from '../auth/auth.service';
import { ApprovalToken, CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { ApiError } from '../common/errors';
import { IfMatch } from '../common/headers';
import { ServerDerived } from '../common/validation';
import { OrderView, orderView } from '../orders/dine-in';
import { StorageService } from '../storage/storage.service';
import { applyDiscount, printBill } from './bill';

const MONEY = /^\d{1,7}(\.\d{1,2})?$/;

export class ApplyDiscountDto {
  /** FIXED (default) = `amount` rupees; PERCENT = `percent` of the subtotal. */
  @IsOptional() @IsIn(DISCOUNT_TYPES) discount_type?: DiscountType;
  /** Rupees, up to 2 dp, e.g. "50" or "49.50". Required for FIXED. */
  @IsOptional() @IsString() @Matches(MONEY, { message: 'amount must be a rupee amount with up to 2 decimals' }) amount?: string;
  /** 0–100, up to 2 dp. Required for PERCENT. */
  @IsOptional() @IsString() @Matches(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/, { message: 'percent must be between 0 and 100' }) percent?: string;
  /** Short reason code, e.g. REGULAR_CUSTOMER. One of reason_code / reason_text / reason is required. */
  @IsOptional() @IsString() @MaxLength(20) reason_code?: string;
  @IsOptional() @IsString() @MaxLength(80) reason_text?: string;
  /** Alias of reason_text. */
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
  // The server computes every total (REQ-059, REQ-102).
  @ServerDerived() subtotal?: unknown;
  @ServerDerived() discount_amount?: unknown;
  @ServerDerived() tax_amount?: unknown;
  @ServerDerived() round_off?: unknown;
  @ServerDerived() grand_total?: unknown;
  @ServerDerived() balance_due?: unknown;
}

const badRequest = (code: string, en: string, hi: string, field: string) => new ApiError(400, code, en, hi, { field });

@Controller('orders')
export class BillingController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Post(':id/bill')
  @HttpCode(200)
  @Roles(...PERMISSIONS.printBill)
  async printBill(@Param('id') id: string, @IfMatch() version: number, @CurrentUser() user: SessionUser): Promise<OrderView> {
    const order = await this.storage.queue.run((tx) => printBill(tx, id, version, user));
    return orderView(this.storage.store, order);
  }

  @Post(':id/discount')
  @HttpCode(200)
  @Roles(...PERMISSIONS.applyDiscount)
  async applyDiscount(
    @Param('id') id: string,
    @IfMatch() version: number,
    @ApprovalToken() approvalToken: string | null,
    @Body() dto: ApplyDiscountDto,
    @CurrentUser() user: SessionUser,
  ): Promise<OrderView> {
    const reasonText = (dto.reason_text ?? dto.reason ?? '').trim() || null;
    const reasonCode = (dto.reason_code ?? '').trim();
    if (!reasonText && !reasonCode) {
      throw badRequest('REASON_REQUIRED', 'Give a reason for the discount.', 'छूट का कारण बताएँ।', 'reason_text');
    }
    const type = dto.discount_type ?? 'FIXED';
    const value = type === 'FIXED' ? dto.amount : dto.percent;
    if (value === undefined) {
      const field = type === 'FIXED' ? 'amount' : 'percent';
      throw badRequest('VALIDATION_FAILED', `Enter the discount ${field}.`, 'छूट की रकम या प्रतिशत डालें।', field);
    }
    const order = await this.storage.queue.run((tx) => applyDiscount(tx, id, version, {
      discount_type: type, value, reason_code: reasonCode || 'OTHER', reason_text: reasonText, approvalToken,
    }, user, (token, userId) => this.auth.approvals.consume(token, userId)));
    return orderView(this.storage.store, order);
  }
}
