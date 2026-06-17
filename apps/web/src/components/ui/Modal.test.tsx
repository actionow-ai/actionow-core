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
