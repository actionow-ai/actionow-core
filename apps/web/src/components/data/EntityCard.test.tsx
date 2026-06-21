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

  it('does not promote itself to a button when it renders interactive actions (valid ARIA)', async () => {
    const user = userEvent.setup();
    const cardClick = vi.fn();
    const actionClick = vi.fn();
    render(
      <EntityCard
        title="Resource A"
        onClick={cardClick}
        actions={
          <button type="button" onClick={actionClick}>
            act
          </button>
        }
      />,
    );
    // The card itself must NOT be role=button — it can't legally nest the action button.
    expect(screen.queryByRole('button', { name: /Resource A/ })).not.toBeInTheDocument();
    // The action fires without also triggering the card's onClick (no double activation).
    await user.click(screen.getByRole('button', { name: 'act' }));
    expect(actionClick).toHaveBeenCalledTimes(1);
    expect(cardClick).not.toHaveBeenCalled();
  });
});
