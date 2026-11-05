// Open bills, payments, voids, close with exception and the receipt print log:
// listOpenBills, recordPayment, voidPayment, closeWithException,
// recordReceiptPrint (REQ-062..069).
import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { CLOSE_REASON_CODES, CloseReasonCode, PAYMENT_METHODS, Payment, PaymentMethod, Setting } from '@dhaba/shared';
import { AuthService } from '../auth/auth.service';
import { ApprovalToken, CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { ApiError, NotFoundError } from '../common/errors';
import { IdempotencyKey, IfMatch } from '../common/headers';
import { ServerDerived } from '../common/validation';
import { OrderView, orderView } from '../orders/dine-in';
import { StorageService } from '../storage/storage.service';
import { OpenBill, changeDue, closeWithException, logReceiptPrint, openBills, recordPayment, voidPayment } from './payments';

const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export class RecordPaymentDto {
  @IsIn(PAYMENT_METHODS) method!: PaymentMethod;
  /** Rupees, up to 2 dp, above zero and at most the balance due. */
  @IsString() @Matches(MONEY, { message: 'amount must be a rupee amount with up to 2 decimals' }) amount!: string;
  /** Cash only: the note(s) handed over, for the change (REQ-063). */
  @IsOptional() @IsString() @Matches(MONEY, { message: 'tendered_amount must be a rupee amount with up to 2 decimals' }) tendered_amount?: string | null;
  /** UPI only, optional UTR. */
  @IsOptional() @IsString() @MaxLength(30) upi_ref?: string | null;
  @ServerDerived() balance_due?: unknown;
  @ServerDerived() change_due?: unknown;
}

export class VoidPaymentDto {
  @IsOptional() @IsString() @MaxLength(80) void_reason?: string;
  /** Alias of void_reason. */
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
}

export class CloseWithExceptionDto {
  /** COMPLIMENTARY | CUSTOMER_LEFT | STAFF_MEAL | OTHER (OTHER needs reason_text). */
  @IsOptional() @IsIn(CLOSE_REASON_CODES) reason_code?: CloseReasonCode;
  @IsOptional() @IsString() @MaxLength(80) reason_text?: string;
  /** Alias of reason_text. */
  @IsOptional() @IsString() @MaxLength(80) reason?: string;
  @ServerDerived() amount?: unknown;
}

export type PaymentResponse = Payment & { change_due: string | null };
export type ReceiptResponse = OrderView & { settings: Setting | null; print: { action: string; print_count: number } };

const reasonRequired = (field: string, en: string, hi: string) => new ApiError(400, 'REASON_REQUIRED', en, hi, { field });

@Controller()
export class PaymentsController {
  /** Receipt-print Idempotency-Keys (per user) → the logged print, kept 24 h in memory (DEC-004). */
  private readonly printKeys = new Map<string, { print: { action: string; print_count: number }; expiresMs: number }>();

  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Get('bills/open')
  @Roles(...PERMISSIONS.listOpenBills)
  listOpenBills(): OpenBill[] {
    return openBills(this.storage.store);
  }

  @Post('orders/:id/payments')
  @Roles(...PERMISSIONS.recordPayment)
  async recordPayment(
    @Param('id') id: string,
    @IdempotencyKey() key: string,
    @Body() dto: RecordPaymentDto,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PaymentResponse> {
    const input = { method: dto.method, amount: dto.amount, tendered_amount: dto.tendered_amount ?? null, upi_ref: dto.upi_ref?.trim() || null };
    const { replayed, row } = await this.storage.queue.runIdempotent('payments', 'idempotency_key', key, (tx) => recordPayment(tx, id, input, key, user));
    if (replayed && row.order_id !== id) {
      throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This payment key was already used for another order.', 'यह भुगतान कुंजी दूसरे ऑर्डर के लिए इस्तेमाल हो चुकी है।', { payment_id: row.id });
    }
    res.status(replayed ? 200 : 201);
    return { ...row, change_due: changeDue(row) };
  }

  @Post('payments/:id/void')
  @HttpCode(200)
  @Roles(...PERMISSIONS.voidPayment)
  async voidPayment(
    @Param('id') id: string,
    @IfMatch() version: number,
    @ApprovalToken() approvalToken: string | null,
    @Body() dto: VoidPaymentDto,
    @CurrentUser() user: SessionUser,
  ): Promise<Payment> {
    const reason = (dto.void_reason ?? dto.reason ?? '').trim();
    if (!reason) throw reasonRequired('void_reason', 'Give a reason for voiding the payment.', 'भुगतान रद्द करने का कारण बताएँ।');
    return this.storage.queue.run((tx) =>
      voidPayment(tx, id, version, reason, approvalToken, user, (token, userId) => this.auth.approvals.consume(token, userId)));
  }

  @Post('orders/:id/close-exception')
  @HttpCode(200)
  @Roles(...PERMISSIONS.closeWithException)
  async closeWithException(
    @Param('id') id: string,
    @IfMatch() version: number,
    @ApprovalToken() approvalToken: string | null,
    @Body() dto: CloseWithExceptionDto,
    @CurrentUser() user: SessionUser,
  ): Promise<OrderView> {
    const text = (dto.reason_text ?? dto.reason ?? '').trim() || null;
    const code: CloseReasonCode | undefined = dto.reason_code ?? (text ? 'OTHER' : undefined);
    if (!code || (code === 'OTHER' && !text)) {
      throw reasonRequired(code ? 'reason_text' : 'reason_code', 'Choose why the order is closed with a balance.', 'बकाया के साथ बंद करने का कारण चुनें।');
    }
    const order = await this.storage.queue.run((tx) =>
      closeWithException(tx, id, version, { reason_code: code, reason_text: text, approvalToken }, user, (token, userId) => this.auth.approvals.consume(token, userId)));
    return orderView(this.storage.store, order);
  }

  @Post('orders/:id/receipt-prints')
  @HttpCode(201)
  @Roles(...PERMISSIONS.recordReceiptPrint)
  async recordReceiptPrint(@Param('id') id: string, @IdempotencyKey() key: string, @CurrentUser() user: SessionUser): Promise<ReceiptResponse> {
    const order = this.storage.store.get('orders', id);
    if (!order) throw new NotFoundError('orders', id);
    const scoped = `${user.id}:${id}:${key}`;
    const now = Date.now();
    // Checked and remembered inside the serial change, so a double tap logs one row.
    const print = await this.storage.queue.run((tx) => {
      const hit = this.printKeys.get(scoped);
      if (hit && hit.expiresMs > now) return hit.print;
      const logged = logReceiptPrint(tx, id, user);
      this.printKeys.set(scoped, { print: logged, expiresMs: now + IDEMPOTENCY_TTL_MS });
      return logged;
    }).catch((err) => {
      this.printKeys.delete(scoped);
      throw err;
    });
    this.prune(now);
    return { ...orderView(this.storage.store, this.storage.store.get('orders', id)!), settings: this.storage.store.all('settings')[0] ?? null, print };
  }

  private prune(now: number): void {
    if (this.printKeys.size < 1000) return;
    for (const [k, v] of this.printKeys) if (v.expiresMs <= now) this.printKeys.delete(k);
  }
}
