// GET /auth/staff, POST /auth/login, POST /auth/approvals, PATCH /me/language.
import { Body, Controller, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { LANGUAGES, Language, ROLES, Role } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { ApiError, NotFoundError, RowVersionConflictError } from '../common/errors';
import { IdempotencyKey, IfMatch } from '../common/headers';
import { StorageService } from '../storage/storage.service';
import { AuthService, findAdminByPin, publicUser } from './auth.service';
import { CurrentUser, Public, Roles, SessionUser } from './decorators';
import { PERMISSIONS } from './permissions';

const PIN_RULE = /^\d{4,12}$/;
const PIN_MESSAGE = 'pin must be 4 or more digits';

export class LoginDto {
  @IsString() @MaxLength(20) user_id!: string;
  @IsString() @Matches(PIN_RULE, { message: PIN_MESSAGE }) pin!: string;
  @IsOptional() @IsIn(ROLES) device_role?: Role | null;
}

export class ApprovalDto {
  @IsString() @Matches(PIN_RULE, { message: PIN_MESSAGE }) pin!: string;
}

export class LanguageDto {
  @IsIn(LANGUAGES) language!: Language;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly storage: StorageService) {}

  @Public()
  @Get('staff')
  staff() {
    return this.auth.loginStaff();
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  /** Admin PIN → single-use approval token, 2 min (REQ-023). Repeat key → the same approval, 200. */
  @Post('approvals')
  @Roles(...PERMISSIONS.createApproval)
  async approve(@CurrentUser() user: SessionUser, @IdempotencyKey() key: string, @Body() dto: ApprovalDto, @Res({ passthrough: true }) res: Response) {
    const scoped = `${user.id}:${key}`;
    const previous = this.auth.approvals.replay(scoped);
    if (previous) {
      res.status(200);
      return previous;
    }
    const admin = await findAdminByPin(this.storage.store.all('users'), dto.pin);
    if (!admin) {
      throw new ApiError(403, 'NOT_ADMIN_PIN', 'This PIN is not an Admin PIN.', 'यह एडमिन का PIN नहीं है।');
    }
    const approval = this.auth.approvals.issue(admin.id, user.id);
    await this.storage.queue.run((tx) =>
      writeAudit(tx, {
        action: 'APPROVAL', entity_type: 'users', entity_id: user.id, user_id: user.id,
        approver_id: admin.id, device_id: user.device_id, after_json: { expires_at: approval.expires_at },
      }),
    );
    this.auth.approvals.remember(scoped, approval);
    res.status(201);
    return approval;
  }
}

@Controller('me')
export class MeController {
  constructor(private readonly storage: StorageService) {}

  /** The caller's own language (REQ-008); other users are never touched. */
  @Patch('language')
  @Roles(...PERMISSIONS.updateMyLanguage)
  update(@CurrentUser() user: SessionUser, @IfMatch() version: number, @Body() dto: LanguageDto) {
    return this.storage.queue.run((tx) => {
      // Not tx.expectVersion: its 409 would carry the row with pin_hash.
      const row = tx.get('users', user.id);
      if (!row) throw new NotFoundError('users', user.id);
      if (row.row_version !== version) throw new RowVersionConflictError(publicUser(row));
      if (row.language === dto.language) return publicUser(row);
      const next = tx.update('users', row, { language: dto.language }, user.id);
      writeAudit(tx, {
        action: 'UPDATE', entity_type: 'users', entity_id: user.id, user_id: user.id, device_id: user.device_id,
        before_json: { language: row.language }, after_json: { language: next.language },
      });
      return publicUser(next);
    });
  }
}
