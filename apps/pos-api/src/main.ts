import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { FolderLockedError } from './storage/folder-lock';
import { StorageService } from './storage/storage.service';
import { WorkbookValidationError } from './storage/workbook-codec';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const storage = new StorageService({ dataDir: config.dataDir, sheetPassword: config.sheetPassword });
  try {
    await storage.open();
  } catch (err) {
    if (err instanceof FolderLockedError || err instanceof WorkbookValidationError) {
      console.error(`pos-api refused to start: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const release = (): void => storage.close();
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const app = await NestFactory.create(AppModule.register(storage));
  app.setGlobalPrefix('api/v1');
  await app.listen(config.port, config.host);
  console.log(`pos-api listening on http://${config.host}:${config.port}/api/v1 (data: ${config.dataDir})`);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
