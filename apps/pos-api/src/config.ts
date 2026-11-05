import path from 'path';
import { DeployProfile, loadDeployProfile } from './deploy/profile';
import { OpenHours, parseOpenHours } from './storage/snapshot-scheduler';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  sheetPassword: string;
  /** IST open hours for automatic snapshots, "HH:mm-HH:mm"; null = all day. */
  snapshotOpenHours: OpenHours | null;
  /** Statically exported PWA build served for non-API paths; null = none. */
  webDir: string | null;
  /** lan (default) or cloud: bind address, TLS, CORS, login rate limit, off-server copy. */
  deploy: DeployProfile;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const deploy = loadDeployProfile(env);
  return {
    port: env.PORT?.trim() ? Number(env.PORT) : deploy.name === 'cloud' ? 443 : 3000,
    host: deploy.host,
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    sheetPassword: env.WORKBOOK_SHEET_PASSWORD ?? 'dhaba-pos',
    snapshotOpenHours: parseOpenHours(env.SNAPSHOT_OPEN_HOURS),
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : null,
    deploy,
  };
}
