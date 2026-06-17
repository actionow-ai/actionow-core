import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EnumOption } from '../../lib/api/enums';
import { toOptions } from '../../lib/api/enums';
import { Button } from '../ui/Button';
import { ChipsField } from '../ui/ChipsField';
import { IconButton } from '../ui/IconButton';
import { NumberField } from '../ui/NumberField';
import { SelectField } from '../ui/SelectField';
import { TextField } from '../ui/TextField';
import { Toggle } from '../ui/Toggle';
import { Tooltip } from '../ui/Tooltip';
import type { IoField, IoType } from './ioSchemaShape';
import { buildIoSchema, emptyIoField, IO_TYPES } from './ioSchemaShape';

const IO_TYPE_OPTIONS: EnumOption<IoType>[] = IO_TYPES.map((v) => ({ value: v, labelKey: `forms.io.type_${v}` }));

interface IoSchemaValue {
  inputs: IoField[];
  outputs: IoField[];
}

/**
 * The structured `ioSchema` builder: two labelled sections (Inputs / Outputs),
 * each an add/remove list of field rows (key + type + required, plus optional
 * label/maxLength and — for `enum` — an options `ChipsField`). Emits the cleaned
 * `{ inputs, outputs }` (blank-key rows dropped) via `buildIoSchema` on every
 * edit. Every field carries an inline hint/tooltip describing the backend shape.
 */
export function IoSchemaField({ value, onChange }: { value?: IoSchemaValue; onChange: (v: IoSchemaValue) => void }) {
  const { t } = useTranslation('console');
  const [inputs, setInputs] = useState<IoField[]>(() => (value?.inputs && value.inputs.length > 0 ? value.inputs : [emptyIoField()]));
  const [outputs, setOutputs] = useState<IoField[]>(() =>
    value?.outputs && value.outputs.length > 0 ? value.outputs : [emptyIoField()],
  );

  const emit = (nextInputs: IoField[], nextOutputs: IoField[]) => {
    setInputs(nextInputs);
    setOutputs(nextOutputs);
    onChange(buildIoSchema(nextInputs, nextOutputs));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <FieldSection
        title={t('forms.io.inputs')}
        tooltip={t('forms.io.inputsHint')}
        rows={inputs}
        onRows={(rows) => emit(rows, outputs)}
        t={t}
      />
      <FieldSection
        title={t('forms.io.outputs')}
        tooltip={t('forms.io.outputsHint')}
        rows={outputs}
        onRows={(rows) => emit(inputs, rows)}
        t={t}
      />
    </div>
  );
}

function FieldSection({
  title,
  tooltip,
  rows,
  onRows,
  t,
}: {
  title: string;
  tooltip: string;
  rows: IoField[];
  onRows: (rows: IoField[]) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const setRow = (index: number, patch: Partial<IoField>) => {
    onRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };
  const addRow = () => onRows([...rows, emptyIoField()]);
  const removeRow = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    onRows(next.length > 0 ? next : [emptyIoField()]);
  };

  const typeOptions = toOptions(IO_TYPE_OPTIONS, (k) => t(k));

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-1)' }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 650, color: 'var(--text)' }}>{title}</span>
        <Tooltip text={tooltip} />
      </div>
      {rows.map((row, i) => {
        const showMaxLength = row.type === 'string' || row.type === 'file';
        return (
          <div
            key={i}
            className="panel"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-2)',
              padding: 'var(--s-3)',
              borderRadius: 'var(--r-sm)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-2)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextField
                  label={t('forms.io.key')}
                  tooltip={t('forms.io.keyHint')}
                  value={row.key}
                  onChange={(v) => setRow(i, { key: v })}
                  placeholder={t('forms.io.keyPlaceholder')}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <SelectField
                  label={t('forms.io.typeLabel')}
                  tooltip={t('forms.io.typeHint')}
                  value={row.type}
                  onChange={(v) => setRow(i, { type: v as IoType })}
                  options={typeOptions}
                />
              </div>
              <IconButton icon={XIcon} label={t('forms.removeField')} onClick={() => removeRow(i)} size={16} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
              <Toggle label={t('forms.io.required')} checked={row.required ?? false} onChange={(c) => setRow(i, { required: c })} />
            </div>
            <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <TextField
                  label={t('forms.io.fieldLabel')}
                  tooltip={t('forms.io.fieldLabelHint')}
                  value={row.label ?? ''}
                  onChange={(v) => setRow(i, { label: v })}
                />
              </div>
              {showMaxLength && (
                <div style={{ flex: 1, minWidth: 160 }}>
                  <NumberField
                    label={t('forms.io.maxLength')}
                    tooltip={t('forms.io.maxLengthHint')}
                    min={0}
                    value={row.maxLength ?? 0}
                    onChange={(n) => setRow(i, { maxLength: n })}
                  />
                </div>
              )}
            </div>
            {row.type === 'enum' && (
              <ChipsField
                label={t('forms.io.options')}
                hint={t('forms.io.optionsHint')}
                value={row.options ?? []}
                onChange={(opts) => setRow(i, { options: opts })}
              />
            )}
          </div>
        );
      })}
      <div>
        <Button variant="ghost" size="sm" onClick={addRow}>
          <PlusIcon size={14} weight="bold" aria-hidden="true" />
          {t('forms.addField')}
        </Button>
      </div>
    </section>
  );
}
