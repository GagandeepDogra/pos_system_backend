// GET /api/v1/tables — listTables (REQ-032, REQ-033, REQ-036, REQ-029).
import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TABLE_STATUSES, TableStatus } from '@dhaba/shared';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { AuthService } from '../auth/auth.service';
import { PERMISSIONS } from '../auth/permissions';
import { StorageService } from '../storage/storage.service';
import { TableCard, activeOrderForTable, compareTableNumbers, tableCard } from './table-status';

export class ListTablesQuery {
  /** Area tab; omit for All (tables with no area appear only under All). */
  @IsOptional() @IsString() @MaxLength(30) area?: string;
  /** e.g. OCCUPIED for the dashboard's Active tables tile. */
  @IsOptional() @IsIn(TABLE_STATUSES) status?: TableStatus;
}

@Controller('tables')
export class TablesController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Get()
  @Roles(...PERMISSIONS.listTables)
  list(@Query() query: ListTablesQuery, @CurrentUser() user: SessionUser): TableCard[] {
    const store = this.storage.store;
    const now = this.auth.now();
    const withAmounts = user.role !== 'KITCHEN';
    return store
      .all('tables')
      .filter((t) => t.is_active && (query.area === undefined || t.area === query.area))
      .sort(compareTableNumbers)
      .map((t) => tableCard(t, activeOrderForTable(store, t.id), now, withAmounts))
      .filter((card) => query.status === undefined || card.status === query.status);
  }
}
