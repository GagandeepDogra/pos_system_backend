import { DynamicModule, Module, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController, MeController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { BillingController } from './billing/billing.controller';
import { AuthOptions, AuthService } from './auth/auth.service';
import { StartupGuard } from './common/startup.guard';
import { HealthController } from './health/health.controller';
import { KotsController } from './kitchen/kots.controller';
import { MenuController } from './menu/menu.controller';
import { OrdersController } from './orders/orders.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { BackupService } from './storage/backup.service';
import { StorageService } from './storage/storage.service';
import { WriteQueue } from './storage/write-queue';
import { TablesController } from './tables/tables.controller';

/** Feature controllers of the API contract; every app (main.ts and tests) gets them. */
export const FEATURE_CONTROLLERS: Type[] = [TablesController, OrdersController, MenuController, KotsController, BillingController];

@Module({})
export class AppModule {
  /**
   * The folder lock is taken before Nest starts; the workbook may still be
   * loading (StartupGuard answers 503 until it is ready). Call configureApp()
   * (app.setup.ts) on the created app for the prefix, pipes, filter and sockets.
   * Guards run in order: StartupGuard, then AuthGuard (Bearer JWT + @Roles).
   * `auth` may be an AuthService instance (tests that move its clock) or its options.
   */
  static register(
    storage: StorageService,
    extraControllers: Type[] = [],
    extraProviders: Type[] = [],
    auth: AuthOptions | AuthService = {},
  ): DynamicModule {
    const authService = auth instanceof AuthService ? auth : new AuthService(storage, auth);
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MeController, ...FEATURE_CONTROLLERS, ...extraControllers],
      providers: [
        { provide: StorageService, useValue: storage },
        { provide: WriteQueue, useValue: storage.queue },
        { provide: BackupService, useValue: storage.backups },
        { provide: AuthService, useValue: authService },
        { provide: APP_GUARD, useClass: StartupGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        RealtimeGateway,
        ...extraProviders,
      ],
      exports: [StorageService, WriteQueue, BackupService, AuthService, RealtimeGateway],
    };
  }
}
