import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { useFocusTrap } from './useFocusTrap';

function Trap({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref}>
      <button>first</button>
      <button>middle</button>
      <button>last</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>open</button>
      {open && <Trap active />}
      {open && (
        <button onClick={() => setOpen(false)} type="button">
          close
        </button>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable inside on activation', () => {
    render(<Trap active />);
    expect(screen.getByText('first')).toHaveFocus();
  });

  it('wraps focus from the last element back to the first on Tab', async () => {
    const user = userEvent.setup();
    render(<Trap active />);
    screen.getByText('last').focus();
    await user.tab();
    expect(screen.getByText('first')).toHaveFocus();
  });

  it('wraps focus from the first element to the last on Shift+Tab', async () => {
    const user = userEvent.setup();
    render(<Trap active />);
    screen.getByText('first').focus();
    await user.tab({ shift: true });
    expect(screen.getByText('last')).toHaveFocus();
  });

  it('restores focus to the previously focused element when the trap unmounts', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByText('open');
    opener.focus();
    await user.click(opener);
    // trap took focus
    expect(screen.getByText('first')).toHaveFocus();
    await user.click(screen.getByText('close'));
    // focus returns to the trigger
    expect(opener).toHaveFocus();
  });

  it('does nothing when inactive', () => {
    render(
      <>
        <button>outside</button>
        <Trap active={false} />
      </>,
    );
    expect(screen.getByText('first')).not.toHaveFocus();
  });
});
