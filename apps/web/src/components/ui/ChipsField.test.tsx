import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { ChipsField } from './ChipsField';

beforeAll(async () => {
  await i18n.changeLanguage('en');
  // Provide the forms.* keys these chips rely on (the app supplies them via
  // console.json; here we pin them so accessible-name queries are deterministic).
  i18n.addResourceBundle(
    'en',
    'console',
    {
      forms: {
        removeChip: 'Remove {{value}}',
        addChip: 'Add {{value}}',
        chipsPlaceholder: 'Type and press Enter',
      },
    },
    true,
    true,
  );
});

function Harness({
  initial = [],
  suggestions,
  onChange,
}: {
  initial?: string[];
  suggestions?: string[];
  onChange: (v: string[]) => void;
}) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <ChipsField
      label="Exec modes"
      value={value}
      suggestions={suggestions}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('ChipsField', () => {
  it('renders existing chips', () => {
    render(<Harness initial={['blocking', 'stream']} onChange={() => {}} />);
    expect(screen.getByText('blocking')).toBeInTheDocument();
    expect(screen.getByText('stream')).toBeInTheDocument();
  });

  it('typing a value + Enter adds a chip, clears input, and emits the new list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={['blocking']} onChange={onChange} />);
    const input = screen.getByRole('textbox');

    await user.type(input, 'stream{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['blocking', 'stream']);
    expect(input).toHaveValue('');
  });

  it('ignores duplicates', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={['blocking']} onChange={onChange} />);
    const input = screen.getByRole('textbox');

    await user.type(input, 'blocking{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('removing a chip emits the list without it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={['blocking', 'stream']} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /blocking/i }));
    expect(onChange).toHaveBeenLastCalledWith(['stream']);
  });

  it('clicking a suggestion adds it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={[]} suggestions={['blocking', 'stream']} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /add blocking/i }));
    expect(onChange).toHaveBeenLastCalledWith(['blocking']);
  });
});
