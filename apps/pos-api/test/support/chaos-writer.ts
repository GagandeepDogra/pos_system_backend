// Child process for the kill -9 chaos test: opens the data folder and keeps
// writing orders, KOTs and payments, printing each key once it is confirmed.
// Usage: node -r ./ts-register.js chaos-writer.ts <dataDir> <prefix>
import { StorageService } from '../../src/storage/storage.service';
import { openTakeaway, recordPayment, sendKot } from './pos-ops';

async function main(): Promise<void> {
  const [dataDir, prefix] = process.argv.slice(2);
  const s = new StorageService({ dataDir, sheetPassword: 'x' });
  await s.open();
  process.stdout.write('READY\n');
  // Save now and then like the coalesced saver will, so kills also land mid-save.
  setInterval(() => void s.save().catch(() => undefined), 150);
  for (let i = 0; ; i++) {
    const tag = `${prefix}-${i}`;
    const order = await openTakeaway(s.queue, `ord-${tag}`);
    process.stdout.write(`OK orders ord-${tag}\n`);
    await sendKot(s.queue, order.row.id, `kot-${tag}`, [{ variantId: 'VAR-2', qty: 3 }]);
    process.stdout.write(`OK kots kot-${tag}\n`);
    await recordPayment(s.queue, order.row.id, `pay-${tag}`, '60.00');
    process.stdout.write(`OK payments pay-${tag}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err));
  process.exit(1);
});
