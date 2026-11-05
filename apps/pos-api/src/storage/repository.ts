// Repository rules shared by every write (REQ-098, REQ-101, REQ-097):
// audit stamps with +05:30 timestamps, row_version +1 on each update,
// business_date that rolls over at Settings.token_reset_time, and the
// formats of the ids allocated from Counters inside the write queue.

/** The audit columns every transactional and master row carries. */
export interface AuditColumns {
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  row_version: number;
}

export const DEFAULT_RESET_TIME = '04:00';

/** Audit columns of a new row: created = updated = now, row_version 1. */
export function createStamp(now: string, userId: string): AuditColumns {
  return { created_at: now, created_by: userId, updated_at: now, updated_by: userId, row_version: 1 };
}

/** The row with `patch` applied, updated_at/by stamped and row_version + 1. Audit columns in `patch` are ignored. */
export function updateStamp<R extends { row_version: number }>(row: R, patch: Partial<R>, now: string, userId: string): R {
  const clean = { ...patch } as Record<string, unknown>;
  for (const k of ['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'row_version']) delete clean[k];
  return { ...row, ...clean, updated_at: now, updated_by: userId, row_version: row.row_version + 1 } as R;
}

/**
 * The trading day an instant belongs to, in IST. Before the reset time
 * (default 04:00) it is still the previous day: 01:00 on Nov 6 → 2026-11-05.
 */
export function businessDate(at: Date | string, resetTime: string = DEFAULT_RESET_TIME): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(resetTime);
  if (!m) throw new Error(`invalid reset time "${resetTime}" (HH:mm)`);
  const resetMs = (Number(m[1]) * 60 + Number(m[2])) * 60_000;
  const istMs = new Date(at).getTime() + 330 * 60_000;
  return new Date(istMs - resetMs).toISOString().slice(0, 10);
}

const ymd = (date: string) => date.replace(/-/g, '');
const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Counter keys (Counters.counter_key). ORDER is global; the others restart per business_date. */
export const counterKeys = {
  order: () => 'ORDER',
  token: (date: string) => `TOKEN:${date}`,
  kot: (date: string) => `KOT:${date}`,
  bill: (date: string) => `BILL:${date}`,
  /** Global sequence for other sheets, e.g. seq('PAYMENT'). */
  seq: (name: string) => name,
};

export const idFormats = {
  /** ORD-YYYYMMDD-NNNN */
  order: (date: string, n: number) => `ORD-${ymd(date)}-${pad(n, 4)}`,
  /** T-NNN */
  token: (n: number) => `T-${pad(n, 3)}`,
  /** B-YYYYMMDD-NNN */
  bill: (date: string, n: number) => `B-${ymd(date)}-${pad(n, 3)}`,
  /** KOT-YYYYMMDD-NNNN */
  kot: (date: string, n: number) => `KOT-${ymd(date)}-${pad(n, 4)}`,
  /** <PREFIX>-NNNNNN for rows with a global sequence (OI, PAY, EXC, PRC, AUD, USR, TBL, CAT, ITM, VAR). */
  seq: (prefix: string, n: number) => `${prefix}-${pad(n, 6)}`,
};
