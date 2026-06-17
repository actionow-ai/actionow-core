import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { Modal } from './Modal';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>trigger</button>
      <Modal open={open} title="Dialog" onClose={() => setOpen(false)} footer={<button>save</button>}>
        <input aria-label="name" />
      </Modal>
    </div>
  );
}

describe('Modal focus trap', () => {
  it('traps focus inside and restores it to the trigger on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    await user.click(trigger);

    // focus moved inside the dialog
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    // Escape closes: focus returns to the trigger immediately, and the dialog
    // unmounts once the exit animation completes (deferred-unmount lifecycle).
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

/** Drives `open` from the outside so a test can flip it faster than any animation. */
function ControlledHarness({ open }: { open: boolean }) {
  return (
    <Modal open={open} title="Dialog" onClose={() => {}} footer={<button>save</button>}>
      <input aria-label="name" />
    </Modal>
  );
}

describe('Modal rapid reopen race', () => {
  it('stays mounted when reopened within the exit-animation window', async () => {
    // open
    const { rerender } = render(<ControlledHarness open />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // close → builds the exit timeline (its onComplete would unmount)…
    rerender(<ControlledHarness open={false} />);
    // …then reopen before the exit (DUR.fast = 180ms) completes.
    rerender(<ControlledHarness open />);

    // The stale exit-complete must NOT unmount the just-reopened dialog. Give
    // the exit timeline well past its duration to have fired its onComplete.
    await new Promise((r) => setTimeout(r, 350));

    expect(screen.queryByRole('dialog')).toBeInTheDocument();
  });
});
