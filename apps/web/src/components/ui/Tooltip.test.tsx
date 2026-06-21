import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Tooltip } from './Tooltip';

describe('Tooltip', () => {
  it('renders an accessible trigger and a role=tooltip linked via aria-describedby', () => {
    render(<Tooltip text="rate in micro-credits" />);
    const trigger = screen.getByRole('button', { name: 'rate in micro-credits' });
    // The bubble is always in the DOM (visually hidden until open) so screen
    // readers can announce it via aria-describedby.
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip).toHaveTextContent('rate in micro-credits');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
  });

  it('reveals the tooltip on hover and hides it on unhover', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="hint text" />);
    const trigger = screen.getByRole('button', { name: 'hint text' });
    const tip = screen.getByRole('tooltip', { hidden: true });

    expect(tip).toHaveAttribute('data-open', 'false');
    await user.hover(trigger);
    expect(tip).toHaveAttribute('data-open', 'true');
    await user.unhover(trigger);
    expect(tip).toHaveAttribute('data-open', 'false');
  });

  it('reveals the tooltip on focus and hides it on blur', async () => {
    const user = userEvent.setup();
    render(<Tooltip text="focus hint" />);
    const trigger = screen.getByRole('button', { name: 'focus hint' });
    const tip = screen.getByRole('tooltip', { hidden: true });

    await user.tab();
    expect(trigger).toHaveFocus();
    expect(tip).toHaveAttribute('data-open', 'true');
    await user.tab();
    expect(tip).toHaveAttribute('data-open', 'false');
  });
});
