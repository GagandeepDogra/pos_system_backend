// GET /admin/backups/download (downloadBackup), POST /admin/restores (previewRestore) and
// POST /admin/restores/:id/confirm (confirmRestore). Admin only (REQ-123): backups hold PIN hashes.
import { promises as fsp } from 'fs';
import { Body, Controller, Get, Param, Post, Query, Req, Res, StreamableFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { writeAudit } from '../audit/audit';
import { CurrentUser, Roles, SessionUser } from '../auth/decorators';
import { PERMISSIONS } from '../auth/permissions';
import { verifyPin } from '../auth/pin';
import { ApiError } from '../common/errors';
import { IdempotencyKey } from '../common/headers';
import { StorageService } from '../storage/storage.service';
import { RestorePreview, RestoreResult, RestoreService, downloadTarget } from './restore';

/** Largest accepted upload (the live workbook stays well under this before the monthly archive). */
export const MAX_RESTORE_BYTES = 100 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class ConfirmRestoreDto {
  @IsString() @MaxLength(12) pin!: string;
  @IsString() @MaxLength(12) pin_confirm!: string;
}

function tooLarge(): ApiError {
  return new ApiError(413, 'FILE_TOO_LARGE', 'The file is too large', 'फ़ाइल बहुत बड़ी है', { max_bytes: MAX_RESTORE_BYTES });
}

/** A raw (non-multipart) upload body, e.g. Content-Type application/octet-stream or the xlsx type. */
async function readRawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_RESTORE_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

@Controller('admin')
export class BackupsController {
  private readonly restores: RestoreService;
  private readonly previews = new Map<string, { expiresMs: number; result: Promise<RestorePreview> }>();

  constructor(private readonly storage: StorageService) {
    this.restores = new RestoreService(storage);
  }

  @Get('backups/download')
  @Roles(...PERMISSIONS.downloadBackup)
  async download(
    @Query('snapshot') snapshot: string | undefined,
    @CurrentUser() user: SessionUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const target = downloadTarget(this.storage, snapshot || undefined);
    // The audit row is journalled before the file is read (REQ-123).
    await this.storage.queue.run((tx) =>
      writeAudit(tx, {
        action: 'BACKUP_DOWNLOAD',
        entity_type: 'backups',
        entity_id: target.live ? 'LIVE' : target.name.replace(/^snapshot-/, '').slice(0, 20),
        user_id: user.id,
        after_json: { file: target.name, live: target.live },
      }),
    );
    // The live file lags memory by up to 2 s; flush so the download is current.
    if (target.live && this.storage.lastSavedSeq < this.storage.journal.lastSeq) await this.storage.save();
    const buffer = await fsp.readFile(target.file);
    const name = target.live ? `dhaba-pos-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}.xlsx` : target.name;
    res.set({ 'Content-Type': XLSX_TYPE, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    return new StreamableFile(buffer);
  }

  @Post('restores')
  @Roles(...PERMISSIONS.previewRestore)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RESTORE_BYTES, files: 1 } }))
  async preview(
    @IdempotencyKey() key: string,
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RestorePreview> {
    const now = Date.now();
    for (const [k, v] of this.previews) if (v.expiresMs <= now) this.previews.delete(k);
    const scoped = `${user.id}:${key}`;
    const hit = this.previews.get(scoped);
    if (hit) {
      const body = await hit.result;
      res.status(200);
      return body;
    }
    const upload = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
    let buffer: Buffer;
    let fileName: string | null = null;
    if (upload) {
      buffer = upload.buffer;
      fileName = upload.originalname || null;
    } else if (!req.is('multipart/form-data') && !req.is('application/json') && !req.is('application/x-www-form-urlencoded')) {
      buffer = await readRawBody(req);
      const header = req.header('X-File-Name');
      fileName = header ? header.slice(0, 200) : null;
    } else {
      buffer = Buffer.alloc(0);
    }
    if (!buffer.length) {
      throw new ApiError(400, 'FILE_REQUIRED', 'Choose a backup .xlsx file to upload', 'अपलोड करने के लिए बैकअप .xlsx फ़ाइल चुनें', { field: 'file' });
    }
    const result = this.restores.preview(buffer, fileName, user.id);
    this.previews.set(scoped, { expiresMs: now + IDEMPOTENCY_TTL_MS, result });
    try {
      const body = await result;
      res.status(201);
      return body;
    } catch (err) {
      this.previews.delete(scoped);
      throw err;
    }
  }

  @Post('restores/:id/confirm')
  @Roles(...PERMISSIONS.confirmRestore)
  async confirm(@Param('id') id: string, @Body() body: ConfirmRestoreDto, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response): Promise<RestoreResult> {
    this.restores.get(id);
    if (body.pin !== body.pin_confirm) {
      throw new ApiError(403, 'PIN_MISMATCH', 'The two PIN entries do not match', 'दोनों PIN एक जैसे नहीं हैं', null);
    }
    const me = this.storage.store.get('users', user.id);
    const ok = !!me && me.is_active && me.role === 'ADMIN' && (await verifyPin(body.pin, me.pin_hash));
    if (!ok) {
      throw new ApiError(403, 'PIN_NOT_ADMIN', 'That is not your Admin PIN', 'यह आपका एडमिन PIN नहीं है', null);
    }
    const result = await this.restores.confirm(id, user.id);
    res.status(200);
    return result;
  }
}
