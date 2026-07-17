// model-supply-greenfield 批次2 slice 3 — the conformance gate is NOT a rubber
// stamp. Each test here feeds `runConformanceSuite` a DELIBERATELY broken stub
// dialect and asserts the matching gate returns status 'fail' (so these tests
// are GREEN, but the gate's verdict on a bad dialect is red). If any of these
// stopped catching its defect, the gate would be worthless — this file is the
// gate's own regression guard. A positive signature case proves gate 1 is not
// merely always-fail.
import type { CredentialSecret, TaskStatus } from '@actionow/contracts';
import { taskUpdateSchema } from '@actionow/contracts';
import { describe, expect, it } from 'vitest';

// Conformance suite imports vitest — reach it via its dedicated module, never
// the production barrel (@actionow/spi/conformance subpath).
import type {
  ConformanceCategory,
  ConformanceReport,
  SignatureVector,
} from '../../src/conformance.js';
import { runConformanceSuite } from '../../src/conformance.js';
import type {
  DialectContext,
  ErrorTable,
  TaskLifecycleAspect,
  WireRequestDraft,
} from '../../src/index.js';
import { signerCredentialInjection } from '../../src/index.js';
import { BEARER_SECRET, CTX, stubDialect, TABLE } from '../stub.js';

function gate(report: ConformanceReport, name: ConformanceCategory) {
  const category = report.categories.find((c) => c.name === name);
  if (category === undefined) throw new Error(`report is missing gate ${name}`);
  return category;
}

describe('gate 6 — error-table completeness catches a missing tier', () => {
  it('an error table with NO 429 row fails the completeness gate', async () => {
    const missing429: ErrorTable = {
      rows: TABLE.rows.filter((row) => row.match.httpStatus !== 429),
      fallback: TABLE.fallback,
    };
    const report = await runConformanceSuite({
      label: 'broken: error table missing 429',
      dialect: stubDialect({ errorTable: missing429 }),
      operations: [
        {
          operation: 'chat.completions',
          upstreamModelName: 'stub-1',
          params: { canonical: {}, upstream: { messages: [] } },
          secret: BEARER_SECRET,
          ctx: CTX,
          successResponse: { body: {} },
        },
      ],
    });
    const cat = gate(report, 'error-table-completeness');
    expect(cat.status).toBe('fail');
    expect(cat.detail).toContain('http:429');
    expect(report.passed).toBe(false);
  });
});

describe('gate 2 — the §4.1-layer-3 red line catches a canonical leak', () => {
  it('an aspect ① that reads params.canonical fails the red-line gate', async () => {
    const report = await runConformanceSuite({
      label: 'broken: aspect ① leaks canonical',
      dialect: stubDialect({
        requestMapping: {
          map: (input) => ({
            method: 'POST',
            path: '/chat',
            bodyKind: 'json',
            // RED-LINE VIOLATION: aspect ① must consume params.upstream ONLY.
            body: {
              model: input.upstreamModelName,
              ...input.params.canonical,
              ...input.params.upstream,
            },
          }),
        },
      }),
      operations: [
        {
          operation: 'chat.completions',
          upstreamModelName: 'stub-1',
          params: { canonical: { leak: 'CANON_LEAK_XYZ' }, upstream: { messages: [] } },
          secret: BEARER_SECRET,
          ctx: CTX,
          canonicalLeakMarkers: ['CANON_LEAK_XYZ'],
          successResponse: { body: {} },
        },
      ],
    });
    const cat = gate(report, 'parameter-mapping-and-domain');
    expect(cat.status).toBe('fail');
    expect(cat.detail).toContain('CANON_LEAK_XYZ');
    expect(report.passed).toBe(false);
  });
});

describe('gate 5 — task status mapping catches an unknown-status crash', () => {
  const STRICT_MAP: Record<string, TaskStatus> = {
    queued: 'pending',
    processing: 'running',
    done: 'succeeded',
    error: 'failed',
  };
  const brittleTaskLifecycle: TaskLifecycleAspect = {
    buildSubmit: (input) => ({
      method: 'POST',
      path: '/tasks',
      bodyKind: 'json',
      body: { model: input.upstreamModelName },
    }),
    parseSubmitResponse: (res) => ({
      upstreamTaskId: (res.body as { task_id: string }).task_id,
    }),
    buildQuery: (id) => ({ method: 'GET', path: `/tasks/${id}`, bodyKind: 'none' }),
    parseQueryResponse: (res) => {
      const body = res.body as { task_id: string; status: string };
      const mapped = STRICT_MAP[body.status];
      if (mapped === undefined) {
        // §6 VIOLATION: an unknown upstream status must map to a legal status +
        // alert, never crash. This one crashes.
        throw new Error(`unmapped upstream status: ${body.status}`);
      }
      return taskUpdateSchema.parse({
        upstreamTaskId: body.task_id,
        status: mapped,
        rawStatus: body.status,
      });
    },
    verifyCallback: () => true,
    parseCallback: (raw) => {
      const body = JSON.parse(raw.rawBody) as { task_id: string; status: string };
      return taskUpdateSchema.parse({
        upstreamTaskId: body.task_id,
        status: STRICT_MAP[body.status] ?? 'running',
        rawStatus: body.status,
      });
    },
  };

  it('a taskLifecycle that throws on an unknown status fails the mapping gate', async () => {
    const report = await runConformanceSuite({
      label: 'broken: task lifecycle crashes on unknown status',
      dialect: stubDialect({
        operations: { 'video.generation': { fetchModes: ['submit_poll'] } },
        taskLifecycle: brittleTaskLifecycle,
      }),
      operations: [
        {
          operation: 'video.generation',
          upstreamModelName: 'stub-vid-1',
          params: { canonical: {}, upstream: {} },
          secret: BEARER_SECRET,
          ctx: CTX,
          successResponse: { body: {} },
          task: {
            knownStatuses: ['queued', 'processing', 'done', 'error'],
            unknownStatus: 'reticulating',
            pollBody: (status) => ({ task_id: 't1', status }),
          },
        },
      ],
    });
    const cat = gate(report, 'task-status-mapping');
    expect(cat.status).toBe('fail');
    expect(cat.detail).toContain('reticulating');
    expect(report.passed).toBe(false);
  });
});

describe('gate 1 — credential/signature byte comparison catches a corrupted vector', () => {
  const volcDraft: WireRequestDraft = {
    method: 'POST',
    path: 'https://visual.volcengineapi.com/',
    query: { Action: 'CVSync2AsyncSubmitTask', Version: '2022-08-31' },
    headers: {},
    bodyKind: 'json',
    body: { req_key: 'jimeng_t2i_v30', prompt: 'a cat' },
  };
  const volcSecret: CredentialSecret = {
    scheme: 'ak_sk',
    access_key: 'AKLT-test-ak',
    secret_key: 'test-sk',
    region: 'cn-north-1',
  };
  const volcCtx: DialectContext = { nowMs: 1_752_000_000_000, config: { service: 'cv' } };
  const signatureDialect = stubDialect({
    credentialInjection: signerCredentialInjection('volc-v4'),
  });

  // Record the REAL signed headers from this implementation → a self-consistent
  // vector (no official public vectors for volc; §6 record path).
  const signed = signatureDialect.credentialInjection.injectCredential(
    volcDraft,
    volcSecret,
    volcCtx,
  );
  const correctAuth = signed.headers?.Authorization ?? '';
  const recordedVector: SignatureVector = {
    label: 'volc-v4 recorded',
    draft: volcDraft,
    secret: volcSecret,
    ctx: volcCtx,
    expectedHeaders: { Authorization: correctAuth, 'X-Date': signed.headers?.['X-Date'] ?? '' },
  };

  const sigOp = {
    operation: 'chat.completions' as const,
    upstreamModelName: 'stub-sig-1',
    params: { canonical: {}, upstream: {} },
    secret: volcSecret,
    ctx: CTX,
    successResponse: { body: {} },
  };

  it('a CORRECT recorded vector passes gate 1 (the gate is not always-fail)', async () => {
    const report = await runConformanceSuite({
      label: 'signature: correct volc-v4 vector',
      dialect: signatureDialect,
      operations: [sigOp],
      signatureVectors: [recordedVector],
    });
    expect(gate(report, 'credential-injection-and-signature').status).toBe('pass');
    expect(report.passed).toBe(true);
  });

  it('a vector with ONE flipped byte fails gate 1', async () => {
    const flippedAuth = correctAuth.slice(0, -1) + (correctAuth.endsWith('0') ? '1' : '0');
    const corruptedVector: SignatureVector = {
      ...recordedVector,
      label: 'volc-v4 corrupted',
      expectedHeaders: { ...recordedVector.expectedHeaders, Authorization: flippedAuth },
    };
    const report = await runConformanceSuite({
      label: 'broken: corrupted volc-v4 vector',
      dialect: signatureDialect,
      operations: [sigOp],
      signatureVectors: [corruptedVector],
    });
    const cat = gate(report, 'credential-injection-and-signature');
    expect(cat.status).toBe('fail');
    expect(cat.detail).toContain('byte mismatch');
    expect(report.passed).toBe(false);
  });
});
