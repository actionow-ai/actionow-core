import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { MARKUP_TYPES, toOptions } from '../../lib/api/enums';
import type { PricebookMethod } from '../../lib/api/types';
import { Button } from '../ui/Button';
import { ChipsField } from '../ui/ChipsField';
import { IconButton } from '../ui/IconButton';
import { NumberField } from '../ui/NumberField';
import { SelectField } from '../ui/SelectField';
import { TextField } from '../ui/TextField';
import { Toggle } from '../ui/Toggle';
import type { SpecFormState } from './pricebookSpec';
import { emptyCell, emptyDimension, validateFormula } from './pricebookSpec';

/**
 * The per-method `spec` builder. Renders only the branch the chosen `method`
 * needs and edits the shared `SpecFormState` via `onChange`; the parent (Page
 * 1b) calls `buildSpec(method, state)` on submit. Rate/cell numbers are
 * µcredits (1 credit = 1,000,000 µcredits) — surfaced in hints. The
 * human-credit `fixedCredits` for `fixed` lives on the pricing modal, so the
 * `fixed` branch is just a note pointing there.
 */
export function PricebookSpecForm({
  method,
  value,
  onChange,
}: {
  method: PricebookMethod;
  value: SpecFormState;
  onChange: (v: SpecFormState) => void;
}) {
  const { t } = useTranslation('console');

  if (method === 'unit') {
    const setDim = (i: number, patch: Partial<{ name: string; rate: number }>) =>
      onChange({ ...value, dimensions: value.dimensions.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
    const addDim = () => onChange({ ...value, dimensions: [...value.dimensions, emptyDimension()] });
    const removeDim = (i: number) => {
      const next = value.dimensions.filter((_, j) => j !== i);
      onChange({ ...value, dimensions: next.length > 0 ? next : [emptyDimension()] });
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        {value.dimensions.map((d, i) => (
          <div key={d.id ?? i} style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextField label={t('forms.spec.dimension')} value={d.name} onChange={(v) => setDim(i, { name: v })} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <NumberField
                label={t('forms.spec.rate')}
                tooltip={t('forms.spec.muCreditNote')}
                hint={t('forms.spec.rateHint')}
                min={0}
                value={d.rate}
                onChange={(n) => setDim(i, { rate: n })}
              />
            </div>
            <IconButton icon={XIcon} label={t('forms.removeDimension')} onClick={() => removeDim(i)} size={16} />
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" onClick={addDim}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" />
            {t('forms.addDimension')}
          </Button>
        </div>
      </div>
    );
  }

  if (method === 'matrix') {
    const setCell = (i: number, patch: Partial<{ k: string; cell: number }>) =>
      onChange({ ...value, table: value.table.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const addCell = () => onChange({ ...value, table: [...value.table, emptyCell()] });
    const removeCell = (i: number) => onChange({ ...value, table: value.table.filter((_, j) => j !== i) });
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <ChipsField
          label={t('forms.spec.key')}
          tooltip={t('forms.spec.keyHint')}
          value={value.key}
          onChange={(k) => onChange({ ...value, key: k })}
        />
        {value.table.map((r, i) => (
          <div key={r.id ?? i} style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextField
                label={t('forms.spec.cellKey')}
                tooltip={t('forms.spec.cellKeyHint')}
                value={r.k}
                onChange={(v) => setCell(i, { k: v })}
              />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <NumberField
                label={t('forms.spec.cell')}
                tooltip={t('forms.spec.muCreditNote')}
                min={0}
                value={r.cell}
                onChange={(n) => setCell(i, { cell: n })}
              />
            </div>
            <IconButton icon={XIcon} label={t('forms.removeRow')} onClick={() => removeCell(i)} size={16} />
          </div>
        ))}
        <div>
          <Button variant="ghost" size="sm" onClick={addCell}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" />
            {t('forms.addRow')}
          </Button>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <TextField
              label={t('forms.spec.multiplier')}
              hint={t('forms.spec.multiplierHint')}
              value={value.multiplier}
              onChange={(v) => onChange({ ...value, multiplier: v })}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <TextField
              label={t('forms.spec.perItem')}
              hint={t('forms.spec.perItemHint')}
              value={value.perItem}
              onChange={(v) => onChange({ ...value, perItem: v })}
            />
          </div>
        </div>
      </div>
    );
  }

  if (method === 'formula') {
    const valid = validateFormula(value.expr);
    return (
      <TextField
        label={t('forms.spec.expr')}
        hint={t('forms.spec.exprHint')}
        tooltip={t('forms.spec.exprTooltip')}
        value={value.expr}
        onChange={(v) => onChange({ ...value, expr: v })}
        error={value.expr.trim() !== '' && !valid ? t('forms.spec.exprError') : undefined}
      />
    );
  }

  if (method === 'passthrough') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <Toggle
          label={t('forms.spec.markup')}
          checked={value.markup.enabled}
          onChange={(c) => onChange({ ...value, markup: { ...value.markup, enabled: c } })}
        />
        {value.markup.enabled && (
          <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <SelectField
                label={t('forms.spec.markupType')}
                value={value.markup.type}
                onChange={(v) => onChange({ ...value, markup: { ...value.markup, type: v as 'percent' | 'flat' } })}
                options={toOptions(MARKUP_TYPES, (k) => t(k))}
              />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <NumberField
                label={t('forms.spec.markupValue')}
                hint={value.markup.type === 'percent' ? t('forms.spec.markupPercentHint') : t('forms.spec.markupFlatHint')}
                min={0}
                value={value.markup.value}
                onChange={(n) => onChange({ ...value, markup: { ...value.markup, value: n } })}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  // fixed
  return (
    <p style={{ margin: 0, fontSize: 'var(--fs-sm)', color: 'var(--faint)' }}>{t('forms.spec.fixedNote')}</p>
  );
}
