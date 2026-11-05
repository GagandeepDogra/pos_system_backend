import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { StorageService, WORKBOOK_FILE } from '../src/storage/storage.service';
import { writeWorkbookFile } from '../src/storage/workbook-file';
import { seededData, tempDir } from './fixtures';

const SUPPORT = path.join(__dirname, 'support');

/** Starts the writer, kills it with SIGKILL after `afterConfirmed` confirmations, returns the confirmed keys. */
function runAndKill(dir: string, prefix: string, afterConfirmed: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ['-r', path.join(SUPPORT, 'ts-register.js'), path.join(SUPPORT, 'chaos-writer.ts'), dir, prefix],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const confirmed: string[] = [];
    let buf = '';
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('OK ')) confirmed.push(line.slice(3));
        if (confirmed.length === afterConfirmed) child.kill('SIGKILL');
      }
    });
    child.on('exit', (code, signal) => {
      if (signal === 'SIGKILL') resolve(confirmed);
      else reject(new Error(`writer exited ${code}: ${err}`));
    });
  });
}

describe('REQ-129: kill -9 chaos', () => {
  it('REQ-129: after kill -9 at random points every confirmed order, KOT and payment exists exactly once', async () => {
    const dir = tempDir();
    await writeWorkbookFile(path.join(dir, WORKBOOK_FILE), seededData(), 'x');
    const all: string[] = [];
    for (let round = 0; round < 4; round++) {
      const confirmed = await runAndKill(dir, `r${round}`, 15 + Math.floor(Math.random() * 60));
      all.push(...confirmed);

      const s = new StorageService({ dataDir: dir, sheetPassword: 'x' });
      await s.open();
      expect(s.state).toBe('ready');
      const columns = { orders: 'client_request_id', kots: 'idempotency_key', payments: 'idempotency_key' } as const;
      for (const entry of all) {
        const [sheet, key] = entry.split(' ') as [keyof typeof columns, string];
        expect(s.store.findUnique(sheet, columns[sheet], key)).toBeDefined();
      }
      // No duplicates, no half-applied payment: each order holds at most one KOT and one payment,
      // and a payment always comes with its order marked PAID.
      for (const o of s.store.all('orders')) {
        expect(s.store.findBy('kots', 'order_id', o.id).length).toBeLessThanOrEqual(1);
        const pays = s.store.findBy('payments', 'order_id', o.id);
        expect(pays.length).toBeLessThanOrEqual(1);
        if (pays.length && o.client_request_id !== 'req-1') expect(o.status).toBe('PAID');
      }
      s.close();
    }
    expect(all.length).toBeGreaterThan(50);
  }, 120000);
});
