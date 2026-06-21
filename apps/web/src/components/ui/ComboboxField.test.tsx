import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ComboboxField } from './ComboboxField';

const OPTIONS = ['openai', 'anthropic', 'gemini'];

function Harness({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ComboboxField
      label="Provider"
      value={value}
      options={OPTIONS}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

function input() {
  return screen.getByRole('combobox', { name: 'Provider' });
}

describe('ComboboxField', () => {
  it('opens the listbox of all options on focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(input());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'openai' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'gemini' })).toBeInTheDocument();
  });

  it('filters options by case-insensitive substring as you type', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'an');
    // "anthropic" matches; "gemini" does not (substring "an" absent).
    expect(screen.getByRole('option', { name: 'anthropic' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'gemini' })).not.toBeInTheDocument();
  });

  it('clicking an option commits it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(input());
    await user.click(screen.getByRole('option', { name: 'anthropic' }));
    expect(onChange).toHaveBeenLastCalledWith('anthropic');
    expect(input()).toHaveValue('anthropic');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('typing a non-option value emits the free text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'custom-provider');
    expect(onChange).toHaveBeenLastCalledWith('custom-provider');
    expect(input()).toHaveValue('custom-provider');
  });

  it('ArrowDown highlights an option and Enter commits the highlight', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(input());
    await user.keyboard('{ArrowDown}'); // highlight first (openai)
    await user.keyboard('{ArrowDown}'); // highlight second (anthropic)
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('anthropic');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Enter with no highlight commits the typed free text', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'azure-cn');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('azure-cn');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Escape closes the listbox without losing the typed value', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'ai'); // matches "openai"
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input()).toHaveValue('ai');
  });

  it('exposes combobox a11y wiring (aria-expanded toggles)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    await user.click(input());
    expect(input()).toHaveAttribute('aria-expanded', 'true');
  });
});
