// The active takeaway list and handover: listActiveTakeaways, handOverTakeaway
// (REQ-040, REQ-041). createTakeaway lives in orders.controller.ts.
import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Order } from '@dhaba/shared';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { IfMatch } from '../common/headers';
import { StorageService } from '../storage/storage.service';
import { ActiveTakeaway, activeTakeaways, handOver } from './takeaway';

@Controller('takeaways')
export class TakeawaysController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  @Roles(...PERMISSIONS.listActiveTakeaways)
  list(): ActiveTakeaway[] {
    return activeTakeaways(this.storage.store);
  }

  @Post(':id/handover')
  @HttpCode(200)
  @Roles(...PERMISSIONS.handOverTakeaway)
  handOver(@Param('id') id: string, @IfMatch() version: number, @CurrentUser() user: SessionUser): Promise<Order> {
    return this.storage.queue.run((tx) => handOver(tx, id, version, user));
  }
}
