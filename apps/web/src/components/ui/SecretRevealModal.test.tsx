import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SecretRevealModal } from './SecretRevealModal';

const base = {
  open: true,
  title: 'Your key',
  onClose: vi.fn(),
  warn: 'copy it now',
  copyLabel: 'copy',
  copiedLabel: 'copied',
  doneLabel: 'done',
};

describe('SecretRevealModal', () => {
  it('renders the warning + a string value', () => {
    render(<SecretRevealModal {...base} value="sk-abc" />);
    expect(screen.getByText('copy it now')).toBeInTheDocument();
    expect(screen.getByText('sk-abc')).toBeInTheDocument();
  });

  it('joins an array value with newlines', () => {
    render(<SecretRevealModal {...base} value={['a', 'b']} />);
    const matches = screen.getAllByText((_, el) => el?.textContent === 'a\nb');
    expect(matches.length).toBeGreaterThan(0);
  });
});
