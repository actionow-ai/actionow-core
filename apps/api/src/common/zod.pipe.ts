import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { engineInvalidInput } from './errors.js';

/**
 * A NestJS pipe that validates a request body against a zod schema, matching
 * the contracts/domain convention of zod-typed inputs. On failure it throws an
 * `invalid_input` engine error so the {@link UnifiedErrorFilter} renders the
 * §4.7 envelope (400) — never a raw NestJS 400. The parsed, typed value flows
 * through to the handler.
 *
 * Used as `@Body(new ZodBody(schema))` so each route declares its own contract
 * without a global pipe that would also intercept primitive params.
 */
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first?.path.join('.') ?? '';
      const detail = first === undefined ? 'invalid body' : `${path}: ${first.message}`;
      throw engineInvalidInput(detail);
    }
    return result.data;
  }
}
