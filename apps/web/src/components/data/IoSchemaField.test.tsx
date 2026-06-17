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

function Harness({ onChange }: { onChange: (v: { inputs: IoField[]; outputs: IoField[] }) => void }) {
  const [value, setValue] = useState<{ inputs: IoField[]; outputs: IoField[] }>({
    inputs: [{ key: 'prompt', type: 'string', required: true }],
    outputs: [{ key: 'text', type: 'string' }],
  });
  return (
    <IoSchemaField
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('IoSchemaField', () => {
  it('renders the inputs/outputs sections seeded from value', () => {
    render(<Harness onChange={() => {}} />);
    expect(screen.getByText('Inputs')).toBeInTheDocument();
    expect(screen.getByText('Outputs')).toBeInTheDocument();
    expect(screen.getByDisplayValue('prompt')).toBeInTheDocument();
    expect(screen.getByDisplayValue('text')).toBeInTheDocument();
  });

  it('typing a new key emits a cleaned schema', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    const promptKey = screen.getByDisplayValue('prompt');
    await user.type(promptKey, '2');

    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last.inputs[0].key).toBe('prompt2');
    expect(last.outputs[0]).toEqual({ key: 'text', type: 'string', required: false });
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
});
