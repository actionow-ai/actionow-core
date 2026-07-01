import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

import { PARAM_RULE_TYPES, PARAM_TEMPLATES } from '../../lib/api/enums';
import { Button } from '../ui/Button';
import { ChipsField } from '../ui/ChipsField';
import { FormField, useFieldId } from '../ui/FormField';
import { RowAction } from '../ui/RowAction';
import { SelectField } from '../ui/SelectField';
import { TextField } from '../ui/TextField';
import { Toggle } from '../ui/Toggle';

/** One editable parameter-rule row (camelCase, mirrors contract `parameterRuleSchema`). */
export interface ParameterRuleDraft {
  name: string;
  useTemplate?: string; // '' in the select == none
  type?: 'float' | 'int' | 'boolean' | 'string' | 'enum' | 'json';
  default?: unknown;
  min?: number;
  max?: number;
  required?: boolean;
  options?: string[]; // only when type === 'enum'
  help?: string;
}

/** Parse a text numeric input into `number | undefined` (blank → unset). */
function parseNum(raw: string): number | undefined {
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function numStr(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

/** Render an `unknown` rule `default` as an editable string (primitives verbatim, objects as JSON). */
function defaultToString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * A repeatable structured editor for a model's `param_profile.parameterRules` —
 * the "structured, never raw JSON" idiom (modeled on `KeyValueEditor`). The
 * parent owns the `ParameterRuleDraft[]`; this renders straight from `value` and
 * emits a fresh array on every edit. Each row is a bordered `.panel` card: the
 * param name + a `useTemplate` picker, then type/bounds/default/required/help
 * controls whose value input switches on `type`. A duplicate-name guard shows an
 * inline error. Empty-named rows are dropped by the parent at submit time.
 */
export function ParameterRulesEditor({
  value,
  onChange,
  label,
  tooltip,
}: {
  value: ParameterRuleDraft[];
  onChange: (next: ParameterRuleDraft[]) => void;
  label?: string;
  tooltip?: string;
}) {
  const { t } = useTranslation('console');
  const fieldId = useFieldId();

  const setRow = (index: number, patch: Partial<ParameterRuleDraft>) => {
    onChange(value.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };
  const addRow = () => onChange([...value, { name: '' }]);
  const removeRow = (index: number) => onChange(value.filter((_, i) => i !== index));

  // Duplicate-name detection (ignoring blanks) → inline error on the later row.
  const seen = new Map<string, number>();
  const dupIndexes = new Set<number>();
  value.forEach((r, i) => {
    const n = r.name.trim();
    if (n === '') return;
    if (seen.has(n)) dupIndexes.add(i);
    else seen.set(n, i);
  });

  const templateOptions = [
    { value: '', label: t('models.param.templateNone') },
    ...PARAM_TEMPLATES.map((v) => ({ value: v, label: v })),
  ];
  const typeOptions = PARAM_RULE_TYPES.map((ty) => ({ value: ty, label: ty }));

  return (
    <FormField id={fieldId} label={label} tooltip={tooltip}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {value.map((row, i) => {
          const effectiveType = row.type ?? 'float';
          return (
            <div
              key={i}
              className="panel"
              style={{
                borderRadius: 'var(--r-sm)',
                padding: 'var(--s-3)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-2)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--s-2)' }}>
                <div style={{ flex: 2, minWidth: 0 }}>
                  <TextField
                    label={t('override.opName')}
                    value={row.name}
                    onChange={(v) => setRow(i, { name: v })}
                    placeholder="temperature"
                    error={dupIndexes.has(i) ? t('models.param.dupName') : undefined}
                  />
                </div>
                <div style={{ flex: 2, minWidth: 0 }}>
                  <SelectField
                    label={t('models.param.template')}
                    value={row.useTemplate ?? ''}
                    onChange={(v) => setRow(i, { useTemplate: v === '' ? undefined : v })}
                    options={templateOptions}
                  />
                </div>
                <div style={{ paddingTop: 'calc(var(--s-4) + 2px)' }}>
                  <RowAction
                    icon={TrashIcon}
                    label={t('forms.removeRow')}
                    onClick={() => removeRow(i)}
                    danger
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <SelectField
                    label={t('models.param.ruleType')}
                    value={effectiveType}
                    onChange={(v) => setRow(i, { type: v as ParameterRuleDraft['type'] })}
                    options={typeOptions}
                  />
                </div>
                {(effectiveType === 'float' || effectiveType === 'int') && (
                  <>
                    <div style={{ flex: 1, minWidth: 90 }}>
                      <TextField
                        label={t('models.param.ruleMin')}
                        value={numStr(row.min)}
                        onChange={(v) => setRow(i, { min: parseNum(v) })}
                        placeholder="0"
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 90 }}>
                      <TextField
                        label={t('models.param.ruleMax')}
                        value={numStr(row.max)}
                        onChange={(v) => setRow(i, { max: parseNum(v) })}
                        placeholder="2"
                      />
                    </div>
                  </>
                )}
              </div>

              {effectiveType === 'enum' && (
                <ChipsField
                  label={t('models.param.ruleOptions')}
                  value={row.options ?? []}
                  onChange={(opts) => setRow(i, { options: opts })}
                  placeholder="low, medium, high"
                />
              )}

              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {effectiveType === 'boolean' ? (
                    <SelectField
                      label={t('models.param.ruleDefault')}
                      value={defaultToString(row.default)}
                      onChange={(v) => setRow(i, { default: v === '' ? undefined : v === 'true' })}
                      options={[
                        { value: '', label: t('models.param.templateNone') },
                        { value: 'true', label: 'true' },
                        { value: 'false', label: 'false' },
                      ]}
                    />
                  ) : (
                    <TextField
                      label={t('models.param.ruleDefault')}
                      value={defaultToString(row.default)}
                      onChange={(v) =>
                        setRow(i, {
                          default:
                            v === ''
                              ? undefined
                              : effectiveType === 'float' || effectiveType === 'int'
                                ? (parseNum(v) ?? v)
                                : v,
                        })
                      }
                    />
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center' }}>
                <Toggle
                  checked={row.required === true}
                  onChange={(on) => setRow(i, { required: on })}
                  label={t('models.param.ruleRequired')}
                />
              </div>

              <TextField
                label={t('models.param.ruleHelp')}
                value={row.help ?? ''}
                onChange={(v) => setRow(i, { help: v === '' ? undefined : v })}
              />
            </div>
          );
        })}
        <div>
          <Button variant="ghost" size="sm" onClick={addRow}>
            <PlusIcon size={14} weight="bold" aria-hidden="true" />
            {t('models.param.addRule')}
          </Button>
        </div>
      </div>
    </FormField>
  );
}
