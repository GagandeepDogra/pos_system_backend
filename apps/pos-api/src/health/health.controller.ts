import { Controller, Get } from '@nestjs/common';
import { StartingError } from '../common/errors';
import { RecoveryOffer, StorageService } from '../storage/storage.service';

export interface HealthBody {
  status: 'green' | 'red';
  workbook: { loaded: boolean; last_saved_at?: string | null; last_save_error?: string | null };
  journal?: { last_seq: number; last_error: string | null; replayed_at_startup: number };
  queue?: { depth: number };
  recovery?: RecoveryOffer;
}

/** Server, workbook and last-write status. 503 until startup load, migration and replay finish. */
@Controller('health')
export class HealthController {
  constructor(private readonly storage: StorageService) {}

  @Get()
  getHealth(): HealthBody {
    const s = this.storage;
    if (s.state === 'loading') throw new StartingError();
    if (s.state === 'corrupt') {
      return { status: 'red', workbook: { loaded: false }, recovery: s.recoveryOffer ?? undefined };
    }
    const red = Boolean(s.lastJournalError || s.lastSaveError);
    return {
      status: red ? 'red' : 'green',
      workbook: { loaded: true, last_saved_at: s.lastSavedAt, last_save_error: s.lastSaveError },
      journal: { last_seq: s.journal.lastSeq, last_error: s.lastJournalError, replayed_at_startup: s.replayed },
      queue: { depth: s.queue.depth },
    };
  }
}
