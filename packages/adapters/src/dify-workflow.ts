import type { SubmitInput, SubmitResult, UnifiedError, UsageVector } from '@actionow/contracts';

import { AdapterError, httpStatusToUnified } from './errors.js';
import { asNumber, asRecord, asString } from './internal/json.js';
import type { ProviderAdapter } from './types.js';

const PROVIDER = 'dify-workflow';

/** Extract `{total_tokens}` from a Dify `{ data: { total_tokens } }` envelope. */
function extractUsage(raw: unknown): UsageVector {
  const data = asRecord(asRecord(raw)?.data);
  return { total_tokens: asNumber(data?.total_tokens) ?? 0 };
}

export const difyWorkflowAdapter: ProviderAdapter = {
  providerType: PROVIDER,

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const { ctx, inputs } = input;

    const res = await ctx.http.request({
      method: 'POST',
      url: `${ctx.endpoint ?? ''}/v1/workflows/run`,
      headers: { Authorization: `Bearer ${ctx.apiKey ?? ''}` },
      body: { inputs, response_mode: 'blocking', user: 'actionow' },
    });

    if (!res.ok) {
      throw new AdapterError(httpStatusToUnified(PROVIDER, res.status));
    }

    const data = asRecord(asRecord(res.body)?.data);
    const status = asString(data?.status);

    if (status === 'succeeded') {
      return {
        kind: 'sync',
        output: asRecord(data?.outputs) ?? {},
        usage: extractUsage(res.body),
      };
    }

    // `failed` (and any non-succeeded terminal status) → job_failed.
    const detail = asString(data?.error);
    throw new AdapterError({
      code: 'job_failed',
      message: detail ?? `dify workflow did not succeed (status=${status ?? 'unknown'})`,
      upstream: { provider: PROVIDER },
      retryable: false,
    });
  },

  extractUsage,

  mapError(raw: unknown): UnifiedError {
    const detail = asString(asRecord(asRecord(raw)?.data)?.error);
    return {
      code: 'job_failed',
      message: detail ?? 'dify workflow failed',
      upstream: { provider: PROVIDER },
      retryable: false,
    };
  },
};
