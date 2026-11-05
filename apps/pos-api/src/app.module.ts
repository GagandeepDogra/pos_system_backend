import { DynamicModule, Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { StorageService } from './storage/storage.service';

@Module({})
export class AppModule {
  /** The storage service is opened (locked and loaded) before Nest starts. */
  static register(storage: StorageService): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: StorageService, useValue: storage }],
      exports: [StorageService],
    };
  }
}
