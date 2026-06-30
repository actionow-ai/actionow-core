import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MetaCell } from './MetaCell';

describe('MetaCell', () => {
  it('renders label + value, nowrap by default', () => {
    render(<MetaCell label="Status" value="active" />);
    expect(screen.getByText('Status')).toBeInTheDocument();
    const value = screen.getByText('active');
    expect(value).toHaveStyle({ whiteSpace: 'nowrap' });
    expect(value.className).toContain('tabular');
  });

  it('allows wrapping when nowrap=false', () => {
    render(<MetaCell label="L" value="v" nowrap={false} />);
    expect(screen.getByText('v')).toHaveStyle({ whiteSpace: 'normal' });
  });
});
