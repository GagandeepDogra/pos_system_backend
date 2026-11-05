// The first Admin of a fresh workbook. Staff are otherwise added by an Admin
// (POST /admin/users), so without this nobody could ever log in.
import { User } from '@dhaba/shared';
import { writeAudit } from '../audit/audit';
import { counterKeys, idFormats } from '../storage/repository';
import { StorageService } from '../storage/storage.service';
import { publicUser } from './auth.service';
import { hashPin, isValidPin } from './pin';

/** Counter key of users.id (USR-NNNNNN); the staff API uses the same one. */
export const USER_COUNTER = 'USER';

export async function createFirstAdmin(storage: StorageService, displayName: string, pin: string): Promise<User> {
  const name = displayName.trim();
  if (!name || name.length > 40) throw new Error('ADMIN_NAME must be 1–40 characters');
  if (!isValidPin(pin)) throw new Error('ADMIN_PIN must be at least 4 digits');
  const pinHash = await hashPin(pin);
  return storage.queue.run((tx) => {
    if (tx.all('users').some((u) => u.role === 'ADMIN' && u.is_active)) throw new Error('an active Admin already exists; add staff from the Admin screens');
    const row = tx.create('users', {
      id: idFormats.seq('USR', tx.nextCounter(counterKeys.seq(USER_COUNTER))), display_name: name, role: 'ADMIN', pin_hash: pinHash,
      language: 'en', is_active: true, failed_pin_count: 0, locked_until: null, token_version: 1,
    }, 'SYSTEM');
    writeAudit(tx, { action: 'CREATE', entity_type: 'users', entity_id: row.id, user_id: 'SYSTEM', after_json: { display_name: name, role: 'ADMIN' } });
    return publicUser(row);
  });
}
