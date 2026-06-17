import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('exposes role=checkbox with aria-checked reflecting state', () => {
    render(<Checkbox checked label="Accept" onChange={() => undefined} />);
    const box = screen.getByRole('checkbox', { name: 'Accept' });
    expect(box).toHaveAttribute('aria-checked', 'true');
  });

  it('toggles on click and emits onChange(boolean)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} label="Accept" onChange={onChange} />);
    await user.click(screen.getByRole('checkbox', { name: 'Accept' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('toggles on Space when focused', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} label="Accept" onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('checkbox', { name: 'Accept' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not toggle when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox checked={false} label="Accept" onChange={onChange} disabled />);
    await user.click(screen.getByRole('checkbox', { name: 'Accept' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports aria-checked="mixed" when indeterminate', () => {
    render(<Checkbox checked={false} label="Accept" onChange={() => undefined} indeterminate />);
    expect(screen.getByRole('checkbox', { name: 'Accept' })).toHaveAttribute('aria-checked', 'mixed');
  });
});
