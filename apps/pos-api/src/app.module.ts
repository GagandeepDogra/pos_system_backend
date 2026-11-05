import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { StartupGuard } from './common/startup.guard';
import { HealthController } from './health/health.controller';
import { BackupService } from './storage/backup.service';
import { StorageService } from './storage/storage.service';
import { WriteQueue } from './storage/write-queue';

@Module({})
export class AppModule {
  /**
   * The folder lock is taken before Nest starts; the workbook may still be
   * loading (StartupGuard answers 503 until it is ready).
   */
  static register(storage: StorageService, extraControllers: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ...extraControllers],
      providers: [
        { provide: StorageService, useValue: storage },
        { provide: WriteQueue, useValue: storage.queue },
        { provide: BackupService, useValue: storage.backups },
        { provide: APP_GUARD, useClass: StartupGuard },
      ],
      exports: [StorageService, WriteQueue, BackupService],
    };
  }
}
