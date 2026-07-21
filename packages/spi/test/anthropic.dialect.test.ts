// Unit coverage for the Anthropic dialect's request-body construction — the
// max_tokens safety net (BUG 1): the Messages API REQUIRES max_tokens, so the
// dialect must inject a default on EVERY call that lacks one, while preserving
// any caller-provided value. Mirrors the conformance fixture's shapes but
// asserts the request-mapping aspect directly (no upstream needed).
import { describe, expect, it } from 'vitest';

import type { DialectContext, RequestMappingInput } from '../src/aspects.js';
import { anthropicDialect } from '../src/dialects/anthropic.dialect.js';

const CTX: DialectContext = { baseUrl: 'https://api.anthropic.com', nowMs: 1_752_000_000_000 };

function mapInput(
  upstream: Record<string, unknown>,
  overrides: Partial<RequestMappingInput> = {},
): RequestMappingInput {
  return {
    operation: 'chat.completions',
    upstreamModelName: 'claude-3-5-sonnet-20241022',
    params: { canonical: {}, upstream },
    stream: false,
    ctx: CTX,
    ...overrides,
  };
}

describe('anthropic dialect — request mapping (max_tokens default)', () => {
  it('injects max_tokens: 4096 when the effective request carries none', () => {
    const draft = anthropicDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'Hello' }] }),
    );
    const body = draft.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
    expect(body.model).toBe('claude-3-5-sonnet-20241022');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('preserves a caller-provided max_tokens (never overwrites)', () => {
    const draft = anthropicDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1024 }),
    );
    expect((draft.body as Record<string, unknown>).max_tokens).toBe(1024);
  });

  it('preserves an explicit max_tokens of 0 (not treated as absent)', () => {
    const draft = anthropicDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: 0 }),
    );
    expect((draft.body as Record<string, unknown>).max_tokens).toBe(0);
  });

  it('defaults an explicit null max_tokens (some clients send null for "no cap")', () => {
    const draft = anthropicDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'Hello' }], max_tokens: null }),
    );
    expect((draft.body as Record<string, unknown>).max_tokens).toBe(4096);
  });

  it('injects the default on the streaming path too (probe + real, sync + stream)', () => {
    const draft = anthropicDialect.requestMapping.map(
      mapInput({ messages: [{ role: 'user', content: 'Hello' }] }, { stream: true }),
    );
    const body = draft.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
  });
});
