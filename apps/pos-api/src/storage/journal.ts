// Append-only write journal: one JSON line per committed change, fsync'd
// before the change is applied for good and the client gets its reply.
// On startup, entries newer than Meta.last_journal_seq are replayed.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SheetName } from '@dhaba/shared';
import { Row } from './workbook-codec';

export const JOURNAL_FILE = 'dhaba-pos.journal';

export interface JournalOp {
  /** i = insert, u = replace (update) */
  t: 'i' | 'u';
  s: SheetName;
  r: Row;
}

export interface JournalEntry {
  seq: number;
  at: string;
  ops: JournalOp[];
}

export class JournalCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptError';
  }
}

export class JournalWriteError extends Error {
  constructor(cause: unknown) {
    super(`journal write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'JournalWriteError';
  }
}

function hash(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** Serialises an entry as `<hash> <json>\n`, so a torn or bit-rotted line is detected. */
export function encodeEntry(entry: JournalEntry): string {
  const body = JSON.stringify(entry);
  return `${hash(body)} ${body}\n`;
}

function decodeLine(line: string): JournalEntry | null {
  const space = line.indexOf(' ');
  if (space !== 16) return null;
  const body = line.slice(space + 1);
  if (hash(body) !== line.slice(0, space)) return null;
  try {
    const e = JSON.parse(body) as JournalEntry;
    return Number.isInteger(e.seq) && Array.isArray(e.ops) ? e : null;
  } catch {
    return null;
  }
}

/**
 * Reads every entry. A damaged *last* line is a write torn by a crash or power
 * cut (its change was never confirmed) and is reported in `tornBytes`; a damaged
 * line anywhere else means the file itself is corrupt.
 */
export function readJournal(file: string): { entries: JournalEntry[]; validBytes: number; tornBytes: number } {
  if (!fs.existsSync(file)) return { entries: [], validBytes: 0, tornBytes: 0 };
  const buf = fs.readFileSync(file);
  const entries: JournalEntry[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    const entry = nl === -1 ? null : decodeLine(buf.subarray(pos, end).toString('utf8'));
    if (!entry) {
      if (nl === -1 || nl === buf.length - 1) return { entries, validBytes: pos, tornBytes: buf.length - pos };
      throw new JournalCorruptError(`${path.basename(file)}: damaged entry at byte ${pos} (after seq ${entries.at(-1)?.seq ?? 0})`);
    }
    if (entries.length && entry.seq <= entries[entries.length - 1].seq) {
      throw new JournalCorruptError(`${path.basename(file)}: sequence goes backwards at seq ${entry.seq}`);
    }
    entries.push(entry);
    pos = end + 1;
  }
  return { entries, validBytes: pos, tornBytes: 0 };
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Not supported on every platform (e.g. Windows); the file fsync still holds.
  }
}

export class Journal {
  private fd: number | null = null;
  private size = 0;
  private seq = 0;

  constructor(readonly file: string) {}

  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Reads the journal, cuts off a torn last line and opens it for appending.
   * `baseSeq` is Meta.last_journal_seq, so numbering continues past it even when
   * the journal was compacted. Returns every intact entry.
   */
  open(baseSeq: number): JournalEntry[] {
    const { entries, validBytes, tornBytes } = readJournal(this.file);
    const existed = fs.existsSync(this.file);
    this.fd = fs.openSync(this.file, existed ? 'r+' : 'w+');
    if (tornBytes) {
      fs.ftruncateSync(this.fd, validBytes);
      fs.fsyncSync(this.fd);
    }
    if (!existed) fsyncDir(path.dirname(this.file));
    this.size = validBytes;
    this.seq = Math.max(baseSeq, entries.at(-1)?.seq ?? 0);
    return entries;
  }

  /** Appends one entry and fsyncs it. Synchronous on purpose: nothing else runs in between. */
  append(ops: JournalOp[], at: string): JournalEntry {
    if (this.fd === null) throw new JournalWriteError(new Error('journal is not open'));
    const entry: JournalEntry = { seq: this.seq + 1, at, ops };
    const buf = Buffer.from(encodeEntry(entry), 'utf8');
    try {
      let off = 0;
      while (off < buf.length) off += fs.writeSync(this.fd, buf, off, buf.length - off, this.size + off);
      fs.fsyncSync(this.fd);
    } catch (err) {
      try {
        fs.ftruncateSync(this.fd, this.size);
      } catch {
        // The torn tail is cut off at the next start anyway.
      }
      throw new JournalWriteError(err);
    }
    this.size += buf.length;
    this.seq = entry.seq;
    return entry;
  }

  /**
   * Drops entries with seq <= upToSeq (temp file + rename). Call it only with the
   * sequence of a file that is safely on disk (e.g. a verified backup snapshot),
   * because recovery from a backup replays the journal past that backup.
   */
  compact(upToSeq: number): void {
    const { entries } = readJournal(this.file);
    const keep = entries.filter((e) => e.seq > upToSeq);
    const tmp = `${this.file}.${process.pid}.tmp`;
    const text = keep.map(encodeEntry).join('');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (this.fd !== null) fs.closeSync(this.fd);
    fs.renameSync(tmp, this.file);
    fsyncDir(path.dirname(this.file));
    this.fd = fs.openSync(this.file, 'r+');
    this.size = Buffer.byteLength(text);
  }

  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}
