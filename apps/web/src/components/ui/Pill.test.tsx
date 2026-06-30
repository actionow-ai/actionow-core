import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Pill } from './Pill';

describe('Pill neutral tone', () => {
  it('renders a neutral chip in the muted colour', () => {
    render(<Pill tone="neutral">canary</Pill>);
    const el = screen.getByText('canary');
    expect(el).toHaveStyle({ color: 'var(--muted)' });
  });
});
