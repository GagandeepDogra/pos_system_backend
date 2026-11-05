import { Controller, Get } from '@nestjs/common';
import { StartingError } from '../common/errors';
import { nowIst } from '../common/time';
import { RecoveryOffer, StorageService } from '../storage/storage.service';

export interface HealthBody {
  status: 'green' | 'red';
  workbook: { loaded: boolean; last_saved_at?: string | null; last_save_error?: string | null; unsaved_changes?: number };
  /** 'Saving problem, call owner' while a save or journal write is failing (REQ-117). */
  alert?: StorageService['saveAlert'];
  journal?: { last_seq: number; last_error: string | null; replayed_at_startup: number };
  queue?: { depth: number };
  backups?: { last_snapshot: string | null; last_snapshot_at: string | null; last_snapshot_error: string | null };
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
    const b = s.backups;
    // A failed snapshot is reported but does not turn health red: the live file and journal are fine.
    const red = Boolean(s.lastJournalError || s.lastSaveError);
    return {
      status: red ? 'red' : 'green',
      workbook: {
        loaded: true,
        last_saved_at: s.lastSavedAt,
        last_save_error: s.lastSaveError,
        unsaved_changes: Math.max(0, s.journal.lastSeq - s.lastSavedSeq),
      },
      alert: s.saveAlert,
      journal: { last_seq: s.journal.lastSeq, last_error: s.lastJournalError, replayed_at_startup: s.replayed },
      queue: { depth: s.queue.depth },
      backups: {
        last_snapshot: b.lastSnapshot?.name ?? null,
        last_snapshot_at: b.lastSnapshot ? nowIst(b.lastSnapshot.at) : null,
        last_snapshot_error: b.lastSnapshotError,
      },
    };
  }
}
