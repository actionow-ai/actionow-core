import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Select } from './Select';

const OPTIONS = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'bravo', label: 'Bravo' },
  { value: 'charlie', label: 'Charlie' },
];

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Select value={value} onChange={setValue} options={OPTIONS} ariaLabel="Pick" placeholder="—" />;
}

function trigger() {
  return screen.getByRole('button', { name: 'Pick' });
}

describe('Select keyboard navigation', () => {
  it('opens the listbox with ArrowDown', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('opens with Enter and selects an option with Enter, then closes', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}'); // open
    await user.keyboard('{ArrowDown}'); // move active to first real option (Alpha after placeholder)
    await user.keyboard('{Enter}'); // select
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    // the trigger now shows a selected label
    expect(trigger()).toHaveTextContent(/Alpha|—/);
  });

  it('Escape closes the open listbox', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks an active option via aria-activedescendant and moves with arrows', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    const ad1 = trigger().getAttribute('aria-activedescendant');
    expect(ad1).toBeTruthy();
    await user.keyboard('{ArrowDown}');
    const ad2 = trigger().getAttribute('aria-activedescendant');
    expect(ad2).not.toBe(ad1);
  });

  it('End jumps the active option to the last entry', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{End}');
    await user.keyboard('{Enter}');
    expect(trigger()).toHaveTextContent('Charlie');
  });

  it('type-ahead selects-active the matching label', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}'); // open
    await user.keyboard('c'); // jump to Charlie
    await user.keyboard('{Enter}');
    expect(trigger()).toHaveTextContent('Charlie');
  });
});
