// dialectPackSchema: a valid pack parses; missing operations / bad scheme / bad
// fetchMode / a body template on a non-json body are rejected; a PARTIAL
// statusMap is allowed (unknown upstream states fall through to unknownStatus).
import { describe, expect, it } from 'vitest';

import { dialectPackSchema } from '../../src/index.js';

function validPack(): unknown {
  return {
    ref: 'acme',
    version: '1.0.0',
    auth: { scheme: 'bearer' },
    errorTable: {
      rows: [{ match: { httpStatus: 429 }, code: 'rate_limited', retryable: true, failover: true }],
      fallback: { code: 'upstream_error', retryable: false, failover: true },
    },
    operations: {
      'chat.completions': {
        fetchModes: ['direct'],
        request: { path: '/v1/chat', body: { upstream_model_name: '$.model' } },
        response: { output: '$.choices' },
      },
    },
  };
}

describe('dialectPackSchema', () => {
  it('accepts a well-formed pack and defaults optional collections', () => {
    const parsed = dialectPackSchema.parse(validPack());
    expect(parsed.ref).toBe('acme');
    const op = parsed.operations['chat.completions'];
    expect(op?.request.method).toBeUndefined(); // resolved to POST at compile time
    expect(parsed.errorTable.rows).toHaveLength(1);
  });

  it('rejects a pack with no operations', () => {
    const pack = validPack() as Record<string, unknown>;
    pack.operations = {};
    expect(() => dialectPackSchema.parse(pack)).toThrow(/at least one operation/);
  });

  it('rejects an unknown auth scheme', () => {
    const pack = validPack() as Record<string, unknown>;
    pack.auth = { scheme: 'basic' };
    expect(() => dialectPackSchema.parse(pack)).toThrow();
  });

  it('rejects an unknown fetch mode', () => {
    const pack = validPack() as { operations: Record<string, { fetchModes: string[] }> };
    const op = pack.operations['chat.completions'];
    if (op !== undefined) op.fetchModes = ['polling'];
    expect(() => dialectPackSchema.parse(pack)).toThrow();
  });

  it('rejects an unknown operation key', () => {
    const pack = validPack() as { operations: Record<string, unknown> };
    pack.operations = { 'chat.stream': pack.operations['chat.completions'] };
    expect(() => dialectPackSchema.parse(pack)).toThrow();
  });

  it('rejects a body field-placement template on a non-json body', () => {
    const pack = validPack() as {
      operations: Record<string, { request: { bodyKind?: string; body?: unknown } }>;
    };
    const op = pack.operations['chat.completions'];
    if (op !== undefined) op.request.bodyKind = 'none';
    expect(() => dialectPackSchema.parse(pack)).toThrow(/requires bodyKind/);
  });

  it('allows a PARTIAL task statusMap (unknown states handled at runtime, not parse)', () => {
    const pack = validPack() as {
      operations: Record<string, Record<string, unknown>>;
    };
    const op = pack.operations['chat.completions'];
    if (op !== undefined) {
      op.fetchModes = ['submit_poll'];
      op.task = {
        submit: { response: { taskIdPath: '$.id' } },
        query: {
          request: { path: '/v1/tasks/{task_id}' },
          taskIdPath: '$.id',
          statusPath: '$.state',
          statusMap: { done: 'succeeded' }, // only ONE upstream state mapped
          unknownStatus: 'running',
        },
      };
    }
    const parsed = dialectPackSchema.parse(pack);
    const taskOp = parsed.operations['chat.completions'];
    expect(taskOp?.task?.query.statusMap).toEqual({ done: 'succeeded' });
  });
});
