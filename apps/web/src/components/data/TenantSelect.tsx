import { CaretDownIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { qk } from '../../lib/api/queryKeys';
import type { TenantView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { formatCredits } from '../../lib/money';
import { STALE_REFERENCE } from '../../lib/query';
import { FIELD_INPUT_BASE } from '../ui/fieldStyles';
import { Modal } from '../ui/Modal';
import { SelectField } from '../ui/SelectField';
import { TextField } from '../ui/TextField';

/**
 * Tenant picker. With a `label` it renders a stacked form field (a plain
 * `SelectField`). Without one (the TopBar filter slot) it renders a compact
 * field-button that opens a SEARCHABLE MODAL — a flat dropdown doesn't scale to
 * many tenants. Same `value`/`onChange(id)` contract either way, so call-sites
 * don't change; `value === ''` means "all / unselected".
 */
export function TenantSelect({
  label,
  value,
  onChange,
  placeholder,
  tooltip,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  tooltip?: string;
}) {
  const api = useAdminApi();
  const { data } = useQuery({
    queryKey: qk.tenants(),
    queryFn: () => api.listTenants(),
    staleTime: STALE_REFERENCE,
  });
  const tenants = data ?? [];

  if (label !== undefined) {
    const options = tenants.map((tn) => ({ value: tn.id, label: tn.name }));
    return (
      <SelectField
        label={label}
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        tooltip={tooltip}
      />
    );
  }
  return (
    <TenantPickerModal
      tenants={tenants}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
    />
  );
}

/** The filter-slot tenant picker: a field-button trigger + a searchable modal. */
function TenantPickerModal({
  tenants,
  value,
  onChange,
  placeholder,
}: {
  tenants: TenantView[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const { t, i18n } = useTranslation('console');
  const api = useAdminApi();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  // Per-tenant balance for the rich rows — fetched only while the picker is open
  // (cheap reference query, cached); maps tenant_id → µcredit balance string.
  const { data: accounts } = useQuery({
    queryKey: qk.accounts(),
    queryFn: () => api.listAccounts(),
    staleTime: STALE_REFERENCE,
    enabled: open,
  });
  const balanceByTenant = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts ?? []) m.set(a.tenant_id, a.credit_balance);
    return m;
  }, [accounts]);

  const selected = tenants.find((tn) => tn.id === value);
  const allLabel = placeholder ?? t('tenants.picker.all');
  const triggerText = selected?.name ?? allLabel;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle === '') return tenants;
    return tenants.filter(
      (tn) => tn.name.toLowerCase().includes(needle) || tn.id.toLowerCase().includes(needle),
    );
  }, [tenants, q]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={allLabel}
        // `.field` gives the bordered glass surface (border/radius/min-height/padding)
        // so the trigger matches the other field controls; FIELD_INPUT_BASE adds fill.
        className="field"
        style={{
          ...FIELD_INPUT_BASE,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-2)',
          cursor: 'pointer',
          textAlign: 'left',
          color: selected !== undefined ? 'var(--text)' : 'var(--muted)',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {triggerText}
        </span>
        <CaretDownIcon size={14} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--muted)' }} />
      </button>

      <Modal open={open} title={t('tenants.picker.title')} onClose={() => setOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <TextField
            label={t('common.search')}
            value={q}
            onChange={setQ}
            placeholder={t('tenants.picker.searchPlaceholder')}
          />
          <div
            style={{
              maxHeight: '50vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <PickerRow active={value === ''} onClick={() => pick('')}>
              <span style={{ fontWeight: 'var(--fw-medium)' }}>{allLabel}</span>
              <span style={{ flex: 1 }} />
              <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-caption)' }}>
                {t('tenants.picker.count', { n: tenants.length })}
              </span>
            </PickerRow>
            {filtered.map((tn) => {
              const bal = balanceByTenant.get(tn.id);
              return (
                <PickerRow key={tn.id} active={tn.id === value} onClick={() => pick(tn.id)}>
                  <span
                    style={{
                      fontWeight: 'var(--fw-medium)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tn.name}
                  </span>
                  <span className="mono" style={{ color: 'var(--faint)', fontSize: 'var(--fs-caption)' }}>
                    {tn.id.slice(0, 8)}
                  </span>
                  <span style={{ flex: 1 }} />
                  {bal !== undefined && (
                    <span className="tabular" style={{ color: 'var(--muted)', fontSize: 'var(--fs-caption)' }}>
                      {formatCredits(bal, i18n.language)}
                    </span>
                  )}
                </PickerRow>
              );
            })}
            {filtered.length === 0 && (
              <div
                style={{
                  padding: 'var(--s-4)',
                  textAlign: 'center',
                  color: 'var(--muted)',
                  fontSize: 'var(--fs-sm)',
                }}
              >
                {t('tenants.picker.none')}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}

/** One selectable row in the tenant picker list. */
function PickerRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="glass-hover"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s-2)',
        width: '100%',
        textAlign: 'left',
        padding: 'var(--s-3)',
        borderRadius: 'var(--r-sm)',
        border: 'none',
        cursor: 'pointer',
        fontSize: 'var(--fs-sm)',
        background: active ? 'var(--hover-bg)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  );
}
