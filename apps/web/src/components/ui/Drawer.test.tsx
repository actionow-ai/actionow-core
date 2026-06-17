import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { Drawer } from './Drawer';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)}>trigger</button>
      <Drawer open={open} title="Edit channel" onClose={() => setOpen(false)} footer={<button>save</button>}>
        <input aria-label="endpoint" />
      </Drawer>
    </div>
  );
}

describe('Drawer', () => {
  it('opens a dialog named by its title with its children and traps focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Edit channel' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('endpoint')).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('Escape calls onClose and unmounts after the exit', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
