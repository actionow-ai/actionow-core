import { describe, expect, test } from 'vitest';

import { fieldInputStyle } from './fieldStyles';

describe('fieldInputStyle', () => {
  test('is full-width so the input fills its form column', () => {
    expect(fieldInputStyle().width).toBe('100%');
  });

  test('paints a red border when there is an error', () => {
    expect(fieldInputStyle('bad value').borderColor).toBe('var(--fail)');
  });

  test('has no error border when valid', () => {
    expect(fieldInputStyle()).not.toHaveProperty('borderColor');
  });
});
