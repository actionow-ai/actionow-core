import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { CAPABILITIES } from '../../lib/api/enums';
import { CapabilitiesField } from './CapabilitiesField';

beforeAll(async () => {
  await i18n.changeLanguage('en');
  // Pin the capability labels so accessible-name queries are deterministic
  // (the app supplies these via console.json).
  i18n.addResourceBundle(
    'en',
    'console',
    {
      enums: {
        capability: {
          tools: 'Tools',
          vision: 'Vision',
          audio: 'Audio',
          json: 'JSON mode',
          stream: 'Streaming',
        },
      },
    },
    true,
    true,
  );
});

function Harness({
  initial = {},
  onChange,
}: {
  initial?: Record<string, boolean>;
  onChange: (v: Record<string, boolean>) => void;
}) {
  const [value, setValue] = useState<Record<string, boolean>>(initial);
  return (
    <CapabilitiesField
      label="Capabilities"
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('CapabilitiesField', () => {
  it('renders a toggle per known capability', () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getAllByRole('switch')).toHaveLength(CAPABILITIES.length);
    expect(screen.getByRole('switch', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Streaming' })).toBeInTheDocument();
  });

  it('toggling a known capability emits the record with that key flipped on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('switch', { name: 'Vision' }));
    expect(onChange).toHaveBeenLastCalledWith({ vision: true });
  });

  it('reflects a known capability that is already on and turns it off', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ tools: true }} onChange={onChange} />);

    expect(screen.getByRole('switch', { name: 'Tools' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('switch', { name: 'Tools' }));
    expect(onChange).toHaveBeenLastCalledWith({ tools: false });
  });

  it('renders an extra (unknown) key as a toggle and preserves it on change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ reasoning: true }} onChange={onChange} />);

    // One extra toggle beyond the known set, named by its raw key.
    expect(screen.getAllByRole('switch')).toHaveLength(CAPABILITIES.length + 1);
    const extra = screen.getByRole('switch', { name: 'reasoning' });
    expect(extra).toHaveAttribute('aria-checked', 'true');

    // Flipping a known cap keeps the extra key intact in the emitted record.
    await user.click(screen.getByRole('switch', { name: 'Tools' }));
    expect(onChange).toHaveBeenLastCalledWith({ reasoning: true, tools: true });
  });
});
