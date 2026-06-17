import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { KeyValueEditor } from './KeyValueEditor';
import type { KvRow } from './kvRows';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function Harness({
  initial = [],
  swapTo,
  onChange,
}: {
  initial?: KvRow[];
  swapTo?: KvRow[];
  onChange?: (rows: KvRow[]) => void;
}) {
  const [rows, setRows] = useState<KvRow[]>(initial);
  return (
    <>
      <KeyValueEditor
        label="Config"
        value={rows}
        onChange={(next) => {
          setRows(next);
          onChange?.(next);
        }}
      />
      {swapTo !== undefined && (
        <button type="button" onClick={() => setRows(swapTo)}>
          swap
        </button>
      )}
    </>
  );
}

describe('KeyValueEditor', () => {
  it('typing a key and value emits the updated rows', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const inputs = screen.getAllByRole('textbox');
    // empty value still renders one blank row → key input + value input
    expect(inputs).toHaveLength(2);

    await user.type(inputs[0], 'region');
    await user.type(inputs[1], 'us-east');

    expect(onChange).toHaveBeenLastCalledWith([{ key: 'region', value: 'us-east' }]);
  });

  it('adds and removes rows', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // The last button is "add row"; the per-row trailing button is "remove".
    const buttons = screen.getAllByRole('button');
    const addRow = buttons[buttons.length - 1];
    await user.click(addRow);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);

    // Removing a row drops its two inputs.
    const removeFirst = screen.getAllByRole('button')[0];
    await user.click(removeFirst);
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('re-renders new rows when the controlled value changes (regression)', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={[{ key: 'region', value: 'us-east' }]}
        swapTo={[
          { key: 'tier', value: 'gold' },
          { key: 'zone', value: 'b' },
        ]}
      />,
    );

    // Seeded from the first entity.
    expect(screen.getByDisplayValue('region')).toBeInTheDocument();
    expect(screen.getByDisplayValue('us-east')).toBeInTheDocument();

    // Parent swaps the value to a different entity's rows.
    await user.click(screen.getByRole('button', { name: 'swap' }));

    expect(screen.getByDisplayValue('tier')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gold')).toBeInTheDocument();
    expect(screen.getByDisplayValue('zone')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('region')).not.toBeInTheDocument();
  });
});
