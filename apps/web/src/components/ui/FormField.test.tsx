import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FormField, useFieldId } from './FormField';

describe('FormField', () => {
  it('renders the label and associates it with the control via htmlFor/id', () => {
    render(
      <FormField id="f1" label="Email">
        <input id="f1" />
      </FormField>,
    );
    const label = screen.getByText('Email');
    expect(label).toHaveAttribute('for', 'f1');
  });

  it('shows the error text in the --fail color when set', () => {
    render(
      <FormField id="f2" label="Email" error="required">
        <input id="f2" />
      </FormField>,
    );
    const err = screen.getByText('required');
    expect(err).toBeInTheDocument();
    expect(err).toHaveStyle({ color: 'var(--fail)' });
  });

  it('shows the hint when set and no error is present', () => {
    render(
      <FormField id="f3" label="Email" hint="we never share it">
        <input id="f3" />
      </FormField>,
    );
    expect(screen.getByText('we never share it')).toBeInTheDocument();
  });

  it('prefers the error over the hint when both are set', () => {
    render(
      <FormField id="f4" label="Email" hint="a hint" error="an error">
        <input id="f4" />
      </FormField>,
    );
    expect(screen.getByText('an error')).toBeInTheDocument();
    expect(screen.queryByText('a hint')).not.toBeInTheDocument();
  });

  it('marks the field as required', () => {
    render(
      <FormField id="f5" label="Email" required>
        <input id="f5" />
      </FormField>,
    );
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('renders no label element when label is omitted', () => {
    const { container } = render(
      <FormField id="f6">
        <input id="f6" />
      </FormField>,
    );
    expect(container.querySelector('label')).toBeNull();
  });
});

describe('useFieldId', () => {
  it('returns the explicit id when given', () => {
    const { result } = renderHook(() => useFieldId('explicit'));
    expect(result.current).toBe('explicit');
  });

  it('generates a stable id when none is given', () => {
    const { result, rerender } = renderHook(() => useFieldId());
    const first = result.current;
    expect(first).toMatch(/^ff-/);
    rerender();
    expect(result.current).toBe(first);
  });
});
