// model-supply-greenfield 批次2 wave2 — the ANTHROPIC dialect clears the
// seven-gate conformance suite. Anthropic is the 「首个代码切面样例」: unlike the
// DSL mock-vendor pack, its aspects are hand-written TypeScript
// (src/dialects/anthropic.dialect.ts), yet it is driven through the EXACT same
// `describeConformance` machinery — proving the code and DSL authoring tracks
// are EQUIVALENT at the gate (判据: 代码切面与 DSL 方言在同一 describeConformance
// 下等价过门). The programmatic report below pins the per-gate verdicts so the
// equivalence is asserted, not merely implied.
//
// chat.completions exercises direct + stream (gates 1/2/4/6/7). It declares no
// media and no task sub-case because the Anthropic chat wire carries neither as
// a top-level param (vision media rides inside messages content blocks; there
// is no async task endpoint) — so gates 3 and 5 SKIP legitimately, never a
// silent drop. The streaming case feeds a NAMED-event sequence (message_start →
// content_block_start → text deltas → content_block_stop → message_delta) whose
// terminator is `message_stop` (NOT [DONE]); the gate then drives it through
// half-frame split, out-of-order (ping) prelude, mid-stream cut, empty-stream
// and over-ceiling overflow.
import type { CredentialSecret } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// The conformance suite pulls in vitest; import it from the dedicated module so
// it never rides the production barrel (@actionow/spi/conformance subpath).
import type { ConformanceSubject } from '../../src/conformance.js';
import { describeConformance, runConformanceSuite } from '../../src/conformance.js';
import { anthropicDialect } from '../../src/dialects/anthropic.dialect.js';
import type { DialectContext } from '../../src/index.js';

const CTX: DialectContext = { baseUrl: 'https://api.anthropic.com', nowMs: 1_752_000_000_000 };
const SECRET: CredentialSecret = { scheme: 'x_api_key', api_key: 'sk-ant-test-0001' };

// The real streaming payloads in wire order — each is the JSON a `data:` line
// carries (the framer drops the `event:` name; the dialect dispatches on
// `type`). deltaFrames[0] = message_start is administrative (→ []), which is
// exactly what the gate's overflow/cut drives need for a non-terminal opener.
const streamDeltaFrames: string[] = [
  JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_stream_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-3-5-sonnet-20241022',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 12, output_tokens: 1 },
    },
  }),
  JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'He' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'llo' },
  }),
  JSON.stringify({ type: 'content_block_stop', index: 0 }),
  JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 9 },
  }),
];

/**
 * The Anthropic acceptance subject. One chat.completions op case drives gates
 * 1 (x-api-key placement + post-③ freeze), 2 (aspect-① snapshot + §4.1 red
 * line — the canonical-only marker must never leak), 4 (streaming resilience),
 * 6 (error-table completeness) and 7 (four-timeout passthrough). No `media` /
 * `task` sub-case ⇒ gates 3 / 5 skip.
 */
const subject: ConformanceSubject = {
  label: 'anthropic@1.0.0 (code, x-api-key)',
  dialect: anthropicDialect,
  operations: [
    {
      operation: 'chat.completions',
      upstreamModelName: 'claude-3-5-sonnet-20241022',
      params: {
        canonical: { origin_marker: 'CANON_ONLY_ANTHROPIC' },
        upstream: {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 1024,
          system: 'You are terse.',
          temperature: 0.7,
        },
      },
      secret: SECRET,
      ctx: CTX,
      fetchMode: 'direct',
      // Aspect ① is pure porterage: body = { model, ...upstream }; the static
      // anthropic-version header rides along; NO stream field on the direct draft.
      expectedDraft: {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'anthropic-version': '2023-06-01' },
        bodyKind: 'json',
        body: {
          model: 'claude-3-5-sonnet-20241022',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 1024,
          system: 'You are terse.',
          temperature: 0.7,
        },
      },
      canonicalLeakMarkers: ['CANON_ONLY_ANTHROPIC'],
      successResponse: {
        body: {
          id: 'msg_01',
          type: 'message',
          role: 'assistant',
          model: 'claude-3-5-sonnet-20241022',
          content: [{ type: 'text', text: 'Hello there.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 9 },
        },
      },
      stream: {
        deltaFrames: streamDeltaFrames,
        // Anthropic terminates with message_stop, NOT a [DONE] sentinel.
        doneSentinel: JSON.stringify({ type: 'message_stop' }),
        // A benign admin frame delivered early (order tolerance) — normalizes to [].
        earlyFrame: JSON.stringify({ type: 'ping' }),
      },
    },
  ],
};

// The gate, expanded into real vitest cases. All active gates green ⇒ the
// code-authored Anthropic dialect passes the same suite the DSL mock does.
describeConformance(subject);

// Programmatic parity assertion — pins the per-gate verdicts so the
// code-aspect ≡ DSL equivalence (判据) is checked, not merely implied. Media (3)
// and task (5) SKIP because chat.completions declares neither sub-case; nothing
// FAILS; the error table raises no soft-flag warnings.
describe('anthropic conformance report (programmatic)', () => {
  it('passes every active gate and skips only media + task', async () => {
    const report = await runConformanceSuite(subject);
    expect(report.passed).toBe(true);
    expect(report.categories.map((c) => c.status)).toEqual([
      'pass', // credential-injection-and-signature
      'pass', // parameter-mapping-and-domain
      'skip', // media-reference-forms (chat carries none top-level)
      'pass', // streaming-resilience
      'skip', // task-status-mapping (no async endpoint)
      'pass', // error-table-completeness
      'pass', // timeout-budget
    ]);
    expect(report.warnings).toEqual([]);
  });
});
