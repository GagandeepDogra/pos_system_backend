// Input validation (REQ-124, REQ-114): class-validator DTOs with whitelist +
// forbidNonWhitelisted (an unknown field is a 400), and a formula-injection
// guard that strips leading = + - @ from every text value before validation,
// so a customer name '=HYPERLINK(...)' is stored as 'HYPERLINK(...)'.
import { ArgumentMetadata, Injectable, PipeTransform, ValidationError, ValidationPipe } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Allow } from 'class-validator';
import { ApiError } from './errors';

const FORMULA_PREFIX = /^[\s=+\-@]+/;

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Removes leading =, +, - and @ (and any whitespace among them) from a text
 * value. A plain number such as "-5.00" is left alone, so validation can still
 * reject it instead of it silently turning positive.
 */
export function stripFormula(value: string): string {
  if (PLAIN_NUMBER.test(value)) return value;
  return value.replace(FORMULA_PREFIX, '');
}

/** Applies stripFormula to every string inside a JSON value. */
export function stripFormulas<T>(value: T): T {
  if (typeof value === 'string') return stripFormula(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripFormulas(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripFormulas(v);
    return out as T;
  }
  return value;
}

/** Strips formula prefixes from request bodies (not from params, headers or query). */
@Injectable()
export class FormulaStripPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    return metadata.type === 'body' ? stripFormulas(value) : value;
  }
}

function flatten(errors: ValidationError[], parent = ''): { field: string; problems: string[] }[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints ? [{ field, problems: Object.values(e.constraints) }] : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/** The global ValidationPipe; failures answer 400 VALIDATION_FAILED with details.errors. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new ApiError(400, 'VALIDATION_FAILED', 'Please check the entered values.', 'भरी गई जानकारी जाँचें।', {
        errors: flatten(errors),
      }),
  });
}

/**
 * Marks a field a client may send but the server always derives (price,
 * unit_price, totals, timestamps): it is accepted and then dropped, so the
 * server value is used (REQ-114). Fields that are neither declared nor marked
 * are rejected by forbidNonWhitelisted.
 */
export function ServerDerived(): PropertyDecorator {
  return (target, key) => {
    Allow()(target, key);
    Transform(() => undefined)(target, key);
  };
}
