import { describe, expect, it } from 'vitest';

import { MODALITIES, PRICEBOOK_METHODS, toOptions } from './enums';

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
