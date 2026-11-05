// Every error leaves the API as {code, message_en, message_hi, details} (REQ-114).
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

export interface ErrorBody {
  code: string;
  message_en: string;
  message_hi: string;
  details: unknown;
}

const BY_STATUS: Record<number, [string, string, string]> = {
  400: ['BAD_REQUEST', 'The request is not valid.', 'अनुरोध सही नहीं है।'],
  401: ['UNAUTHORIZED', 'Please log in again.', 'कृपया फिर से लॉग इन करें।'],
  403: ['FORBIDDEN', 'You are not allowed to do this.', 'आपको यह करने की अनुमति नहीं है।'],
  404: ['NOT_FOUND', 'Not found.', 'नहीं मिला।'],
  409: ['CONFLICT', 'This was changed by someone else.', 'यह किसी और ने बदल दिया।'],
  413: ['PAYLOAD_TOO_LARGE', 'The request is too large.', 'अनुरोध बहुत बड़ा है।'],
  422: ['UNPROCESSABLE', 'This cannot be done right now.', 'यह अभी नहीं हो सकता।'],
  429: ['TOO_MANY_REQUESTS', 'Too many attempts. Wait a minute.', 'बहुत ज़्यादा कोशिशें। एक मिनट रुकें।'],
};

function isErrorBody(x: unknown): x is ErrorBody {
  return Boolean(x && typeof x === 'object' && 'code' in x && 'message_en' in x && 'message_hi' in x);
}

/** Converts any thrown value into the API error body. */
export function toErrorBody(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const res = err.getResponse();
    if (isErrorBody(res)) return { status, body: { ...res, details: res.details ?? null } };
    const [code, en, hi] = BY_STATUS[status] ?? ['ERROR', 'Something went wrong.', 'कुछ गलत हो गया।'];
    const message = typeof res === 'object' && res && 'message' in res ? (res as { message: unknown }).message : res;
    return { status, body: { code, message_en: en, message_hi: hi, details: message ? { message } : null } };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'INTERNAL_ERROR', message_en: 'Something went wrong. Please try again.', message_hi: 'कुछ गलत हो गया। फिर से कोशिश करें।', details: null },
  };
}

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('pos-api');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;
    const { status, body } = toErrorBody(exception);
    if (status >= 500 && !(exception instanceof HttpException)) this.logger.error(exception);
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}
