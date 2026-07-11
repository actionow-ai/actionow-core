// model-supply-greenfield 批次2 wave2 — the OpenAI dialect passes the seven-gate
// conformance suite (plan v3 完成标准 2.4: openai/anthropic/gemini/火山/惠梦 5
// 方言全部过门). openai is the BASELINE OpenAI-compatible dialect authored as
// CODE (not DSL): it has two buffered ops — chat.completions{direct,stream} +
// embeddings{direct} — which the DSL engine cannot serve on the stream path
// (normalizeStreamFrame has no ctx/operation, and resolveResponseSpec(pack,
// undefined) throws for >1 direct/stream op). See src/dialects/openai.dialect.ts.
//
// Coverage: chat.completions exercises gates 1/2/4/6/7 (direct + stream);
// embeddings exercises gates 1/2/6/7 (direct). Gate 3 (media) and gate 5 (task)
// are LEGITIMATELY skipped — both ops are text buffered ops with no media
// inputs and no task lifecycle (no fake-pass via omission). Every op pins
// `ctx.config.operation` so aspect ⑤ `normalize` selects the right response spec
// (the multi-operation dispatch the task calls out), and a dedicated
// programmatic block drives runSync for BOTH ops to prove the dispatch is live.
import type { CredentialSecret, EffectiveParams } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// The conformance suite pulls in vitest; import it from the dedicated module so
// it never rides the production barrel (@actionow/spi/conformance subpath).
import type { ConformanceSubject } from '../../src/conformance.js';
import { describeConformance, runConformanceSuite } from '../../src/conformance.js';
import { openaiDialect, openaiErrorTable } from '../../src/dialects/openai.dialect.js';
import type { DialectContext } from '../../src/index.js';
import { resolveError, runSync } from '../../src/index.js';
import { fakeHttp, jsonResponse } from '../stub.js';

const NOW = 1_752_000_000_000;
const BASE = 'https://api.openai.com/v1';
const SECRET: CredentialSecret = { scheme: 'bearer', api_key: 'sk-openai-test-key' };

const CTX_CHAT: DialectContext = {
  baseUrl: BASE,
  config: { operation: 'chat.completions', provider: 'openai' },
  nowMs: NOW,
};
const CTX_EMB: DialectContext = {
  baseUrl: BASE,
  config: { operation: 'embeddings', provider: 'openai' },
  nowMs: NOW,
};

const CHAT_PARAMS: EffectiveParams = {
  canonical: { origin_marker: 'CANON_ONLY_CHAT' },
  upstream: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 },
};
const EMB_PARAMS: EffectiveParams = {
  canonical: { origin_marker: 'CANON_ONLY_EMB' },
  upstream: { input: ['hello', 'world'], encoding_format: 'float' },
};

// A representative chat success body carrying the full nested usage breakdown.
const CHAT_BODY = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-4o',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 4 },
  },
};
const EMB_BODY = {
  object: 'list',
  model: 'text-embedding-3-small',
  data: [{ index: 0, object: 'embedding', embedding: [0.1, 0.2, 0.3] }],
  usage: { prompt_tokens: 3, total_tokens: 3 },
};

/**
 * The openai acceptance subject. chat.completions covers direct + stream (gates
 * 1/2/4/6/7); embeddings covers direct (gates 1/2/6/7). Bearer auth means gate 1
 * verifies header placement (openai has no signature vectors). Each op puts a
 * distinctive canonical-only marker in `params.canonical` so gate 2 proves
 * aspect ① never leaks a canonical value (§4.1 layer-3 red line).
 */
const subject: ConformanceSubject = {
  label: 'openai@1.0.0 (code, bearer)',
  dialect: openaiDialect,
  operations: [
    {
      operation: 'chat.completions',
      upstreamModelName: 'gpt-4o',
      params: CHAT_PARAMS,
      secret: SECRET,
      ctx: CTX_CHAT,
      fetchMode: 'direct',
      expectedDraft: {
        method: 'POST',
        path: '/chat/completions',
        bodyKind: 'json',
        body: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.7,
        },
      },
      canonicalLeakMarkers: ['CANON_ONLY_CHAT'],
      successResponse: { body: CHAT_BODY },
      stream: {
        deltaFrames: [
          '{"choices":[{"index":0,"delta":{"content":"He"}}]}',
          '{"choices":[{"index":0,"delta":{"content":"llo"}}]}',
        ],
        doneSentinel: '[DONE]',
        earlyFrame: '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
      },
    },
    {
      operation: 'embeddings',
      upstreamModelName: 'text-embedding-3-small',
      params: EMB_PARAMS,
      secret: SECRET,
      ctx: CTX_EMB,
      fetchMode: 'direct',
      expectedDraft: {
        method: 'POST',
        path: '/embeddings',
        bodyKind: 'json',
        body: {
          model: 'text-embedding-3-small',
          input: ['hello', 'world'],
          encoding_format: 'float',
        },
      },
      canonicalLeakMarkers: ['CANON_ONLY_EMB'],
      successResponse: { body: EMB_BODY },
    },
  ],
};

// The gate, expanded into real vitest cases. All green ⇒ openai passes.
describeConformance(subject);

// A programmatic sanity assertion over the same subject — proves the report is
// green with gate 3 (media) and gate 5 (task) legitimately skipped (text ops
// with no media inputs / no task lifecycle), never a fake-pass by omission.
describe('openai conformance report (programmatic)', () => {
  it('passes every runnable gate with the expected coverage', async () => {
    const report = await runConformanceSuite(subject);
    expect(report.passed).toBe(true);
    expect(report.categories.map((c) => c.status)).toEqual([
      'pass', // credential-injection-and-signature
      'pass', // parameter-mapping-and-domain
      'skip', // media-reference-forms (no media inputs on chat/embeddings)
      'pass', // streaming-resilience (chat.completions)
      'skip', // task-status-mapping (no task op)
      'pass', // error-table-completeness
      'pass', // timeout-budget
    ]);
    expect(report.warnings).toEqual([]);
  });
});

// Multi-operation dispatch (验证多操作分派): aspect ⑤ `normalize` carries no
// operation, so it selects the response spec via ctx.config.operation. Drive
// runSync for BOTH ops and assert the extraction genuinely differs.
describe('openai multi-operation normalize dispatch', () => {
  it('chat.completions → output=$.choices + full usage breakdown', async () => {
    const res = await runSync(
      openaiDialect,
      {
        operation: 'chat.completions',
        upstreamModelName: 'gpt-4o',
        params: CHAT_PARAMS,
        secret: SECRET,
        ctx: CTX_CHAT,
      },
      { http: fakeHttp(() => jsonResponse(200, CHAT_BODY)) },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output).toEqual(CHAT_BODY.choices);
      expect(res.usage.metrics).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        cached_input_tokens: 2,
        reasoning_tokens: 4,
      });
    }
  });

  it('embeddings → output=$.data + input_tokens ONLY (no output_tokens)', async () => {
    const res = await runSync(
      openaiDialect,
      {
        operation: 'embeddings',
        upstreamModelName: 'text-embedding-3-small',
        params: EMB_PARAMS,
        secret: SECRET,
        ctx: CTX_EMB,
      },
      { http: fakeHttp(() => jsonResponse(200, EMB_BODY)) },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.output).toEqual(EMB_BODY.data);
      expect(res.usage.metrics).toEqual({ input_tokens: 3 });
    }
  });

  it('dispatch is live: the SAME chat body read as embeddings extracts $.data (absent)', async () => {
    const res = await runSync(
      openaiDialect,
      {
        operation: 'embeddings',
        upstreamModelName: 'gpt-4o',
        params: CHAT_PARAMS,
        secret: SECRET,
        // pin embeddings → the chat body's $.data is undefined, proving the
        // branch keys off ctx.config.operation, not the body shape.
        ctx: CTX_EMB,
      },
      { http: fakeHttp(() => jsonResponse(200, CHAT_BODY)) },
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output).toBeUndefined();
  });
});

// Error-table nuance: `insufficient_quota` (an HTTP 429) must resolve to
// insufficient_credits BEFORE the generic 429 rate_limited row (first-match
// order). The httpStatus/timeout/network rows carry gate-6 completeness.
describe('openai error-table ordering', () => {
  it('insufficient_quota (429) → insufficient_credits (non-retryable, failover)', () => {
    const err = resolveError(openaiErrorTable, {
      httpStatus: 429,
      upstreamCode: 'insufficient_quota',
      provider: 'openai',
    });
    expect(err.code).toBe('insufficient_credits');
    expect(err.retryable).toBe(false);
    expect(err.failover).toBe(true);
  });

  it('rate_limit_exceeded (429) → rate_limited (retryable, failover)', () => {
    const err = resolveError(openaiErrorTable, {
      httpStatus: 429,
      upstreamCode: 'rate_limit_exceeded',
      provider: 'openai',
    });
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.failover).toBe(true);
  });
});
