import { describe, expect, it } from 'vitest';

import { ioSchemaSchema } from '../src/io-schema.js';
import { JOB_STATUSES, jobStatusSchema } from '../src/job.js';
import { modifierSchema } from '../src/modifier.js';
import { pricebookEntrySchema } from '../src/pricing.js';

describe('io-schema', () => {
  it('accepts a valid io_schema', () => {
    const parsed = ioSchemaSchema.parse({
      inputs: [{ key: 'prompt', type: 'string', required: true, maxLength: 100 }],
      outputs: [{ key: 'video_url', type: 'string', render: 'video' }],
    });
    expect(parsed.inputs[0]?.key).toBe('prompt');
  });
  it('rejects an unknown field type', () => {
    expect(() =>
      ioSchemaSchema.parse({ inputs: [{ key: 'x', type: 'blob' }], outputs: [] }),
    ).toThrow();
  });
});

describe('pricing', () => {
  it('accepts a unit (post) pricebook entry', () => {
    const e = pricebookEntrySchema.parse({
      resourceId: 'model:openai/gpt',
      resourceVersion: 1,
      version: 7,
      method: 'unit',
      timing: 'post',
      spec: {
        method: 'unit',
        dimensions: { input_tokens: { rate: 150 }, output_tokens: { rate: 600 } },
      },
    });
    expect(e.method).toBe('unit');
  });
  it('accepts a matrix (pre) entry with multiplier', () => {
    const e = pricebookEntrySchema.parse({
      resourceId: 'model:kling/v2',
      resourceVersion: 1,
      version: 1,
      method: 'matrix',
      timing: 'pre',
      spec: {
        method: 'matrix',
        key: ['resolution'],
        table: { '720p': 1200000, '1080p': 2500000 },
        multiplier: 'duration_seconds',
      },
    });
    expect(e.spec.method).toBe('matrix');
  });
  it('rejects a method/spec mismatch', () => {
    expect(() =>
      pricebookEntrySchema.parse({
        resourceId: 'r',
        resourceVersion: 1,
        version: 1,
        method: 'fixed',
        timing: 'pre',
        spec: { method: 'unit', dimensions: {} },
      }),
    ).toThrow();
  });
});

describe('modifier + job', () => {
  it('accepts a percent_off modifier', () => {
    const m = modifierSchema.parse({
      id: 'volume',
      scope: 'tenant:acme',
      op: 'percent_off',
      value: 10,
      stackable: true,
      priority: 1,
      version: 1,
    });
    expect(m.op).toBe('percent_off');
  });
  it('exposes the 5 job statuses', () => {
    expect(JOB_STATUSES).toEqual(['queued', 'running', 'succeeded', 'failed', 'canceled']);
    expect(jobStatusSchema.parse('running')).toBe('running');
  });
});
