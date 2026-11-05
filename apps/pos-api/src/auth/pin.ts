import bcrypt from 'bcryptjs';

export const PIN_BCRYPT_COST = 10;
const PIN_RE = /^\d{4,}$/;

export function isValidPin(pin: string): boolean {
  return PIN_RE.test(pin);
}

/** bcrypt hash of a PIN of 4+ digits; this is what users.pin_hash stores. */
export async function hashPin(pin: string): Promise<string> {
  if (!isValidPin(pin)) throw new Error('PIN must be at least 4 digits');
  return bcrypt.hash(pin, PIN_BCRYPT_COST);
}

export async function verifyPin(pin: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pin, hash);
}
