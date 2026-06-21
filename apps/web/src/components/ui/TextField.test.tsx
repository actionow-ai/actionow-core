import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TextField } from './TextField';

describe('TextField', () => {
  it('forwards minLength/maxLength to the underlying input', () => {
    const { container } = render(
      <TextField
        label="Password"
        type="password"
        value=""
        onChange={() => undefined}
        minLength={8}
        maxLength={256}
      />,
    );
    const input = container.querySelector('input');
    expect(input).toHaveAttribute('minLength', '8');
    expect(input).toHaveAttribute('maxLength', '256');
  });
});
