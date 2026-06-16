import type { PricebookEntry } from '@actionow/contracts';
import { modelTokenSpecSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

import { quote, settle } from '../src/pricing/quote.js';

/** A `model_token` entry: 30 µcredit/input-token, 60 µcredit/output-token. */
function entry(timing: 'pre' | 'post'): PricebookEntry {
  return {
    resourceId: 'r1',
    resourceVersion: 1,
    version: 1,
    method: 'model_token',
    timing,
    spec: { method: 'model_token', inputPrice: 30, outputPrice: 60 },
  } as unknown as PricebookEntry;
}

describe('model_token pricing', () => {
  it('settle prices observed input/output token usage', () => {
    // The adapter usage vector is snake_case (input_tokens/output_tokens).
    // 100 input * 30 + 50 output * 60 = 3000 + 3000 = 6000 µcredits.
    expect(settle(entry('post'), { input_tokens: 100, output_tokens: 50 })).toBe(6000n);
  });

  it('settle treats missing token counts as zero', () => {
    expect(settle(entry('post'), {})).toBe(0n);
  });

  it('quote prices the estimated input/output tokens (pre timing)', () => {
    // Hold-sizing reads the same snake_case usage vector the adapters emit.
    // 10 input * 30 + 200 output * 60 = 300 + 12000 = 12300 µcredits.
    expect(quote(entry('pre'), { input_tokens: 10, output_tokens: 200 })).toBe(12300n);
  });

  it('rejects a negative price spec', () => {
    expect(
      modelTokenSpecSchema.safeParse({
        method: 'model_token',
        inputPrice: -1,
        outputPrice: 60,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-integer price spec', () => {
    expect(() =>
      modelTokenSpecSchema.parse({
        method: 'model_token',
        inputPrice: 30,
        outputPrice: 1.5,
      }),
    ).toThrow();
  });
});
