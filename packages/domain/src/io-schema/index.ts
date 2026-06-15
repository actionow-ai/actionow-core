import type { IoSchema } from '@actionow/contracts';

import { DomainError } from '../errors.js';
import { compileInputs } from './compile.js';

export { compileInputs } from './compile.js';

export type ValidateInputsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: DomainError };

/**
 * Validate raw user inputs against an io_schema.
 *
 * Compiles the schema to a strict zod object (defaults applied, unknown keys
 * rejected, `required` defaulting to false) and parses. On failure, returns a
 * `DomainError('invalid_input')` whose message enumerates the offending fields.
 */
export function validateInputs(
  schema: IoSchema,
  inputs: Record<string, unknown>,
): ValidateInputsResult {
  let compiled: ReturnType<typeof compileInputs>;
  try {
    compiled = compileInputs(schema);
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, error: err };
    throw err;
  }

  const result = compiled.safeParse(inputs);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, error: new DomainError('invalid_input', detail) };
}
