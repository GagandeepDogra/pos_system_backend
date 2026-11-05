// Deployment review (`npm run check:deploy`): validates the profile settings a
// person would otherwise check by hand. Any failure exits non-zero, so a cloud
// deployment without a nightly off-server backup copy fails review.
import fs from 'fs';
import path from 'path';
import { DeployConfigError, DeployProfile, ProfileDeps, loadDeployProfile } from './profile';

export interface ReviewResult {
  ok: boolean;
  profile: DeployProfile | null;
  failures: string[];
  notes: string[];
}

export function reviewDeployment(env: NodeJS.ProcessEnv, deps: ProfileDeps & { platform?: NodeJS.Platform } = {}): ReviewResult {
  const failures: string[] = [];
  const notes: string[] = [];
  let profile: DeployProfile | null = null;
  try {
    profile = loadDeployProfile(env, deps);
  } catch (err) {
    if (!(err instanceof DeployConfigError)) throw err;
    failures.push(...err.problems);
  }
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const platform = deps.platform ?? process.platform;
  if (platform !== 'win32' && fs.existsSync(dataDir)) {
    const mode = fs.statSync(dataDir).mode & 0o777;
    if (mode & 0o077) failures.push(`data folder ${dataDir} is readable by other accounts (mode ${mode.toString(8)}); it must be 700`);
  }
  if (platform === 'win32') notes.push('Windows: confirm the installer ran icacls on DATA_DIR (only the service account and Administrators)');
  if (profile?.offsiteBackupDir && !fs.existsSync(profile.offsiteBackupDir)) {
    failures.push(`OFFSITE_BACKUP_DIR ${profile.offsiteBackupDir} does not exist (is the remote folder mounted?)`);
  }
  if (profile?.name === 'lan') {
    notes.push(`LAN profile binds to ${profile.host}; run the router checklist (WPA2, guest network isolated, WAN port scan)`);
    if (!profile.offsiteBackupDir) notes.push('No off-server copy configured; copy backups/ to a USB drive or set OFFSITE_BACKUP_DIR');
  }
  if (profile?.name === 'cloud') {
    notes.push(`cloud profile: HTTPS only, CORS ${profile.corsOrigin}, login limit ${profile.loginRateLimitPerMinute}/min/IP`);
    notes.push(`nightly off-server copy at ${profile.offsiteBackupTime} IST to ${profile.offsiteBackupDir}`);
    if (!profile.httpRedirectPort) notes.push('HTTP_REDIRECT_PORT not set: port 80 must stay closed in the firewall');
  }
  return { ok: failures.length === 0, profile, failures, notes };
}
