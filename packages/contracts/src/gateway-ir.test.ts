import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_MODES,
  effectiveParamsSchema,
  GATEWAY_ERROR_CODES,
  gatewayErrorSchema,
  gatewayRequestSchema,
  gatewayResponseSchema,
  OPERATIONS,
  PARADIGMS,
  streamFrameSchema,
  TASK_STATUSES,
  taskUpdateSchema,
  TERMINAL_TASK_STATUSES,
} from './gateway-ir.js';

// 批次0 freeze guards: these vocabularies are frozen additive-only. A failing
// assertion here means someone RESHAPED the frozen contract — additions are
// allowed but must be made consciously (update the expectation in the same
// change, with design-doc backing).
describe('gateway IR frozen vocabulary (批次0)', () => {
  it('OPERATIONS = the 10 §2.1 operation surfaces', () => {
    expect(OPERATIONS).toEqual([
      'chat.completions',
      'embeddings',
      'rerank',
      'moderations',
      'images.generation',
      'images.edit',
      'video.generation',
      'music.generation',
      'tts',
      'asr',
    ]);
  });

  it('PARADIGMS = sync/stream/task + the reserved realtime slot (§13)', () => {
    expect(PARADIGMS).toEqual(['sync', 'stream', 'task', 'realtime']);
  });

  it('TASK_STATUSES = the external six states (§7.1), terminal set fixed', () => {
    expect(TASK_STATUSES).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'expired',
    ]);
    expect(TERMINAL_TASK_STATUSES).toEqual(['succeeded', 'failed', 'canceled', 'expired']);
  });

  it('error taxonomy carries the design-named members', () => {
    for (const code of ['unsupported_parameter', 'model_not_found', 'conflict', 'rate_limited']) {
      expect(GATEWAY_ERROR_CODES).toContain(code);
    }
  });

  it('ARTIFACT_MODES = signed | public (§9.4 产物双轨)', () => {
    expect(ARTIFACT_MODES).toEqual(['signed', 'public']);
  });
});

describe('gatewayRequestSchema', () => {
  const minimal = {
    tenantId: 't1',
    apiKeyId: 'k1',
    operation: 'chat.completions',
    model: 'gpt-x',
  };

  it('parses a minimal request and applies container defaults', () => {
    const r = gatewayRequestSchema.parse(minimal);
    expect(r.params).toEqual({});
    expect(r.mediaRefs).toEqual([]);
    expect(r.options).toEqual({});
    expect(r.subjectId).toBeUndefined();
    expect(r.idempotency).toBeUndefined();
  });

  it('carries canonical params with the explicit-vs-default marker (§4.1 layer 1)', () => {
    const r = gatewayRequestSchema.parse({
      ...minimal,
      operation: 'video.generation',
      params: {
        prompt: { value: 'a cat', isDefault: false },
        resolution: { value: '720p', isDefault: true },
      },
    });
    expect(r.params.resolution).toEqual({ value: '720p', isDefault: true });
    expect(r.params.prompt?.isDefault).toBe(false);
  });

  it('rejects a param entry missing the isDefault marker', () => {
    const out = gatewayRequestSchema.safeParse({
      ...minimal,
      params: { temperature: { value: 0.7 } },
    });
    expect(out.success).toBe(false);
  });

  it('rejects an unknown operation surface', () => {
    const out = gatewayRequestSchema.safeParse({ ...minimal, operation: 'video.remix' });
    expect(out.success).toBe(false);
  });

  it('accepts idempotency key + body fingerprint and media refs', () => {
    const r = gatewayRequestSchema.parse({
      ...minimal,
      operation: 'images.edit',
      mediaRefs: [{ param: 'image', source: 'file_id', data: 'file_123' }],
      options: { artifactMode: 'public', routeTag: 'canary', requirePersist: true },
      idempotency: { key: 'idem-1', bodyFingerprint: 'sha256:abc' },
    });
    expect(r.mediaRefs[0]?.source).toBe('file_id');
    expect(r.options.artifactMode).toBe('public');
    expect(r.idempotency?.bodyFingerprint).toBe('sha256:abc');
  });

  it('rejects idempotency without a body fingerprint (§5 same-key-different-body needs it)', () => {
    const out = gatewayRequestSchema.safeParse({
      ...minimal,
      idempotency: { key: 'idem-1' },
    });
    expect(out.success).toBe(false);
  });
});

describe('effectiveParamsSchema (§4.1 layer 2 output)', () => {
  it('requires BOTH bags — canonical (pricing) and upstream (aspect ① input)', () => {
    const ok = effectiveParamsSchema.parse({
      canonical: { resolution: '1080p' },
      upstream: { size: '1920x1080' },
    });
    expect(ok.canonical.resolution).toBe('1080p');
    expect(ok.upstream.size).toBe('1920x1080');
    expect(effectiveParamsSchema.safeParse({ canonical: {} }).success).toBe(false);
    expect(effectiveParamsSchema.safeParse({ upstream: {} }).success).toBe(false);
  });
});

describe('gatewayResponseSchema', () => {
  it('usage carries billingDims (string/number/boolean tier values) + estimated flag', () => {
    const r = gatewayResponseSchema.parse({
      operation: 'video.generation',
      model: 'video-x',
      output: { artifacts: [] },
      usage: {
        metrics: { video_seconds: 5 },
        billingDims: { resolution: '1080p', duration: 5, audio: true },
      },
      servedBy: { offeringId: 'of1', channelId: 'ch1' },
    });
    expect(r.usage.billingDims).toEqual({ resolution: '1080p', duration: 5, audio: true });
    expect(r.usage.estimated).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('echoes the actual serving offering (criterion 2.2)', () => {
    const r = gatewayResponseSchema.parse({
      operation: 'chat.completions',
      model: 'gpt-x',
      output: null,
      usage: {},
      servedBy: { offeringId: 'of1', channelId: 'ch1', upstreamModelName: 'gpt-x-0710' },
    });
    expect(r.servedBy.upstreamModelName).toBe('gpt-x-0710');
    expect(r.usage.metrics).toEqual({});
  });

  it('rejects a billingDims value that is not string/number/boolean', () => {
    const out = gatewayResponseSchema.safeParse({
      operation: 'chat.completions',
      model: 'm',
      output: null,
      usage: { billingDims: { nested: { no: true } } },
      servedBy: { offeringId: 'of1', channelId: 'ch1' },
    });
    expect(out.success).toBe(false);
  });
});

describe('streamFrameSchema', () => {
  it('parses the four frame kinds', () => {
    expect(streamFrameSchema.parse({ kind: 'delta', payload: { text: 'hi' } }).kind).toBe('delta');
    expect(streamFrameSchema.parse({ kind: 'usage', usage: {} }).kind).toBe('usage');
    expect(
      streamFrameSchema.parse({ kind: 'done', servedBy: { offeringId: 'o', channelId: 'c' } }).kind,
    ).toBe('done');
    expect(
      streamFrameSchema.parse({
        kind: 'error',
        error: { code: 'upstream_error', message: 'boom', retryable: false, failover: true },
      }).kind,
    ).toBe('error');
  });

  it('rejects an unknown frame kind', () => {
    expect(streamFrameSchema.safeParse({ kind: 'ping' }).success).toBe(false);
  });
});

describe('gatewayErrorSchema', () => {
  it('requires BOTH retryable and failover flags (§6 conformance: every error-table row states them)', () => {
    const base = { code: 'upstream_timeout', message: 't/o' };
    expect(gatewayErrorSchema.safeParse({ ...base, retryable: true }).success).toBe(false);
    expect(gatewayErrorSchema.safeParse({ ...base, failover: true }).success).toBe(false);
    const ok = gatewayErrorSchema.parse({
      ...base,
      retryable: true,
      failover: true,
      retryAfterMs: 2000,
      upstream: { provider: 'volc', rawCode: 'InternalError.Timeout' },
    });
    expect(ok.failover).toBe(true);
  });
});

describe('taskUpdateSchema (§6 aspect ⑥)', () => {
  it('accepts every canonical status incl. platform-side expired', () => {
    for (const status of TASK_STATUSES) {
      const out = taskUpdateSchema.safeParse({ upstreamTaskId: 'u1', status });
      expect(out.success).toBe(true);
    }
  });

  it('keeps the upstream verbatim status for unknown-state alerting', () => {
    const u = taskUpdateSchema.parse({
      upstreamTaskId: 'u1',
      status: 'running',
      rawStatus: 'GENERATING_PHASE_2',
      progress: 42,
    });
    expect(u.rawStatus).toBe('GENERATING_PHASE_2');
  });

  it('bounds progress to 0–100', () => {
    expect(
      taskUpdateSchema.safeParse({ upstreamTaskId: 'u1', status: 'running', progress: 101 })
        .success,
    ).toBe(false);
    expect(
      taskUpdateSchema.safeParse({ upstreamTaskId: 'u1', status: 'running', progress: -1 }).success,
    ).toBe(false);
  });

  it('carries the normalized failure on failed updates', () => {
    const u = taskUpdateSchema.parse({
      upstreamTaskId: 'u1',
      status: 'failed',
      error: { code: 'task_failed', message: 'nsfw', retryable: false, failover: false },
    });
    expect(u.error?.code).toBe('task_failed');
  });
});
