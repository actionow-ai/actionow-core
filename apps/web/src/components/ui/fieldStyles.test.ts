import { describe, expect, test } from 'vitest';

import { FIELD_INPUT_BASE } from './fieldStyles';

describe('FIELD_INPUT_BASE', () => {
  test('is full-width so the input fills its form column', () => {
    expect(FIELD_INPUT_BASE.width).toBe('100%');
  });

  test('delegates surface, border and error ring to the .field class (no inline border/background)', () => {
    expect(FIELD_INPUT_BASE).not.toHaveProperty('borderColor');
    expect(FIELD_INPUT_BASE).not.toHaveProperty('background');
  });
});
