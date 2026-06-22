import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DateField, parseISO, toISO } from './DateField';

describe('DateField', () => {
  it('parseISO/toISO round-trip a local date (no UTC shift)', () => {
    const d = parseISO('2026-06-22');
    expect(d).not.toBeNull();
    expect(d === null ? '' : toISO(d)).toBe('2026-06-22');
    expect(parseISO('nope')).toBeNull();
  });

  it('opens a themed calendar and emits ISO YYYY-MM-DD on day select', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateField value="2026-06-15" onChange={onChange} ariaLabel="from" />);

    // Trigger shows the formatted selected date, not a native input.
    await user.click(screen.getByRole('button', { name: 'from' }));
    // Day 20 is unique to the shown month (June) — pick it.
    await user.click(screen.getByRole('button', { name: '20' }));
    expect(onChange).toHaveBeenCalledWith('2026-06-20');
  });

  it('disables days outside [min, max]', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateField value="2026-06-15" onChange={onChange} min="2026-06-20" ariaLabel="from" />);
    await user.click(screen.getByRole('button', { name: 'from' }));
    // Day 15 is before the min (20) — its button is disabled, so a click no-ops.
    // (15 is unique to the shown month; days 1–11 also appear as next-month trail.)
    const day15 = screen.getByRole('button', { name: '15' });
    expect(day15).toBeDisabled();
    await user.click(day15);
    expect(onChange).not.toHaveBeenCalled();
  });
});
