/** Mirrors the §4.7 envelope's `error` object as a thrown error. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Thrown locally when a valid login is not an admin (role gate, not a server error). */
export class NotAdminError extends ApiError {
  constructor() {
    super('forbidden_not_admin', 'not an admin account', 403, false);
    this.name = 'NotAdminError';
  }
}
