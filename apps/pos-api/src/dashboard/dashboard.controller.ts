// GET /api/v1/dashboard — getDashboard (REQ-028, REQ-029, REQ-030, REQ-020, REQ-021, REQ-117).
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { AuthService } from '../auth/auth.service';
import { PERMISSIONS } from '../auth/permissions';
import { StorageService } from '../storage/storage.service';
import { Dashboard, buildDashboard } from './dashboard';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly storage: StorageService, private readonly auth: AuthService) {}

  @Get()
  @Roles(...PERMISSIONS.getDashboard)
  get(@CurrentUser() user: SessionUser): Dashboard {
    return buildDashboard(this.storage, user.role, this.auth.now());
  }
}
