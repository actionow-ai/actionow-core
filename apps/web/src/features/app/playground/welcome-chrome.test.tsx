import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from './welcome-chrome';

describe('Badge', () => {
  it('renders its icon with the accent gradient', () => {
    const { container } = render(<Badge icon={<svg data-testid="i" />} accent />);
    const span = container.querySelector('span') as HTMLElement;
    expect(span.querySelector('[data-testid="i"]')).toBeInTheDocument();
    expect(span).toHaveStyle({ background: 'var(--grad-accent)' });
  });
});
