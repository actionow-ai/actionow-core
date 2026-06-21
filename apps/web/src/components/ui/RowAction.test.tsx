import { TrashIcon } from '@phosphor-icons/react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RowAction } from './RowAction';

describe('RowAction', () => {
  it('exposes the label on both aria-label and title', () => {
    render(<RowAction icon={TrashIcon} label="Delete" onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toHaveAttribute('title', 'Delete');
  });

  it('fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<RowAction icon={TrashIcon} label="Delete" onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('marks the danger variant', () => {
    render(<RowAction icon={TrashIcon} label="Delete" danger onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('data-danger');
  });

  it('disables and skips onClick while loading', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<RowAction icon={TrashIcon} label="Delete" loading onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
