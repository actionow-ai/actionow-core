import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

function defaults() {
  return {
    open: true,
    title: 'Delete channel',
    message: 'This cannot be undone.',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    onConfirm: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('ConfirmDialog', () => {
  it('renders the title, message and both buttons', () => {
    render(<ConfirmDialog {...defaults()} />);
    expect(screen.getByRole('dialog', { name: 'Delete channel' })).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('clicking confirm calls onConfirm; clicking cancel calls onClose', async () => {
    const user = userEvent.setup();
    const props = defaults();
    render(<ConfirmDialog {...props} />);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('danger styles the confirm button with the danger variant', () => {
    render(<ConfirmDialog {...defaults()} danger />);
    const confirm = screen.getByRole('button', { name: 'Delete' });
    // Button styling is class-driven (.btn-danger → fail-tinted fill/border/text).
    expect(confirm.className).toContain('btn-danger');
  });

  it('loading disables the confirm button (aria-busy)', () => {
    render(<ConfirmDialog {...defaults()} loading />);
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
  });
});
