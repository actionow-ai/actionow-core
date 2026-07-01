export interface RetryOpts {
  max?: number;
  baseMs?: number;
}

/**
 * Call an HTTP thunk, retrying ONLY when the unified error envelope says
 * `retryable:true` (never 402/400). Honors `retry_after_ms`. Throws the unified
 * error (with `code`/`status`) when exhausted or non-retryable.
 */
export async function callWithRetry(fn: () => Promise<Response>, opts: RetryOpts = {}): Promise<Response> {
  const max = opts.max ?? 3;
  const baseMs = opts.baseMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    const res = await fn();
    if (res.ok) return res;
    const body = (await res
      .clone()
      .json()
      .catch(() => ({}))) as { error?: { code?: string; retryable?: boolean; retry_after_ms?: number } };
    const err = body.error ?? {};
    if (!err.retryable || attempt >= max) {
      throw Object.assign(new Error(err.code ?? res.statusText), { code: err.code, status: res.status });
    }
    await new Promise((r) => setTimeout(r, err.retry_after_ms ?? 2 ** attempt * baseMs));
  }
}
