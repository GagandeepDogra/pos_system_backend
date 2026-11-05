// `npm run create-admin`: with the server stopped, adds the first Admin to the
// workbook (ADMIN_NAME, ADMIN_PIN). Refused once an active Admin exists.
import { createFirstAdmin } from './auth/first-admin';
import { loadConfig } from './config';
import { StorageService } from './storage/storage.service';

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new StorageService({ dataDir: config.dataDir, sheetPassword: config.sheetPassword });
  await storage.open();
  try {
    if (storage.state !== 'ready') throw new Error('the live workbook is not readable; run `npm run recover` first');
    const admin = await createFirstAdmin(storage, process.env.ADMIN_NAME ?? 'Owner', process.env.ADMIN_PIN ?? '');
    await storage.save();
    console.log(`Created Admin ${admin.display_name} (${admin.id}).`);
  } finally {
    storage.close();
  }
}

main().catch((err) => {
  console.error(`create-admin failed: ${(err as Error).message}`);
  process.exit(1);
});
