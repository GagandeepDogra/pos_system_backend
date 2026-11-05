// Minimal HS256 JSON Web Tokens (REQ-111, REQ-120) on node:crypto, so no
// extra dependency is needed. The secret never touches the workbook.
import crypto from 'crypto';
import { Role } from '@dhaba/shared';

export interface JwtClaims {
  /** users.id */
  sub: string;
  role: Role;
  /** users.token_version when issued; an older value is revoked (REQ-120). */
  tv: number;
  /** true = kitchen device session, exempt from the shift-end expiry (REQ-026). */
  kd: boolean;
  /** issued at / expires at, seconds since epoch */
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function sign(input: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const body = `${HEADER}.${b64url(JSON.stringify(claims))}`;
  return `${body}.${sign(body, secret)}`;
}

/** The claims of a token with a valid signature, or null. Expiry is checked by the caller. */
export function verifyJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtClaims;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null;
    return claims;
  } catch {
    return null;
  }
}
