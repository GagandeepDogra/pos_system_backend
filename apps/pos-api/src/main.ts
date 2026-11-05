import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfig, loadConfig } from './config';
import { restrictDataFolder } from './deploy/data-folder';
import { applyProfile, createHttpsRedirectServer } from './deploy/hardening';
import { OffsiteCopyScheduler } from './deploy/offsite-copy';
import { DeployConfigError, readTlsOptions } from './deploy/profile';
import { FolderLockedError } from './storage/folder-lock';
import { JournalCorruptError } from './storage/journal';
import { StorageService } from './storage/storage.service';

function refuse(err: Error): never {
  console.error(`pos-api refused to start: ${err.message}`);
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof DeployConfigError) refuse(err);
    throw err;
  }
  const { deploy } = config;
  const access = restrictDataFolder(config.dataDir);
  if (access.tightened) console.log(`pos-api: data folder ${config.dataDir} was readable by others; set to mode ${access.mode}`);
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
  const app = await NestFactory.create(AppModule.register(storage), {
    httpsOptions: deploy.tls ? readTlsOptions(deploy.tls) : undefined,
  });
  configureApp(app, { webDir: config.webDir });
  applyProfile(app, deploy);
  await app.listen(config.port, config.host);
  const scheme = deploy.tls ? 'https' : 'http';
  console.log(
    `pos-api (${deploy.name} profile) listening on ${scheme}://${config.host}:${config.port}/api/v1 (data: ${config.dataDir})`,
  );
  if (deploy.tls && deploy.httpRedirectPort) {
    createHttpsRedirectServer(config.port).listen(deploy.httpRedirectPort, config.host);
    console.log(`pos-api: plain HTTP on port ${deploy.httpRedirectPort} only redirects to HTTPS`);
  }

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
  storage.startAutoSave({ onError: (err) => console.error(`pos-api: workbook save failed (will retry): ${err.message}`) });
  storage.backups.startScheduler({
    openHours: config.snapshotOpenHours,
    onError: (err) => console.error(`pos-api: automatic snapshot failed: ${err.message}`),
  });
  if (deploy.offsiteBackupDir) {
    const offsite = new OffsiteCopyScheduler(storage.backups, {
      dir: deploy.offsiteBackupDir,
      time: deploy.offsiteBackupTime,
      onCopied: (copy) => console.log(`pos-api: nightly off-server backup copied to ${copy.file}`),
      onError: (err) => console.error(`pos-api: nightly off-server backup failed: ${err.message}`),
    });
    offsite.start();
    process.on('exit', () => offsite.stop());
  }
  console.log(`pos-api ready (journal seq ${storage.journal.lastSeq}, replayed ${storage.replayed})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
