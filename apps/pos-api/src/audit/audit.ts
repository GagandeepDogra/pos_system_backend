// Audit Log rows (REQ-081, REQ-018): written inside a write-queue change so
// the audit row commits in the same journal entry as the change it records.
import { AuditLog } from '@dhaba/shared';
import { counterKeys, idFormats } from '../storage/repository';
import { Tx } from '../storage/write-queue';

export interface AuditInput {
  action: string;
  entity_type: string;
  entity_id: string;
  user_id: string;
  approver_id?: string | null;
  device_id?: string | null;
  before_json?: unknown | null;
  after_json?: unknown | null;
}

/** Inserts one AUD-NNNNNN row (global AUDIT counter) stamped with the change's time. */
export function writeAudit(tx: Tx, input: AuditInput): AuditLog {
  const row: AuditLog = {
    id: idFormats.seq('AUD', tx.nextCounter(counterKeys.seq('AUDIT'))),
    action: input.action.slice(0, 30),
    entity_type: input.entity_type.slice(0, 20),
    entity_id: input.entity_id.slice(0, 20),
    user_id: input.user_id.slice(0, 20),
    approver_id: input.approver_id ?? null,
    device_id: input.device_id ? input.device_id.slice(0, 40) : null,
    before_json: input.before_json ?? null,
    after_json: input.after_json ?? null,
    created_at: tx.now,
  };
  return tx.insert('audit_log', row);
}
