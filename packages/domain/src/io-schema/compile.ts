import type { IoField, IoSchema } from '@actionow/contracts';
import { z } from 'zod';

import { DomainError } from '../errors.js';

/** Base (pre required/default) zod schema for a single io field by its declared type. */
function baseFieldSchema(field: IoField): z.ZodTypeAny {
  switch (field.type) {
    case 'string':
    case 'file': {
      const s = z.string();
      return field.maxLength !== undefined ? s.max(field.maxLength) : s;
    }
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'enum': {
      const options = field.options;
      if (options === undefined || options.length === 0) {
        throw new DomainError(
          'invalid_input',
          `enum field "${field.key}" must declare a non-empty options list`,
        );
      }
      // z.enum requires a non-empty readonly tuple; widen explicitly.
      return z.enum([options[0], ...options.slice(1)] as [string, ...string[]]);
    }
    case 'file_list':
      return z.array(z.string());
  }
}

/**
 * Compile an io_schema's `inputs` into a strict zod object.
 *
 * - `required` defaults to FALSE — a field is required only when `required === true`.
 * - Optional fields with a `default` fall back to it; optional fields without a
 *   default are simply absent when omitted.
 * - Unknown input keys are rejected (`.strict()`).
 *
 * Throws `DomainError('invalid_input')` for a structurally invalid config
 * (e.g. an enum field without options).
 */
export function compileInputs(schema: IoSchema): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of schema.inputs) {
    const base = baseFieldSchema(field);
    if (field.required === true) {
      shape[field.key] = base;
    } else if (field.default !== undefined) {
      shape[field.key] = base.optional().default(field.default);
    } else {
      shape[field.key] = base.optional();
    }
  }
  return z.object(shape).strict();
}
