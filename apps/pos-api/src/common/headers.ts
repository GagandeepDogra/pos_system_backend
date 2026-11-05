// Request headers every write uses: If-Match (REQ-113) and Idempotency-Key (REQ-112).
import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from './errors';

/** Parses an If-Match header into a row_version: missing → 428, not a positive integer → 400. */
export function parseIfMatch(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value.trim() === '') {
    throw new ApiError(428, 'IF_MATCH_REQUIRED', 'This change needs the record version (If-Match).', 'इस बदलाव के लिए रिकॉर्ड वर्ज़न (If-Match) चाहिए।');
  }
  const text = value.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    throw new ApiError(400, 'IF_MATCH_INVALID', 'If-Match must be the row_version number.', 'If-Match में row_version संख्या होनी चाहिए।', { if_match: value });
  }
  return Number(text);
}

/** Parses an Idempotency-Key header: required, 1–64 characters (it is stored in a 64-char column). */
export function parseIdempotencyKey(raw: string | string[] | undefined): string {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.', 'Idempotency-Key हेडर ज़रूरी है।');
  }
  if (value.length > 64) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key is longer than 64 characters.', 'Idempotency-Key 64 अक्षरों से लंबी है।');
  }
  return value;
}

/** `@IfMatch() version: number` — the required If-Match row_version. */
export const IfMatch = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  parseIfMatch(ctx.switchToHttp().getRequest<Request>().headers['if-match']),
);

/** `@IdempotencyKey() key: string` — the required Idempotency-Key. */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  parseIdempotencyKey(ctx.switchToHttp().getRequest<Request>().headers['idempotency-key']),
);
