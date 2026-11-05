// Admin PIN approvals (REQ-023, DEC-005): random single-use tokens kept only
// in memory for 2 minutes. A restart forgets them, so the cashier asks again.
import crypto from 'crypto';
import { ApiError } from '../common/errors';

export const APPROVAL_TTL_MS = 2 * 60_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

export interface Approval {
  approval_token: string;
  admin_id: string;
  /** The user whose session asked for it; only that user can use it. */
  requested_by: string;
  expires_at: string;
}

export class ApprovalInvalidError extends ApiError {
  constructor(reason: string) {
    super(403, 'APPROVAL_INVALID', 'Admin approval is missing, used or expired. Ask the owner for the PIN again.',
      'एडमिन की मंज़ूरी नहीं है, इस्तेमाल हो चुकी है या पुरानी है। मालिक से फिर PIN डलवाएँ।', { reason });
  }
}

export class ApprovalStore {
  private readonly tokens = new Map<string, { approval: Approval; expiresMs: number }>();
  private readonly byKey = new Map<string, { approval: Approval; expiresMs: number }>();

  constructor(public now: () => number = Date.now) {}

  /** Issues a token for `adminId` on behalf of `requestedBy`. */
  issue(adminId: string, requestedBy: string): Approval {
    this.sweep();
    const expiresMs = this.now() + APPROVAL_TTL_MS;
    const approval: Approval = {
      approval_token: crypto.randomBytes(24).toString('base64url'),
      admin_id: adminId,
      requested_by: requestedBy,
      expires_at: new Date(expiresMs).toISOString(),
    };
    this.tokens.set(approval.approval_token, { approval, expiresMs });
    return approval;
  }

  /** The approval created for this Idempotency-Key in the last 24 h, if any. */
  replay(key: string): Approval | undefined {
    const hit = this.byKey.get(key);
    return hit && hit.expiresMs > this.now() ? hit.approval : undefined;
  }

  remember(key: string, approval: Approval): void {
    this.byKey.set(key, { approval, expiresMs: this.now() + IDEMPOTENCY_TTL_MS });
  }

  /**
   * Uses up a token and returns the approving Admin's id. Call it inside the
   * write-queue change that performs the approved action, and record the id as
   * approved_by / approver_id. Missing, unknown, used, expired or another
   * user's token → 403 APPROVAL_INVALID.
   */
  consume(token: string | null | undefined, userId: string): string {
    if (!token) throw new ApprovalInvalidError('missing');
    const hit = this.tokens.get(token);
    if (!hit) throw new ApprovalInvalidError('unknown or already used');
    if (hit.expiresMs <= this.now()) {
      this.tokens.delete(token);
      throw new ApprovalInvalidError('expired');
    }
    if (hit.approval.requested_by !== userId) throw new ApprovalInvalidError('issued to another user');
    this.tokens.delete(token);
    return hit.approval.admin_id;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.tokens) if (v.expiresMs <= t) this.tokens.delete(k);
    for (const [k, v] of this.byKey) if (v.expiresMs <= t) this.byKey.delete(k);
  }
}
