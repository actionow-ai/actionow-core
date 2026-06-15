/**
 * Typed error for the Dify DSL parse / registration pipeline. Carries a stable
 * machine-readable `code` so callers (and tests) can branch on the failure mode
 * without string-matching the message.
 */
export type DifyParseErrorCode =
  | 'invalid_dsl'
  | 'unsupported_mode'
  | 'unsupported_version'
  | 'metered_not_allowed';

export class DifyParseError extends Error {
  public readonly code: DifyParseErrorCode;

  public constructor(code: DifyParseErrorCode, message?: string) {
    // Always surface the machine-readable `code` in the message so callers and
    // tests can match on it without reaching for `.code` (and so logs are
    // self-describing). `code` is also exposed as a field for branching.
    super(message === undefined ? code : `${code}: ${message}`);
    this.name = 'DifyParseError';
    this.code = code;
  }
}
