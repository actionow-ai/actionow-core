import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import type { PricebookMethod } from '../../lib/api/types';
import type { SpecFormState } from './pricebookSpec';
import { emptyDimension, emptySpecForm } from './pricebookSpec';
import { PricebookSpecForm } from './PricebookSpecForm';

beforeAll(async () => {
  await i18n.changeLanguage('en');
  i18n.addResourceBundle(
    'en',
    'console',
    {
      forms: {
        addDimension: 'Add dimension',
        removeDimension: 'Remove dimension',
        addRow: 'Add row',
        removeRow: 'Remove row',
        spec: {
          dimension: 'Dimension',
          rate: 'Rate',
          rateHint: 'micro-credits per unit',
          muCreditNote: '1 credit = 1,000,000 micro-credits',
          key: 'Key',
          keyHint: 'dimensions',
          cellKey: 'Combined key',
          cellKeyHint: 'join with |',
          cell: 'Cell',
          multiplier: 'Multiplier',
          multiplierHint: 'var',
          perItem: 'Per item',
          perItemHint: 'var',
          expr: 'Expression',
          exprHint: 'only + - * ( )',
          exprTooltip: 'variables from request params',
          exprError: 'Only + - * ( ), integers and variable names are allowed',
          markup: 'Add markup',
          markupType: 'Markup type',
          markupValue: 'Markup value',
          markupPercentHint: 'whole percent',
          markupFlatHint: 'micro-credits',
          fixedNote: 'Set the price via Fixed credits below.',
        },
      },
      enums: { markupType: { percent: 'Percent', flat: 'Flat' } },
    },
    true,
    true,
  );
});

function Harness({
  method,
  initial,
}: {
  method: PricebookMethod;
  initial?: Partial<SpecFormState>;
}) {
  const [value, setValue] = useState<SpecFormState>({ ...emptySpecForm(), ...initial });
  return <PricebookSpecForm method={method} value={value} onChange={setValue} />;
}

describe('PricebookSpecForm', () => {
  it('unit: adds a dimension row', async () => {
    const user = userEvent.setup();
    render(<Harness method="unit" />);
    const before = screen.getAllByRole('spinbutton').length; // rate NumberFields
    await user.click(screen.getByRole('button', { name: 'Add dimension' }));
    expect(screen.getAllByRole('spinbutton').length).toBeGreaterThan(before);
  });

  it('unit: preserves surviving dimension row nodes when a middle row is removed (stable keys)', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        method="unit"
        initial={{
          dimensions: [
            { ...emptyDimension(), name: 'a' },
            { ...emptyDimension(), name: 'b' },
            { ...emptyDimension(), name: 'c' },
          ],
        }}
      />,
    );
    const cBefore = screen.getByDisplayValue('c');
    const removeButtons = screen.getAllByRole('button', { name: 'Remove dimension' });
    await user.click(removeButtons[1]!); // middle row (b)
    const cAfter = screen.getByDisplayValue('c');
    expect(cAfter).toBe(cBefore);
    expect(screen.queryByDisplayValue('b')).not.toBeInTheDocument();
  });

  it('formula: shows a validation error for a disallowed expression', () => {
    render(<Harness method="formula" initial={{ expr: 'a / b' }} />);
    expect(
      screen.getByText('Only + - * ( ), integers and variable names are allowed'),
    ).toBeInTheDocument();
  });

  it('formula: no error for a valid expression', () => {
    render(<Harness method="formula" initial={{ expr: 'a + b' }} />);
    expect(
      screen.queryByText('Only + - * ( ), integers and variable names are allowed'),
    ).not.toBeInTheDocument();
  });

  it('passthrough: markup fields appear only after enabling the toggle', async () => {
    const user = userEvent.setup();
    render(<Harness method="passthrough" />);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Add markup' }));
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('fixed: renders the pointer note', () => {
    render(<Harness method="fixed" />);
    expect(screen.getByText('Set the price via Fixed credits below.')).toBeInTheDocument();
  });
});
