// GET /api/v1/admin/reports/sales (getSalesReport) and GET /api/v1/admin/orders
// (searchOrders), Admin only (REQ-077, REQ-078, REQ-108).
import { Controller, Get, Query } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Roles } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { ApiError } from '../common/errors';
import { StorageService } from '../storage/storage.service';
import { OrderHit, SalesReport, salesReport, searchOrders } from './reports';

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DATE_MESSAGE = 'must be a date YYYY-MM-DD';

export class SalesReportQuery {
  @IsString() @Matches(DATE, { message: `from ${DATE_MESSAGE}` }) from!: string;
  @IsString() @Matches(DATE, { message: `to ${DATE_MESSAGE}` }) to!: string;
}

export class SearchOrdersQuery {
  @IsOptional() @IsString() @Matches(DATE, { message: `date ${DATE_MESSAGE}` }) date?: string;
  @IsOptional() @IsString() @MaxLength(16) bill_no?: string;
  @IsOptional() @IsString() @MaxLength(20) table?: string;
  @IsOptional() @IsString() @MaxLength(5) token?: string;
}

@Controller('admin')
export class ReportsController {
  constructor(private readonly storage: StorageService) {}

  @Get('reports/sales')
  @Roles(...PERMISSIONS.getSalesReport)
  sales(@Query() q: SalesReportQuery): Promise<SalesReport> {
    if (q.from > q.to) {
      throw new ApiError(400, 'INVALID_DATE_RANGE', 'The start date is after the end date.', 'शुरू की तारीख आख़िरी तारीख के बाद है।', { from: q.from, to: q.to });
    }
    return salesReport(this.storage, q.from, q.to);
  }

  @Get('orders')
  @Roles(...PERMISSIONS.searchOrders)
  search(@Query() q: SearchOrdersQuery): Promise<OrderHit[]> {
    const filters = Object.fromEntries(Object.entries(q).filter(([, v]) => typeof v === 'string' && v.trim() !== ''));
    return searchOrders(this.storage, filters);
  }
}
