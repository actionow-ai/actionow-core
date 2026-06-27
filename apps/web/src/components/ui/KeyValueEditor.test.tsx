import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { KeyValueEditor } from './KeyValueEditor';
import type { KvRow } from './kvRows';
import { rowsFromObject } from './kvRows';

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

    await user.type(inputs[0]!, 'region');
    await user.type(inputs[1]!, 'us-east');

    // Rows now carry a stable `id` (React key); assert just the wire fields.
    const last = onChange.mock.calls.at(-1)?.[0] as KvRow[] | undefined;
    expect(last?.map((r) => ({ key: r.key, value: r.value }))).toEqual([
      { key: 'region', value: 'us-east' },
    ]);
  });

  it('adds and removes rows', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // The last button is "add row"; the per-row trailing button is "remove".
    const buttons = screen.getAllByRole('button');
    const addRow = buttons[buttons.length - 1]!;
    await user.click(addRow);
    expect(screen.getAllByRole('textbox')).toHaveLength(4);

    // Removing a row drops its two inputs.
    const removeFirst = screen.getAllByRole('button')[0]!;
    await user.click(removeFirst);
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it('preserves the surviving rows DOM nodes when a middle row is removed (stable keys)', async () => {
    const user = userEvent.setup();
    render(<Harness initial={rowsFromObject({ a: '1', b: '2', c: '3' })} />);

    // Row C's key input, before the removal.
    const cBefore = screen.getByDisplayValue('c');
    // Buttons are [removeA, removeB, removeC, addRow]; remove the MIDDLE row (B).
    const buttons = screen.getAllByRole('button');
    await user.click(buttons[1]!);

    // With index keys React reuses node positions and strands the value/focus;
    // with stable per-row ids the surviving node is the SAME element.
    const cAfter = screen.getByDisplayValue('c');
    expect(cAfter).toBe(cBefore);
    // And row B is gone, A and C remain.
    expect(screen.queryByDisplayValue('b')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('a')).toBeInTheDocument();
  });

  it('re-renders new rows when the controlled value changes (regression)', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={rowsFromObject({ region: 'us-east' })}
        swapTo={rowsFromObject({ tier: 'gold', zone: 'b' })}
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
