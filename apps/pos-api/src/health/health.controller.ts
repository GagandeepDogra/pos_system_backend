import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { StorageService } from '../storage/storage.service';

/** Minimal health report; the write-queue work adds last-save/journal status. */
@Controller('health')
export class HealthController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  getHealth(): { status: 'green' | 'red'; workbook: { loaded: boolean } } {
    if (!this.storage.loaded) {
      throw new HttpException(
        { code: 'STARTING', message_en: 'Server is starting', message_hi: 'सर्वर शुरू हो रहा है', details: null },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return { status: 'green', workbook: { loaded: true } };
  }
}
