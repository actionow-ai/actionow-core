import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge, statusTone } from './StatusBadge';

describe('statusTone', () => {
  it('maps known statuses to their palette tone', () => {
    expect(statusTone('succeeded')).toBe('ok');
    expect(statusTone('active')).toBe('ok');
    expect(statusTone('running')).toBe('run');
    expect(statusTone('queued')).toBe('wait');
    expect(statusTone('failed')).toBe('fail');
    expect(statusTone('inactive')).toBe('fail');
    expect(statusTone('canceled')).toBe('idle');
  });

  it('falls back to idle for unknown statuses', () => {
    expect(statusTone('something-new')).toBe('idle');
  });
});

describe('StatusBadge', () => {
  it('renders the provided (already translated) label, not a raw enum', () => {
    render(<StatusBadge tone="ok" label="Active" />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
