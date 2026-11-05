import path from 'path';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  sheetPassword: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR ?? './data'),
    sheetPassword: env.WORKBOOK_SHEET_PASSWORD ?? 'dhaba-pos',
  };
}
