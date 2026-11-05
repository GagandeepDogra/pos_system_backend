// The JWT signing secret lives outside the workbook and outside the data
// folder (REQ-120), so neither the live file nor any backup can carry it.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export class JwtSecretError extends Error {}

export const MIN_SECRET_LENGTH = 32;

/** Default secret file: next to (not inside) the data folder. */
export function defaultSecretFile(dataDir: string): string {
  return path.join(path.dirname(path.resolve(dataDir)), 'pos-api-jwt.secret');
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * JWT_SECRET (32+ characters), else the file JWT_SECRET_FILE (default
 * `<parent of DATA_DIR>/pos-api-jwt.secret`), created with a random secret and
 * mode 600 if missing. A secret file inside the data folder is refused.
 */
export function loadJwtSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = env.JWT_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET_LENGTH) throw new JwtSecretError(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    return fromEnv;
  }
  const file = path.resolve(env.JWT_SECRET_FILE?.trim() || defaultSecretFile(dataDir));
  if (isInside(file, dataDir)) throw new JwtSecretError(`JWT_SECRET_FILE ${file} must be outside the data folder ${dataDir}`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  const secret = fs.readFileSync(file, 'utf8').trim();
  if (secret.length < MIN_SECRET_LENGTH) throw new JwtSecretError(`JWT secret in ${file} must be at least ${MIN_SECRET_LENGTH} characters`);
  return secret;
}
