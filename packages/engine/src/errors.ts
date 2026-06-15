import type { UnifiedError, UnifiedErrorCode } from '@actionow/contracts';

/**
 * Engine-level error carrying a {@link UnifiedError} payload. The execution
 * service raises this for every failure the caller (api/worker) maps to the
 * §4.7 unified error filter — `insufficient_credits`, `invalid_input`, a
 * propagated adapter `upstream_error`, etc.
 *
 * The unified payload is the stable, sanitized contract surface; the `Error`
 * `message` mirrors `unified.message` for logs. No secret material is ever
 * placed on this error.
 */
export class EngineError extends Error {
  readonly unified: UnifiedError;

  constructor(unified: UnifiedError) {
    super(unified.message);
    this.name = 'EngineError';
    this.unified = unified;
  }
}

/** Build a non-retryable {@link EngineError} for the given code/message. */
export function engineError(
  code: UnifiedErrorCode,
  message: string,
  opts: { retryable?: boolean } = {},
): EngineError {
  return new EngineError({ code, message, retryable: opts.retryable ?? false });
}
