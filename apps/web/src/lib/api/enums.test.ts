import { describe, expect, it } from 'vitest';

import { enumLabel, MODALITIES, PRICEBOOK_METHODS, toOptions } from './enums';

describe('enums', () => {
  it('MODALITIES values match the Modality union', () => {
    expect(MODALITIES.map((o) => o.value)).toEqual([
      'text',
      'image',
      'video',
      'audio',
      'composite',
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
