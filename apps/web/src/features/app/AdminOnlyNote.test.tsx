import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminOnlyNote } from './AdminOnlyNote';

describe('AdminOnlyNote', () => {
  it('renders a custom message in the page variant (centered note)', () => {
    render(<AdminOnlyNote variant="page" message="admins only" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('admins only');
    expect(note).toHaveStyle({ textAlign: 'center' });
  });

  it('defaults to the banner variant', () => {
    render(<AdminOnlyNote message="admins only" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('admins only');
    expect(note).not.toHaveStyle({ textAlign: 'center' });
  });
});
