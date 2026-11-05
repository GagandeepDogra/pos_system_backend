import { StorageService } from '../storage/storage.service';
import { tempDir } from '../../test/fixtures';
import { APPROVAL_TTL_MS, ApprovalStore } from './approvals';
import { createFirstAdmin } from './first-admin';
import { signJwt, verifyJwt } from './jwt';
import { verifyPin } from './pin';

describe('auth building blocks', () => {
  it('REQ-111: a JWT verifies only with its secret and unchanged claims', () => {
    const claims = { sub: 'USR-1', role: 'CASHIER' as const, tv: 1, kd: false, iat: 1, exp: 2 };
    const t = signJwt(claims, 's'.repeat(32));
    expect(verifyJwt(t, 's'.repeat(32))).toEqual(claims);
    expect(verifyJwt(t, 'x'.repeat(32))).toBeNull();
    const [h, , sig] = t.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, role: 'ADMIN' })).toString('base64url')}.${sig}`;
    expect(verifyJwt(tampered, 's'.repeat(32))).toBeNull();
    expect(verifyJwt('garbage', 's'.repeat(32))).toBeNull();
  });

  it('REQ-023: an approval is single use, bound to its requester and expires after 2 minutes', () => {
    let now = 0;
    const store = new ApprovalStore(() => now);
    const a = store.issue('ADM-1', 'USR-C');
    expect(() => store.consume(a.approval_token, 'USR-X')).toThrow(/approval/i);
    expect(store.consume(a.approval_token, 'USR-C')).toBe('ADM-1');
    expect(() => store.consume(a.approval_token, 'USR-C')).toThrow();
    expect(() => store.consume(null, 'USR-C')).toThrow();
    const b = store.issue('ADM-1', 'USR-C');
    now += APPROVAL_TTL_MS - 1;
    const c = store.issue('ADM-1', 'USR-C');
    expect(store.consume(b.approval_token, 'USR-C')).toBe('ADM-1');
    now += APPROVAL_TTL_MS;
    expect(() => store.consume(c.approval_token, 'USR-C')).toThrow();
  });

  it('REQ-119: the first Admin is created with a bcrypt PIN, only once', async () => {
    const storage = new StorageService({ dataDir: tempDir(), sheetPassword: 'x' });
    await storage.open();
    try {
      await expect(createFirstAdmin(storage, 'Owner', '123')).rejects.toThrow(/4 digits/);
      const admin = await createFirstAdmin(storage, 'Owner', '1234');
      expect(admin).toMatchObject({ id: 'USR-000001', role: 'ADMIN', is_active: true, token_version: 1 });
      expect((admin as unknown as { pin_hash?: string }).pin_hash).toBeUndefined();
      expect(await verifyPin('1234', storage.store.get('users', admin.id)!.pin_hash)).toBe(true);
      await expect(createFirstAdmin(storage, 'Second', '5555')).rejects.toThrow(/already exists/);
    } finally {
      storage.close();
    }
  });
});
