import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { KeyValueEditor } from './KeyValueEditor';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

function Harness({ onChange }: { onChange: (o: Record<string, string>) => void }) {
  const [value] = useState<Record<string, string>>({});
  return <KeyValueEditor label="Config" value={value} onChange={onChange} />;
}

describe('KeyValueEditor', () => {
  it('typing a key and value emits the record', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const inputs = screen.getAllByRole('textbox');
    // one blank row → key input + value input
    expect(inputs).toHaveLength(2);

    await user.type(inputs[0], 'region');
    await user.type(inputs[1], 'us-east');

    expect(onChange).toHaveBeenLastCalledWith({ region: 'us-east' });
  });

  it('adds and removes rows', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

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
});
