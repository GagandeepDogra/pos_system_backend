import path from 'path';
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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    sheetPassword: env.WORKBOOK_SHEET_PASSWORD ?? 'dhaba-pos',
    snapshotOpenHours: parseOpenHours(env.SNAPSHOT_OPEN_HOURS),
    webDir: env.WEB_DIR ? path.resolve(env.WEB_DIR) : null,
  };
}
