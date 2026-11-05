import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { FolderLockedError } from './storage/folder-lock';
import { JournalCorruptError } from './storage/journal';
import { StorageService } from './storage/storage.service';

function refuse(err: Error): never {
  console.error(`pos-api refused to start: ${err.message}`);
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const storage = new StorageService({ dataDir: config.dataDir, sheetPassword: config.sheetPassword });
  try {
    storage.lockFolder();
  } catch (err) {
    if (err instanceof FolderLockedError) refuse(err);
    throw err;
  }
  process.on('exit', () => storage.close());
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  // Listen first so /health can answer 503 while the workbook loads; every
  // other route is refused until loading, migration and journal replay finish.
  const app = await NestFactory.create(AppModule.register(storage));
  app.setGlobalPrefix('api/v1');
  await app.listen(config.port, config.host);
  console.log(`pos-api listening on http://${config.host}:${config.port}/api/v1 (data: ${config.dataDir})`);

  try {
    await storage.load();
  } catch (err) {
    if (err instanceof JournalCorruptError) refuse(err);
    throw err;
  }
  if (storage.state === 'corrupt') {
    const offer = storage.recoveryOffer!;
    console.error(`pos-api: the live workbook is corrupt, writes are blocked:\n  ${offer.errors.join('\n  ')}`);
    console.error(
      offer.backup
        ? `Recovery offered: newest valid backup ${offer.backup} plus ${offer.journal_entries_to_replay} journal entries.` +
            ' Stop the server and run `npm run recover` to accept it.'
        : 'No valid backup found in backups/.',
    );
    return;
  }
  storage.backups.startScheduler({
    openHours: config.snapshotOpenHours,
    onError: (err) => console.error(`pos-api: automatic snapshot failed: ${err.message}`),
  });
  console.log(`pos-api ready (journal seq ${storage.journal.lastSeq}, replayed ${storage.replayed})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
