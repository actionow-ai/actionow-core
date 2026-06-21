import { describe, expect, it } from 'vitest';

import {
  addGroupChannelSchema,
  createOfficialPriceSchema,
  createRouteGroupSchema,
  updateOfficialPriceSchema,
} from './billing-requests.js';

describe('billing request contracts', () => {
  it('createRouteGroupSchema keeps groupRatioBps as an integer (bps, not a float)', () => {
    const body = { name: 'premium', groupRatioBps: 12000 };
    expect(createRouteGroupSchema.parse(body)).toEqual(body);
    expect(() => createRouteGroupSchema.parse({ name: 'x', groupRatioBps: 1.5 })).toThrow();
  });

  it('createOfficialPriceSchema keeps USD/1M as a positive number (not a string)', () => {
    const body = {
      provider: 'openai',
      modelSlug: 'gpt-4o',
      inputUsdPer1m: 2.5,
      outputUsdPer1m: 10,
    };
    expect(createOfficialPriceSchema.parse(body)).toEqual(body);
    // request money is a number — a string must be rejected (guard against drift).
    expect(() => createOfficialPriceSchema.parse({ ...body, inputUsdPer1m: '2.5' })).toThrow();
  });

  it('updateOfficialPriceSchema allows clearing a nullable field with null', () => {
    expect(updateOfficialPriceSchema.parse({ notes: null })).toEqual({ notes: null });
  });

  it('addGroupChannelSchema defaults are all-optional but reject a fractional weight', () => {
    expect(addGroupChannelSchema.parse({})).toEqual({});
    expect(() => addGroupChannelSchema.parse({ weight: 1.5 })).toThrow();
  });
});
