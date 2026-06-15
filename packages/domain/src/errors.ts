export type DomainErrorCode =
  | 'invalid_input'
  | 'invalid_pricing'
  | 'price_key_not_found'
  | 'invalid_transition';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    // Prefix the stable code so it appears in `error.message`/stack — callers
    // (and tests) can match on the code, while the detail aids debugging.
    super(`${code}: ${message}`);
    this.name = 'DomainError';
    this.code = code;
  }
}
