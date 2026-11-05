// HTTP setup shared by main.ts and the e2e tests: the api/v1 prefix, the
// formula stripper + ValidationPipe, the error body filter, the Socket.IO
// adapter and the static PWA build (served for every non-API path).
import fs from 'fs';
import path from 'path';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { ApiErrorFilter } from './common/error.filter';
import { FormulaStripPipe, createValidationPipe } from './common/validation';

export const API_PREFIX = 'api/v1';

export interface SetupOptions {
  /** Folder of the statically exported PWA (index.html at its root); null = none. */
  webDir?: string | null;
}

export function configureApp(app: INestApplication, options: SetupOptions = {}): void {
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(new FormulaStripPipe(), createValidationPipe());
  app.useGlobalFilters(new ApiErrorFilter());
  app.useWebSocketAdapter(new IoAdapter(app));
  if (options.webDir) servePwa(app, options.webDir);
}

/**
 * Serves the PWA build. /api/* and /socket.io/* are never answered with
 * index.html: an unknown API path gets the 404 error body instead.
 */
function servePwa(app: INestApplication, webDir: string): void {
  const root = path.resolve(webDir);
  const index = path.join(root, 'index.html');
  const isApi = (url: string) => /^\/(api|socket\.io)(\/|$|\?)/.test(url);
  const statics = express.static(root, { index: 'index.html', fallthrough: true });
  app.use((req: Request, res: Response, next: NextFunction) => (isApi(req.url) ? next() : statics(req, res, next)));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isApi(req.url) || (req.method !== 'GET' && req.method !== 'HEAD') || !fs.existsSync(index)) return next();
    res.sendFile(index);
  });
}
