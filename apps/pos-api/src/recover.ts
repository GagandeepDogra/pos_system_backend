// `npm run recover`: with the server stopped, accepts the recovery offer for a
// corrupt live workbook (newest valid backup + journal replay).
import { loadConfig } from './config';
import { StorageService } from './storage/storage.service';

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new StorageService({ dataDir: config.dataDir, sheetPassword: config.sheetPassword });
  await storage.open();
  try {
    if (storage.state !== 'corrupt') {
      console.log('The live workbook is valid; nothing to recover.');
      return;
    }
    const r = await storage.recoverFromBackup();
    console.log(`Recovered from ${r.backup}, replayed ${r.replayed} journal entries.`);
    if (r.corruptCopy) console.log(`The corrupt file was kept as ${r.corruptCopy}.`);
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error(`recover failed: ${(err as Error).message}`);
  process.exit(1);
});
