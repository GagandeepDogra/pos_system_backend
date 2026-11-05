// Deployment profiles (REQ-014, REQ-015, REQ-111, REQ-121, REQ-122).
//
//  lan   (default) — the counter PC. Binds only to a private LAN address (or
//        loopback), never 0.0.0.0 or a public IP. HTTP is allowed; HTTPS with a
//        locally trusted (mkcert) certificate is optional. No CORS (the PWA is
//        served by the backend, same origin). Works with no internet.
//  cloud — a VPS for owner access from home. HTTPS only (Let's Encrypt
//        certificate files), plain HTTP only redirects, login is rate-limited to
//        10/min/IP, CORS is restricted to the app origin, and a nightly
//        off-server backup copy target is mandatory.
import fs from 'fs';
import os from 'os';

export type DeployProfileName = 'lan' | 'cloud';

export interface TlsFiles {
  certFile: string;
  keyFile: string;
}

export interface DeployProfile {
  name: DeployProfileName;
  /** Interface address the API listens on. */
  host: string;
  /** null = plain HTTP (LAN only). */
  tls: TlsFiles | null;
  /** Port of the plain-HTTP listener that only redirects to HTTPS; null = none. */
  httpRedirectPort: number | null;
  /** Allowed browser origin; null = no CORS headers (same-origin only). */
  corsOrigin: string | null;
  /** Login attempts allowed per IP per minute; null = no limit. */
  loginRateLimitPerMinute: number | null;
  /** Folder on another machine/disk (mounted) that receives the nightly copy; null = none. */
  offsiteBackupDir: string | null;
  /** IST HH:mm of the nightly off-server copy. */
  offsiteBackupTime: string;
}

export class DeployConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid deployment configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'DeployConfigError';
  }
}

export const LOGIN_RATE_LIMIT_PER_MINUTE = 10;
const DEFAULT_OFFSITE_TIME = '02:30';

/** RFC 1918 / link-local / loopback / IPv6 ULA — addresses not routable from the internet. */
export function isLocalNetworkAddress(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([1, 2, 3, 4].some((i) => Number(v4[i]) > 255)) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

/** The first private IPv4 address of this machine (the LAN interface), else loopback. */
export function pickLanAddress(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && isLocalNetworkAddress(info.address)) return info.address;
    }
  }
  return '127.0.0.1';
}

function tlsFrom(env: NodeJS.ProcessEnv, problems: string[], exists: (p: string) => boolean): TlsFiles | null {
  const certFile = env.TLS_CERT_FILE?.trim();
  const keyFile = env.TLS_KEY_FILE?.trim();
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) {
    problems.push('TLS_CERT_FILE and TLS_KEY_FILE must be set together');
    return null;
  }
  for (const f of [certFile, keyFile]) if (!exists(f)) problems.push(`TLS file not found: ${f}`);
  return { certFile, keyFile };
}

function optionalPort(value: string | undefined, name: string, problems: string[]): number | null {
  if (!value?.trim()) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push(`${name} must be a port number, got "${value}"`);
    return null;
  }
  return n;
}

export interface ProfileDeps {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  fileExists?: (p: string) => boolean;
}

/** Reads and validates DEPLOY_PROFILE and its settings; throws DeployConfigError listing every problem. */
export function loadDeployProfile(env: NodeJS.ProcessEnv = process.env, deps: ProfileDeps = {}): DeployProfile {
  const exists = deps.fileExists ?? ((p: string) => fs.existsSync(p));
  const problems: string[] = [];
  const raw = (env.DEPLOY_PROFILE ?? 'lan').trim().toLowerCase() || 'lan';
  if (raw !== 'lan' && raw !== 'cloud') throw new DeployConfigError([`DEPLOY_PROFILE must be lan or cloud, got "${raw}"`]);
  const offsiteBackupTime = env.OFFSITE_BACKUP_TIME?.trim() || DEFAULT_OFFSITE_TIME;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(offsiteBackupTime)) problems.push(`OFFSITE_BACKUP_TIME must be HH:mm, got "${offsiteBackupTime}"`);
  const offsiteBackupDir = env.OFFSITE_BACKUP_DIR?.trim() || null;
  const tls = tlsFrom(env, problems, exists);
  const httpRedirectPort = optionalPort(env.HTTP_REDIRECT_PORT, 'HTTP_REDIRECT_PORT', problems);

  if (raw === 'lan') {
    const host = env.HOST?.trim() || pickLanAddress(deps.interfaces);
    if (!isLocalNetworkAddress(host)) {
      problems.push(
        `LAN profile binds only to the local network: HOST must be a private LAN or loopback address, got "${host}"` +
          ' (leave HOST empty to use this PC\'s LAN address)',
      );
    }
    if (env.CORS_ORIGIN?.trim()) problems.push('CORS_ORIGIN is a cloud profile setting; the LAN profile serves the app same-origin');
    if (problems.length) throw new DeployConfigError(problems);
    return {
      name: 'lan',
      host,
      tls,
      httpRedirectPort: tls ? httpRedirectPort : null,
      corsOrigin: null,
      loginRateLimitPerMinute: null,
      offsiteBackupDir,
      offsiteBackupTime,
    };
  }

  // cloud
  if (!tls) problems.push('cloud profile serves HTTPS only: set TLS_CERT_FILE and TLS_KEY_FILE (Let\'s Encrypt fullchain.pem / privkey.pem)');
  const corsOrigin = env.CORS_ORIGIN?.trim() || null;
  if (!corsOrigin) problems.push('cloud profile restricts CORS to the app origin: set CORS_ORIGIN, e.g. https://pos.example.in');
  else if (!/^https:\/\/[^/\s*]+$/.test(corsOrigin)) problems.push(`CORS_ORIGIN must be one https origin without a path or wildcard, got "${corsOrigin}"`);
  if (!offsiteBackupDir) problems.push('cloud profile needs a nightly off-server backup copy: set OFFSITE_BACKUP_DIR to a mounted folder on another machine');
  if (problems.length) throw new DeployConfigError(problems);
  return {
    name: 'cloud',
    host: env.HOST?.trim() || '0.0.0.0',
    tls,
    httpRedirectPort,
    corsOrigin,
    loginRateLimitPerMinute: LOGIN_RATE_LIMIT_PER_MINUTE,
    offsiteBackupDir,
    offsiteBackupTime,
  };
}

export function readTlsOptions(tls: TlsFiles): { cert: Buffer; key: Buffer } {
  return { cert: fs.readFileSync(tls.certFile), key: fs.readFileSync(tls.keyFile) };
}
