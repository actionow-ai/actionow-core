import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { NumberField } from './NumberField';

describe('NumberField', () => {
  it('emits onChange(number) when a digit is typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NumberField label="Credits" value={0} onChange={onChange} />);
    const input = screen.getByLabelText('Credits');
    await user.type(input, '5');
    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('emits onChange(0) when the input is cleared (documented empty -> 0)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NumberField label="Credits" value={7} onChange={onChange} />);
    const input = screen.getByLabelText('Credits');
    await user.clear(input);
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('passes min/max/step through to the underlying input', () => {
    render(
      <NumberField label="Rate" value={1} onChange={() => undefined} min={1} max={100} step={5} />,
    );
    const input = screen.getByLabelText('Rate');
    expect(input).toHaveAttribute('min', '1');
    expect(input).toHaveAttribute('max', '100');
    expect(input).toHaveAttribute('step', '5');
    expect(input).toHaveAttribute('type', 'number');
  });

  it('composes FormField: renders the label and the error text', () => {
    render(<NumberField label="Rate" value={1} onChange={() => undefined} error="too small" />);
    expect(screen.getByText('Rate')).toBeInTheDocument();
    expect(screen.getByText('too small')).toBeInTheDocument();
  });

  it('reflects the numeric value', () => {
    render(<NumberField label="Rate" value={42} onChange={() => undefined} />);
    expect(screen.getByLabelText('Rate')).toHaveValue(42);
  });
});
