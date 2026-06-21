import { GearIcon } from '@phosphor-icons/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('exposes an accessible name from label', () => {
    render(<IconButton icon={GearIcon} label="Settings" />);
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton icon={GearIcon} label="Settings" onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('marks the active state and aria-current', () => {
    render(<IconButton icon={GearIcon} label="Settings" active current />);
    const btn = screen.getByRole('button', { name: 'Settings' });
    expect(btn.className).toContain('is-active');
    expect(btn).toHaveAttribute('aria-current', 'page');
  });

  it('renders a tooltip element when requested', () => {
    const { container } = render(<IconButton icon={GearIcon} label="Settings" tooltip />);
    expect(container.querySelector('.ico-tip')).toHaveTextContent('Settings');
  });
});
