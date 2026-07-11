// model-supply-greenfield 批次2 wave2 — the GEMINI dialect clears the seven-gate
// conformance suite (判据 2.4: openai/anthropic/gemini/火山/惠梦 五方言全部过门).
// gemini is a CODE dialect (two hard blockers keep it off the DSL track — see
// src/dialects/gemini.dialect.ts): the hand-authored six-aspect Dialect is fed
// straight to `describeConformance`, identical to how a DSL-compiled dialect is.
//
// chat.completions is direct + stream only. ACTIVE gates: 1 (query-key
// credential placement), 2 (aspect-① param mapping + §4.1 red line), 4
// (streaming half-frame / out-of-order / interruption / overflow), 6 (error
// table completeness), 7 (four-field timeout budget). SKIPPED gates: 3 (media —
// gemini media rides inline in contents[].parts[], no separate injection
// aspect) and 5 (task — chat has no submit_poll/callback). Both skips are
// architecturally correct, not fake-pass drops.
import type { CredentialSecret } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// The conformance suite pulls in vitest; import it from the dedicated module so
// it never rides the production barrel (@actionow/spi/conformance subpath).
import type { ConformanceSubject } from '../../src/conformance.js';
import { describeConformance, runConformanceSuite } from '../../src/conformance.js';
import { geminiDialect } from '../../src/dialects/gemini.dialect.js';
import type { DialectContext } from '../../src/index.js';

const CTX: DialectContext = {
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  nowMs: 1_752_000_000_000,
};
// gemini auth = ?key= query scheme (no signer).
const SECRET: CredentialSecret = { scheme: 'query', api_key: 'AIza-test-key-1234567890' };

// The exact gemini-wire body the planner (§4.1 layer 2) already shaped — aspect
// ① spreads it verbatim into the json body and NEVER reads params.canonical.
const CHAT_UPSTREAM = {
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  systemInstruction: { parts: [{ text: 'You are a helpful assistant.' }] },
  generationConfig: { temperature: 0.7, maxOutputTokens: 256, topP: 0.95 },
};

/**
 * The gemini acceptance subject. One operation — chat.completions — exercising
 * both direct (gates 1/2/6/7) and stream (gate 4). The `canonical` bag carries a
 * marker absent from `upstream` so gate 2 proves aspect ① never leaks canonical
 * values (§4.1 layer-3 red line). The stream case feeds real gemini SSE chunks
 * (candidates[0].content.parts[].text + a usageMetadata-bearing chunk, no
 * finishReason) so the harness's appended [DONE] drives the terminal done.
 */
const subject: ConformanceSubject = {
  label: 'gemini@1.0.0 (code, query ?key=)',
  dialect: geminiDialect,
  operations: [
    {
      operation: 'chat.completions',
      upstreamModelName: 'gemini-1.5-pro',
      params: {
        canonical: { origin_marker: 'CANON_ONLY_GEMINI', temperature: 0.7 },
        upstream: CHAT_UPSTREAM,
      },
      secret: SECRET,
      ctx: CTX,
      fetchMode: 'direct',
      expectedDraft: {
        method: 'POST',
        path: 'models/gemini-1.5-pro:generateContent',
        bodyKind: 'json',
        body: CHAT_UPSTREAM,
      },
      canonicalLeakMarkers: ['CANON_ONLY_GEMINI'],
      successResponse: {
        body: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hello there!' }] },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
            totalTokenCount: 16,
          },
        },
      },
      stream: {
        deltaFrames: [
          '{"candidates":[{"content":{"role":"model","parts":[{"text":"He"}]}}]}',
          '{"candidates":[{"content":{"role":"model","parts":[{"text":"llo"}]}}]}',
          '{"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":4,"totalTokenCount":16}}',
        ],
        // gemini has no real sentinel; the harness force-appends [DONE], which
        // the dialect maps to a terminal done (safety net + gate driver).
        doneSentinel: '[DONE]',
        // An early role-only frame (empty parts) → proves order tolerance (§6 乱序).
        earlyFrame: '{"candidates":[{"content":{"role":"model","parts":[]},"index":0}]}',
      },
    },
  ],
};

// The gate, expanded into real vitest cases. All green ⇒ gemini passes.
describeConformance(subject);

// A programmatic sanity assertion over the same subject — proves the report is
// green, the applicable gates are active, and the two genuinely-inapplicable
// gates (media / task) skip rather than fail.
describe('gemini conformance report (programmatic)', () => {
  it('passes every applicable gate and skips only media + task', async () => {
    const report = await runConformanceSuite(subject);
    expect(report.passed).toBe(true);
    const byName = Object.fromEntries(report.categories.map((c) => [c.name, c.status]));
    expect(byName['credential-injection-and-signature']).toBe('pass');
    expect(byName['parameter-mapping-and-domain']).toBe('pass');
    expect(byName['media-reference-forms']).toBe('skip');
    expect(byName['streaming-resilience']).toBe('pass');
    expect(byName['task-status-mapping']).toBe('skip');
    expect(byName['error-table-completeness']).toBe('pass');
    expect(byName['timeout-budget']).toBe('pass');
    // The error table is tuned so no retryable/failover deviation warns.
    expect(report.warnings).toEqual([]);
  });
});
