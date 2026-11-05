// PIN login, lockout, session expiry and token checks (REQ-024, REQ-025,
// REQ-026, REQ-111, REQ-120). bcrypt runs before the write queue; the
// failed-count / lock change is journalled through the queue.
import crypto from 'crypto';
import { Role, User, UserRow } from '@dhaba/shared';
import { ApiError } from '../common/errors';
import { nowIst } from '../common/time';
import { StorageService } from '../storage/storage.service';
import { ApprovalStore } from './approvals';
import { SessionUser } from './decorators';
import { JwtClaims, signJwt, verifyJwt } from './jwt';
import { verifyPin } from './pin';

export const MAX_PIN_FAILURES = 5;
export const LOCK_MS = 5 * 60_000;
export const SESSION_MS = 12 * 60 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;

export interface AuthOptions {
  /** JWT signing secret (main.ts: loadJwtSecret). Default: a random per-process secret. */
  jwtSecret?: string;
  /** Clock in ms; tests move it. */
  now?: () => number;
}

export interface LoginInput {
  user_id: string;
  pin: string;
  /** Role the device is locked to; 'KITCHEN' + a Kitchen user = kitchen device session. */
  device_role?: Role | null;
}

export interface LoginResult {
  token: string;
  expires_at: string;
  kitchen_device: boolean;
  user: User;
}

/** A user row without pin_hash, as every API response returns it. */
export function publicUser(row: UserRow): User {
  const { pin_hash: _omit, ...rest } = row;
  return rest;
}

/** Patch for an Admin unlock: clears the lock and the failure count (REQ-025). */
export function unlockPatch(): Partial<UserRow> {
  return { failed_pin_count: 0, locked_until: null };
}

/** Patch for deactivation: the user's tokens stop working (REQ-120). */
export function deactivatePatch(row: UserRow): Partial<UserRow> {
  return { is_active: false, token_version: row.token_version + 1 };
}

/** Patch for a forced PIN reset: new hash, old tokens revoked, lock cleared (REQ-119). Hash the PIN before the queue. */
export function pinResetPatch(row: UserRow, pinHash: string): Partial<UserRow> {
  return { pin_hash: pinHash, token_version: row.token_version + 1, failed_pin_count: 0, locked_until: null };
}

/** The active Admin (other than `exceptUserId`) whose PIN is `pin`, if any — no two active Admins may share a PIN (REQ-119). */
export async function findAdminByPin(users: UserRow[], pin: string, exceptUserId?: string): Promise<UserRow | undefined> {
  for (const u of users) {
    if (u.role !== 'ADMIN' || !u.is_active || u.id === exceptUserId) continue;
    if (await verifyPin(pin, u.pin_hash)) return u;
  }
  return undefined;
}

/**
 * When a session that starts at `startMs` ends: 12 h later, or at the next
 * IST shift end (HH:mm) if that is sooner. Kitchen device sessions ignore the shift end.
 */
export function sessionExpiry(startMs: number, shiftEnd: string | null, kitchenDevice: boolean): number {
  const cap = startMs + SESSION_MS;
  const m = shiftEnd ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(shiftEnd) : null;
  if (!m || kitchenDevice) return cap;
  const ist = startMs + IST_OFFSET_MS;
  const dayStart = ist - (ist % 86_400_000);
  let end = dayStart + (Number(m[1]) * 60 + Number(m[2])) * 60_000 - IST_OFFSET_MS;
  if (end <= startMs) end += 86_400_000;
  return Math.min(cap, end);
}

export class UnauthorizedError extends ApiError {
  constructor(reason: string) {
    super(401, 'UNAUTHORIZED', 'Please log in again.', 'कृपया फिर से लॉगिन करें।', { reason });
  }
}

export class AuthService {
  readonly approvals: ApprovalStore;
  private readonly secret: string;
  now: () => number;

  constructor(private readonly storage: StorageService, options: AuthOptions = {}) {
    this.secret = options.jwtSecret ?? crypto.randomBytes(48).toString('hex');
    this.now = options.now ?? Date.now;
    this.approvals = new ApprovalStore(() => this.now());
  }

  /** Active staff for the login tiles: id, name and role only (REQ-024). */
  loginStaff(): Pick<User, 'id' | 'display_name' | 'role'>[] {
    return this.storage.store
      .all('users')
      .filter((u) => u.is_active)
      .map((u) => ({ id: u.id, display_name: u.display_name, role: u.role }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const user = this.storage.store.get('users', input.user_id);
    if (!user || !user.is_active) {
      throw new ApiError(401, 'INVALID_LOGIN', 'Name or PIN is not right.', 'नाम या PIN सही नहीं है।', { remaining_tries: null });
    }
    this.assertNotLocked(user);
    const ok = await verifyPin(input.pin, user.pin_hash);
    const nowMs = this.now();
    const failure = await this.storage.queue.run((tx) => {
      const current = tx.get('users', user.id);
      if (!current || !current.is_active) return { kind: 'gone' as const };
      if (current.pin_hash !== user.pin_hash) return { kind: 'stale' as const };
      const lockedUntil = current.locked_until ? Date.parse(current.locked_until) : 0;
      if (lockedUntil > nowMs) return { kind: 'locked' as const, user: current };
      // A lock that has run out starts a fresh count.
      const before = current.locked_until ? 0 : current.failed_pin_count;
      if (ok) {
        if (current.failed_pin_count !== 0 || current.locked_until !== null) tx.update('users', current, unlockPatch(), current.id);
        return null;
      }
      const count = before + 1;
      const lock = count >= MAX_PIN_FAILURES ? nowIst(new Date(nowMs + LOCK_MS)) : null;
      const next = tx.update('users', current, { failed_pin_count: count, locked_until: lock }, current.id);
      return { kind: 'wrong' as const, user: next, remaining: Math.max(0, MAX_PIN_FAILURES - count) };
    });
    if (failure?.kind === 'gone') return this.login(input);
    if (failure?.kind === 'stale') return this.login(input);
    if (failure?.kind === 'locked') this.assertNotLocked(failure.user);
    if (failure?.kind === 'wrong') {
      if (failure.user.locked_until) this.assertNotLocked(failure.user);
      throw new ApiError(401, 'WRONG_PIN', `Wrong PIN. ${failure.remaining} tries left.`, `गलत PIN। ${failure.remaining} कोशिश बाकी।`, {
        remaining_tries: failure.remaining,
      });
    }
    const fresh = this.storage.store.get('users', user.id)!;
    const kitchenDevice = input.device_role === 'KITCHEN' && fresh.role === 'KITCHEN';
    const shiftEnd = this.storage.store.all('settings')[0]?.shift_end_time ?? null;
    const exp = sessionExpiry(nowMs, shiftEnd, kitchenDevice);
    const claims: JwtClaims = {
      sub: fresh.id, role: fresh.role, tv: fresh.token_version, kd: kitchenDevice,
      iat: Math.floor(nowMs / 1000), exp: Math.floor(exp / 1000),
    };
    return { token: signJwt(claims, this.secret), expires_at: nowIst(new Date(claims.exp * 1000)), kitchen_device: kitchenDevice, user: publicUser(fresh) };
  }

  /**
   * The session of a Bearer token, or 401: bad signature, older than 12 h,
   * past its expiry (shift end), unknown or deactivated user, or a
   * token_version that was bumped (deactivation, PIN reset).
   */
  authenticate(token: string | null, deviceId: string | null = null): SessionUser {
    if (!token) throw new UnauthorizedError('missing bearer token');
    const claims = verifyJwt(token, this.secret);
    if (!claims) throw new UnauthorizedError('invalid token');
    const nowSec = this.now() / 1000;
    if (nowSec >= claims.exp || nowSec - claims.iat >= SESSION_MS / 1000) throw new UnauthorizedError('expired');
    const user = this.storage.store.get('users', claims.sub);
    if (!user || !user.is_active || user.token_version !== claims.tv) throw new UnauthorizedError('revoked');
    return { id: user.id, role: user.role, display_name: user.display_name, kitchen_device: claims.kd === true, device_id: deviceId };
  }

  private assertNotLocked(user: UserRow): void {
    if (user.locked_until && Date.parse(user.locked_until) > this.now()) {
      throw new ApiError(423, 'USER_LOCKED', 'Too many wrong PINs. Try again in 5 minutes or ask the owner to unlock.',
        'बहुत बार गलत PIN। 5 मिनट बाद कोशिश करें या मालिक से अनलॉक करवाएँ।', { locked_until: user.locked_until, remaining_tries: 0 });
    }
  }
}
