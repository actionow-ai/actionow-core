import { describe, expect, it } from 'vitest';

import {
  addGroupChannelSchema,
  createOfficialPriceSchema,
  createRouteGroupSchema,
  updateOfficialPriceSchema,
  updateRouteGroupSchema,
} from './billing-requests.js';

describe('billing request contracts', () => {
  it('createRouteGroupSchema keeps groupRatioBps as an integer (bps, not a float)', () => {
    const body = { name: 'premium', groupRatioBps: 12000 };
    expect(createRouteGroupSchema.parse(body)).toEqual(body);
    expect(() => createRouteGroupSchema.parse({ name: 'x', groupRatioBps: 1.5 })).toThrow();
  });

  it('createRouteGroupSchema accepts an optional uuid (or null) fallbackGroupId', () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(createRouteGroupSchema.parse({ name: 'g', fallbackGroupId: uuid }).fallbackGroupId).toBe(
      uuid,
    );
    expect(
      createRouteGroupSchema.parse({ name: 'g', fallbackGroupId: null }).fallbackGroupId,
    ).toBeNull();
    expect(createRouteGroupSchema.parse({ name: 'g' }).fallbackGroupId).toBeUndefined();
    // a non-uuid string is rejected.
    expect(() =>
      createRouteGroupSchema.parse({ name: 'g', fallbackGroupId: 'not-a-uuid' }),
    ).toThrow();
  });

  it('updateRouteGroupSchema accepts fallbackGroupId (set or clear with null)', () => {
    const uuid = '22222222-2222-4222-8222-222222222222';
    expect(updateRouteGroupSchema.parse({ fallbackGroupId: uuid }).fallbackGroupId).toBe(uuid);
    expect(updateRouteGroupSchema.parse({ fallbackGroupId: null }).fallbackGroupId).toBeNull();
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
