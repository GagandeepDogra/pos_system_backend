import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { HealthController } from '../health/health.controller';
import { StorageService } from '../storage/storage.service';
import { StartingError, WritesBlockedError } from './errors';

/**
 * REQ-105: every route except /health answers 503 until the workbook is
 * loaded, migrated and the journal replayed; and while the live workbook is
 * corrupt (the health body then carries the recovery offer).
 */
@Injectable()
export class StartupGuard implements CanActivate {
  constructor(private readonly storage: StorageService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getClass() === HealthController) return true;
    if (this.storage.state === 'loading') throw new StartingError();
    if (this.storage.state === 'corrupt') throw new WritesBlockedError('workbook is corrupt');
    return true;
  }
}
