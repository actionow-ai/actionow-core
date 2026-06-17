import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { IoSchemaField } from './IoSchemaField';
import type { IoField } from './ioSchemaShape';

beforeAll(async () => {
  await i18n.changeLanguage('en');
  i18n.addResourceBundle(
    'en',
    'console',
    {
      forms: {
        addField: 'Add field',
        removeField: 'Remove field',
        io: {
          inputs: 'Inputs',
          outputs: 'Outputs',
          inputsHint: 'request params',
          outputsHint: 'response fields',
          key: 'Key',
          keyHint: 'machine name',
          keyPlaceholder: 'key',
          typeLabel: 'Type',
          typeHint: 'value type',
          required: 'Required',
          fieldLabel: 'Label',
          fieldLabelHint: 'human label',
          maxLength: 'Max length',
          maxLengthHint: 'cap',
          options: 'Options',
          optionsHint: 'enum values',
          type_string: 'String',
          type_number: 'Number',
          type_boolean: 'Boolean',
          type_enum: 'Enum',
          type_file: 'File',
          type_file_list: 'File list',
        },
      },
    },
    true,
    true,
  );
});

interface IoSchemaValue {
  inputs: IoField[];
  outputs: IoField[];
}

function Harness({
  initial = {
    inputs: [{ key: 'prompt', type: 'string', required: true }],
    outputs: [{ key: 'text', type: 'string' }],
  },
  swapTo,
  onChange,
}: {
  initial?: IoSchemaValue;
  swapTo?: IoSchemaValue;
  onChange?: (v: IoSchemaValue) => void;
}) {
  const [value, setValue] = useState<IoSchemaValue>(initial);
  return (
    <>
      <IoSchemaField
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
      />
      {swapTo !== undefined && (
        <button type="button" onClick={() => setValue(swapTo)}>
          swap
        </button>
      )}
    </>
  );
}

describe('IoSchemaField', () => {
  it('renders the inputs/outputs sections seeded from value', () => {
    render(<Harness />);
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Outputs')).toBeInTheDocument();
    expect(screen.getByDisplayValue('prompt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('text')).toBeInTheDocument();
  });

  it('typing a new key emits the updated raw field arrays', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const promptKey = screen.getByDisplayValue('prompt');
    await user.type(promptKey, '2');

    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last.inputs[0].key).toBe('prompt2');
    // raw (uncleaned) arrays — the untouched output row passes straight through
    expect(last.outputs[0]).toEqual({ key: 'text', type: 'string' });
  });

  it('adds a field row when "add field" is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const addButtons = screen.getAllByRole('button', { name: 'Add field' });
    const before = screen.getAllByDisplayValue('').length;
    await user.click(addButtons[0]); // inputs section
    const after = screen.getAllByDisplayValue('').length;
    expect(after).toBeGreaterThan(before);
  });

  it('re-renders new rows when the controlled value changes (regression)', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        swapTo={{
          inputs: [{ key: 'query', type: 'string', required: false }],
          outputs: [{ key: 'answer', type: 'string' }],
        }}
      />,
    );

    // Seeded from the first resource.
    expect(screen.getByDisplayValue('prompt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('text')).toBeInTheDocument();

    // Parent swaps the value to a different resource's schema.
    await user.click(screen.getByRole('button', { name: 'swap' }));

    expect(screen.getByDisplayValue('query')).toBeInTheDocument();
    expect(screen.getByDisplayValue('answer')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('prompt')).not.toBeInTheDocument();
  });
});
