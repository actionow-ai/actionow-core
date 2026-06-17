import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Toggle } from './Toggle';

describe('Toggle', () => {
  it('exposes role=switch with aria-checked reflecting state', () => {
    render(<Toggle checked label="Notifications" onChange={() => undefined} />);
    const sw = screen.getByRole('switch', { name: 'Notifications' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles on click and emits onChange(boolean)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked label="Notifications" onChange={onChange} />);
    await user.click(screen.getByRole('switch', { name: 'Notifications' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('toggles on Space when focused', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} label="Notifications" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('switch', { name: 'Notifications' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Toggle checked={false} label="Notifications" onChange={onChange} disabled />);
    await user.click(screen.getByRole('switch', { name: 'Notifications' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
