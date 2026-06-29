import { describe, expect, it } from 'vitest';

import {
  enumLabel,
  MODALITIES,
  MODIFIER_CREDIT_OPS,
  MODIFIER_OPS,
  PRICEBOOK_METHODS,
  toOptions,
} from './enums';

describe('enums', () => {
  it('MODALITIES values match the Modality union', () => {
    expect(MODALITIES.map((o) => o.value)).toEqual([
      'text',
      'image',
      'video',
      'audio',
      'composite',
      'embedding',
      'rerank',
      'moderation',
    ]);
  });

  it('toOptions maps each labelKey through t', () => {
    expect(toOptions(PRICEBOOK_METHODS, (k) => 'T:' + k)[0]).toEqual({
      value: 'unit',
      label: 'T:enums.method.unit',
    });
  });
});

describe('enumLabel', () => {
  it('resolves a known value through its labelKey', () => {
    expect(enumLabel((k) => 'T:' + k, MODALITIES, 'image')).toBe('T:enums.modality.image');
  });

  it('falls back to the raw value for an unknown (open-ended) value', () => {
    expect(enumLabel((k) => 'T:' + k, MODALITIES, 'hologram')).toBe('hologram');
  });
});

describe('modifier ops', () => {
  it('classifies only flat_off/override_rate as µcredit-denominated (the rest are percent)', () => {
    expect(MODIFIER_CREDIT_OPS.has('flat_off')).toBe(true);
    expect(MODIFIER_CREDIT_OPS.has('override_rate')).toBe(true);
    expect(MODIFIER_CREDIT_OPS.has('percent_off')).toBe(false);
    expect(MODIFIER_CREDIT_OPS.has('percent_add')).toBe(false);
  });

  it('labels every op via enumLabel', () => {
    expect(MODIFIER_OPS.map((o) => o.value)).toEqual([
      'override_rate',
      'percent_off',
      'flat_off',
      'percent_add',
    ]);
    expect(enumLabel((k) => 'T:' + k, MODIFIER_OPS, 'flat_off')).toBe(
      'T:enums.modifierOp.flat_off',
    );
  });
});
