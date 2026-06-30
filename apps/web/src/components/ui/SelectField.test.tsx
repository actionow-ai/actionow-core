import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SelectField } from './SelectField';

const opts = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
];

describe('SelectField disabled', () => {
  it('does not open or change when disabled', () => {
    const onChange = vi.fn();
    render(<SelectField label="Fruit" value="a" onChange={onChange} options={opts} disabled />);
    const trigger = screen.getByRole('button', { name: 'Fruit' });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
