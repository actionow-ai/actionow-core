import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EntityCard } from './EntityCard';

describe('EntityCard keyboard operability', () => {
  it('is a focusable button when clickable', () => {
    render(<EntityCard title="Resource A" onClick={() => undefined} />);
    const card = screen.getByRole('button', { name: /Resource A/ });
    expect(card).toHaveAttribute('tabindex', '0');
  });

  it('triggers onClick on Enter and Space', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<EntityCard title="Resource A" onClick={onClick} />);
    await user.tab();
    expect(screen.getByRole('button', { name: /Resource A/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is not a button and not focusable when not clickable', () => {
    render(<EntityCard title="Resource A" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
