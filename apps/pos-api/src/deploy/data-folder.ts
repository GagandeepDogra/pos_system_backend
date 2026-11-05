// Data folder access (REQ-123): the workbook, journal and backups hold PIN
// hashes, so only the service account may read the folder. On Linux the server
// enforces mode 0700 on every start; on Windows the installer sets the ACL
// (icacls) because Node cannot express NTFS ACLs.
import fs from 'fs';

export interface FolderAccess {
  dir: string;
  /** Octal mode string after the check, e.g. "700"; null on Windows. */
  mode: string | null;
  /** True if the mode was tightened by this call. */
  tightened: boolean;
}

export function restrictDataFolder(dir: string, platform: NodeJS.Platform = process.platform): FolderAccess {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === 'win32') return { dir, mode: null, tightened: false };
  const before = fs.statSync(dir).mode & 0o777;
  const tightened = (before & 0o077) !== 0;
  if (tightened) fs.chmodSync(dir, before & 0o700);
  return { dir, mode: (fs.statSync(dir).mode & 0o777).toString(8), tightened };
}
