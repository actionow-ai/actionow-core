import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('copies the value and shows the copied label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value="sk-123" label="copy" copiedLabel="copied" />);
    fireEvent.click(screen.getByRole('button'));
    expect(writeText).toHaveBeenCalledWith('sk-123');
    await waitFor(() => expect(screen.getByLabelText('copied')).toBeInTheDocument());
  });

  it('shows the failed label when the clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton value="x" label="copy" failedLabel="failed" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByLabelText('failed')).toBeInTheDocument());
  });
});
