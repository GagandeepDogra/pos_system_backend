import { HttpException, HttpStatus } from '@nestjs/common';

/** An HTTP error with the API's body shape: {code, message_en, message_hi, details}. */
export class ApiError extends HttpException {
  constructor(status: number, readonly code: string, messageEn: string, messageHi: string, details: unknown = null) {
    super({ code, message_en: messageEn, message_hi: messageHi, details }, status);
  }
}

/** 409: the If-Match row_version is stale; details.current holds the row as it is now. */
export class RowVersionConflictError extends ApiError {
  constructor(readonly current: unknown) {
    super(
      HttpStatus.CONFLICT,
      'ROW_VERSION_CONFLICT',
      'Someone else changed this first. Please check and try again.',
      'किसी और ने पहले बदल दिया। जाँच कर फिर से कोशिश करें।',
      { current },
    );
  }
}

export class NotFoundError extends ApiError {
  constructor(what: string, id: string) {
    super(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} ${id} not found`, `${what} ${id} नहीं मिला`, { id });
  }
}

/** 503 while the server is still loading, or when the workbook is corrupt and writes are blocked. */
export class StartingError extends ApiError {
  constructor() {
    super(HttpStatus.SERVICE_UNAVAILABLE, 'STARTING', 'Server is starting', 'सर्वर शुरू हो रहा है');
  }
}

export class WritesBlockedError extends ApiError {
  constructor(reason: string) {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'WRITES_BLOCKED',
      'Saving is stopped. Ask the owner to restore the latest backup.',
      'सेव बंद है। मालिक से नया बैकअप वापस लाने को कहें।',
      { reason },
    );
  }
}

/** 503: the journal line could not be written; nothing was changed. */
export class JournalUnavailableError extends ApiError {
  constructor(reason: string) {
    super(
      HttpStatus.SERVICE_UNAVAILABLE,
      'SAVE_FAILED',
      'Could not save. Nothing was changed; please try again.',
      'सेव नहीं हुआ। कुछ नहीं बदला; फिर से कोशिश करें।',
      { reason },
    );
  }
}
