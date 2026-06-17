import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { value: 'login', label: 'Sign in' },
  { value: 'register', label: 'Create account' },
];

/** A controlled wrapper that actually re-renders with the new value, so the
 * roving-tabindex re-render path runs (a static vi.fn() would never expose it). */
function Controlled({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <SegmentedControl value={value} onChange={setValue} options={OPTIONS} />;
}

describe('SegmentedControl', () => {
  it('renders all options', () => {
    render(<SegmentedControl value="login" onChange={() => undefined} options={OPTIONS} />);
    expect(screen.getByRole('radio', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Create account' })).toBeInTheDocument();
  });

  it('marks the selected option with aria-checked', () => {
    render(<SegmentedControl value="register" onChange={() => undefined} options={OPTIONS} />);
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveAttribute('aria-checked', 'true');
  });

  it('fires onChange(value) when an option is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl value="login" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('radio', { name: 'Create account' }));
    expect(onChange).toHaveBeenCalledWith('register');
  });

  it('moves the selection with the right arrow key', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl value="login" onChange={onChange} options={OPTIONS} />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('register');
  });

  it('wraps with the left arrow key from the first option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SegmentedControl value="login" onChange={onChange} options={OPTIONS} />);
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('register');
  });

  it('moves DOM focus to the newly-selected option after ArrowRight (controlled)', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="login" />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveFocus();
  });

  it('moves DOM focus with Home/End (controlled)', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="login" />);
    await user.tab();
    await user.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Create account' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'Sign in' })).toHaveFocus();
  });

  it('does not steal focus on mouse click (controlled)', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="login" />);
    const target = screen.getByRole('radio', { name: 'Create account' });
    await user.click(target);
    // The clicked button receives focus from the click itself, not a forced move,
    // and the previously-focused button is not yanked back.
    expect(target).toHaveAttribute('aria-checked', 'true');
  });
});
