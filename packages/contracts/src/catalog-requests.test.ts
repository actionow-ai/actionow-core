import { describe, expect, it } from 'vitest';

import {
  createChannelSchema,
  createModelSchema,
  createResourceSchema,
  updateModelSchema,
} from './catalog-requests.js';

describe('catalog request contracts', () => {
  it('createResourceSchema accepts a valid body and rejects an empty execModes', () => {
    const body = {
      id: 'gpt-4o',
      tenantId: '11111111-1111-1111-1111-111111111111',
      kind: 'model' as const,
      modality: 'text' as const,
      providerType: 'openai',
      execModes: ['sync'],
      ioSchema: {},
    };
    expect(createResourceSchema.parse(body)).toEqual(body);
    expect(() => createResourceSchema.parse({ ...body, execModes: [] })).toThrow();
  });

  it('createChannelSchema keeps operator cost as a HUMAN-USD number (not a string)', () => {
    const body = { providerType: 'openai', inputCostUsdPer1m: 0.5 };
    expect(createChannelSchema.parse(body)).toEqual(body);
    // request money is a number — a string must be rejected (guard against drift).
    expect(() =>
      createChannelSchema.parse({ providerType: 'openai', inputCostUsdPer1m: '0.5' }),
    ).toThrow();
  });

  it('createModelSchema requires name + resourceId and rejects a non-integer price', () => {
    const body = { name: 'gpt-4o', resourceId: 'gpt-4o' };
    expect(createModelSchema.parse(body)).toEqual(body);
    expect(() =>
      createModelSchema.parse({ name: 'x', resourceId: 'r', inputPrice: 1.5 }),
    ).toThrow();
  });

  it('updateModelSchema accepts a null display (clear) and is otherwise all-optional', () => {
    expect(updateModelSchema.parse({ display: null })).toEqual({ display: null });
    expect(updateModelSchema.parse({})).toEqual({});
  });
});
