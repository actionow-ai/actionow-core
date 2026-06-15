export type DomainErrorCode =
  | 'invalid_input'
  | 'invalid_pricing'
  | 'price_key_not_found'
  | 'invalid_transition';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
