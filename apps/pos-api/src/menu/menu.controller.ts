// Menu read and daily availability: getMenu, setItemAvailability,
// markItemOutOfStock (REQ-042..046, REQ-056, REQ-074, REQ-104).
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Item } from '@dhaba/shared';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { ApiError } from '../common/errors';
import { IfMatch } from '../common/headers';
import { StorageService } from '../storage/storage.service';
import { setAvailability } from './availability';
import { MenuItem, readMenu } from './menu';

export class GetMenuQuery {
  /** 2+ characters; matches name_en, name_hi or short_code (REQ-046). */
  @IsOptional() @IsString() @MaxLength(60) q?: string;
}

export class SetAvailabilityDto {
  @IsBoolean() available_today!: boolean;
}

@Controller()
export class MenuController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Get('menu')
  @Roles(...PERMISSIONS.getMenu)
  getMenu(@Query() query: GetMenuQuery, @CurrentUser() user: SessionUser): MenuItem[] {
    if (query.q !== undefined && query.q.trim().length < 2) {
      throw new ApiError(400, 'SEARCH_TOO_SHORT', 'Type at least 2 letters to search.', 'खोजने के लिए कम से कम 2 अक्षर लिखें।', { min_length: 2 });
    }
    return readMenu(this.storage.store, this.auth.now(), { q: query.q, withPrices: user.role !== 'KITCHEN' });
  }

  @Post('kitchen/items/:id/out-of-stock')
  @HttpCode(200)
  @Roles(...PERMISSIONS.markItemOutOfStock)
  markItemOutOfStock(@Param('id') id: string, @CurrentUser() user: SessionUser): Promise<Item> {
    return this.storage.queue.run((tx) => setAvailability(tx, id, null, false, user.id, 'KITCHEN'));
  }

  /** Any role toggles today's flag; is_active is never touched (REQ-074). */
  @Patch('items/:id/availability')
  @Roles(...PERMISSIONS.setItemAvailability)
  setItemAvailability(@Param('id') id: string, @IfMatch() version: number, @Body() dto: SetAvailabilityDto, @CurrentUser() user: SessionUser): Promise<Item> {
    return this.storage.queue.run((tx) => setAvailability(tx, id, version, dto.available_today, user.id, 'TOGGLE'));
  }
}
