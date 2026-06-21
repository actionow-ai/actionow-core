import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CopyField } from './CopyField';

function setClipboard(writeText: (v: string) => Promise<void>) {
  Object.assign(navigator, { clipboard: { writeText } });
}

describe('CopyField', () => {
  it('copies the value and shows the copied label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<CopyField value="ak_secret" copyLabel="Copy" copiedLabel="Copied" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('ak_secret');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('does not throw and shows a failed state when the clipboard write is denied', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    render(<CopyField value="x" copyLabel="Copy" copiedLabel="Copied" failedLabel="Copy failed" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('exposes a polite live region announcing the copy status', () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const { container } = render(<CopyField value="x" copyLabel="Copy" copiedLabel="Copied" />);
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
  });
});
