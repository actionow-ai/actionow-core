import type { UnifiedErrorCode } from '@actionow/contracts';

/** A request-translation/normalization failure, surfaced to the API layer. */
export class ProtocolError extends Error {
  readonly code: UnifiedErrorCode;
  constructor(code: UnifiedErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}
