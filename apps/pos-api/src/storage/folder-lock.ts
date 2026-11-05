// Exclusive ownership of the data folder: one pos-api per folder.
import fs from 'fs';
import path from 'path';

export const LOCK_FILE = '.pos-api.lock';

export class FolderLockedError extends Error {
  constructor(public readonly holderPid: number, dir: string) {
    super(`Data folder ${dir} is already locked by another pos-api (pid ${holderPid})`);
    this.name = 'FolderLockedError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Creates the lock file with O_EXCL. If it already exists and its pid is alive,
 * the folder is held and FolderLockedError is thrown; a lock left by a dead
 * process is taken over.
 */
export class FolderLock {
  private held = false;
  readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, LOCK_FILE);
  }

  acquire(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        this.held = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const pid = Number(fs.readFileSync(this.file, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) throw new FolderLockedError(pid, this.dir);
        fs.rmSync(this.file, { force: true }); // stale lock from a crashed process
      }
    }
    throw new FolderLockedError(-1, this.dir);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    fs.rmSync(this.file, { force: true });
  }
}
