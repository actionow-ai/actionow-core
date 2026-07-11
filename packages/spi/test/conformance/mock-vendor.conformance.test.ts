// model-supply-greenfield 批次2 slice 3 — the MOCK VENDOR passes the seven-gate
// conformance suite (判据 2.4: "以 mock 厂商演示 DSL 零代码接入一个新方言成功").
// The slice-2 mock-vendor YAML pack is compiled to a dialect and driven through
// `describeConformance`, which expands into real vitest cases — all green = the
// mock dialect clears the gate with ZERO adapter code. This is also the worked
// example a wave2 dialect copies (see ./README.md).
import { readFileSync } from 'node:fs';

import type { CredentialSecret } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// The conformance suite pulls in vitest; import it from the dedicated module so
// it never rides the production barrel (@actionow/spi/conformance subpath).
import type { ConformanceSubject } from '../../src/conformance.js';
import { describeConformance, runConformanceSuite } from '../../src/conformance.js';
import type { DialectContext } from '../../src/index.js';
import { compileDialect, loadDialectPack } from '../../src/index.js';

const YAML = readFileSync(new URL('../fixtures/mock-vendor.dialect.yaml', import.meta.url), 'utf8');
const CTX: DialectContext = { baseUrl: 'https://mock.test', nowMs: 1_752_000_000_000 };
const SECRET: CredentialSecret = { scheme: 'bearer', api_key: 'sk-mv' };

const dialect = compileDialect(loadDialectPack(YAML));

/**
 * The mock-vendor acceptance subject. `chat.completions` exercises direct +
 * stream (gates 1/2/4/6/7); `images.generation` exercises submit_poll + media +
 * task status (gates 1/2/3/5). Bearer auth means gate 1 verifies header
 * placement (the mock has no official signature vectors — §6 record path). Each
 * op deliberately puts a distinctive canonical-only marker in `params.canonical`
 * so gate 2 proves aspect ① never leaks canonical values (§4.1 layer-3 red line).
 */
const subject: ConformanceSubject = {
  label: 'mockvendor@1.0.0 (DSL, bearer)',
  dialect,
  operations: [
    {
      operation: 'chat.completions',
      upstreamModelName: 'mv-chat-1',
      params: {
        canonical: { origin_marker: 'CANON_ONLY_CHAT' },
        upstream: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 },
      },
      secret: SECRET,
      ctx: CTX,
      fetchMode: 'direct',
      expectedDraft: {
        method: 'POST',
        path: '/v1/chat/completions',
        bodyKind: 'json',
        body: {
          model: 'mv-chat-1',
          messages: [{ role: 'user', content: 'hi' }],
          temperature: 0.7,
        },
      },
      canonicalLeakMarkers: ['CANON_ONLY_CHAT'],
      successResponse: {
        body: {
          choices: [{ message: { content: 'hello' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
      },
      stream: {
        deltaFrames: [
          '{"choices":[{"delta":{"content":"He"}}]}',
          '{"choices":[{"delta":{"content":"llo"}}]}',
        ],
        doneSentinel: '[DONE]',
        earlyFrame: '{"choices":[{"delta":{"role":"assistant"}}]}',
      },
    },
    {
      operation: 'images.generation',
      upstreamModelName: 'mv-img-1',
      params: {
        canonical: { origin_marker: 'CANON_ONLY_IMG' },
        upstream: { prompt: 'a cat', size: '1024x1024' },
      },
      secret: SECRET,
      ctx: CTX,
      fetchMode: 'submit_poll',
      expectedDraft: {
        method: 'POST',
        path: '/v1/images/generations',
        bodyKind: 'json',
        body: { model: 'mv-img-1', prompt: 'a cat', size: '1024x1024' },
      },
      canonicalLeakMarkers: ['CANON_ONLY_IMG'],
      media: {
        url: { param: 'image', form: 'url', url: 'https://cdn.mock.test/ref.png' },
        base64: { param: 'image', form: 'base64', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      },
      task: {
        knownStatuses: ['queued', 'processing', 'done', 'error'],
        unknownStatus: 'transcoding',
        pollBody: (status) => ({
          task_id: 'img-1',
          status,
          ...(status === 'done'
            ? { image_url: 'https://cdn.mock.test/out.png', usage: { images: 1 } }
            : {}),
          ...(status === 'error' ? { error: { message: 'render failed' } } : {}),
        }),
      },
    },
  ],
};

// The gate, expanded into real vitest cases. All green ⇒ the mock dialect passes.
describeConformance(subject);

// A programmatic sanity assertion over the same subject — proves the report is
// green with no failing gate and no gate erroneously skipped for the mock.
describe('mockvendor conformance report (programmatic)', () => {
  it('passes every gate with the expected coverage', async () => {
    const report = await runConformanceSuite(subject);
    expect(report.passed).toBe(true);
    expect(report.categories.map((c) => c.status)).toEqual([
      'pass', // credential-injection-and-signature
      'pass', // parameter-mapping-and-domain
      'pass', // media-reference-forms
      'pass', // streaming-resilience
      'pass', // task-status-mapping
      'pass', // error-table-completeness
      'pass', // timeout-budget
    ]);
    expect(report.warnings).toEqual([]);
  });
});
