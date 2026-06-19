import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { Money } from '../../components/data/Money';
import { Button } from '../../components/ui/Button';
import { NumberField } from '../../components/ui/NumberField';
import { Pill } from '../../components/ui/Pill';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleIntentView, ConsolePaymentView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_VOLATILE } from '../../lib/query';

/** A payment status → pill tone (succeeded ok; failed/expired fail; else neutral). */
function payTone(status: string): 'ok' | 'fail' | 'idle' {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'expired') return 'fail';
  return 'idle';
}

/** Major-unit amount → integer minor units (e.g. dollars → cents), float-safe. */
export function toMinorUnits(major: number): number {
  return Math.round(major * 100);
}

const PROVIDERS = ['stripe', 'alipay', 'wechat', 'crypto'] as const;

export function AppBilling() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();

  const [provider, setProvider] = useState<string>('stripe');
  const [amount, setAmount] = useState(0);
  const [currency, setCurrency] = useState('usd');
  const [intent, setIntent] = useState<ConsoleIntentView | null>(null);

  const topup = useMutation({
    mutationFn: () =>
      api.topup({
        provider,
        amount_minor: toMinorUnits(amount),
        currency: currency.trim().toLowerCase(),
      }),
    onSuccess: (r) => setIntent(r),
    onError: mutationError(t),
  });

  const canSubmit = amount > 0 && currency.trim() !== '';

  const history = useQuery({
    queryKey: qk.consolePayments(),
    queryFn: () => api.listPayments({ limit: 50 }),
    staleTime: STALE_VOLATILE,
  });

  const histCols: Column<ConsolePaymentView>[] = [
    {
      key: 'time',
      header: t('app.billing.cols.time'),
      cell: (r) => new Date(r.created_at).toLocaleString(),
      width: '170px',
    },
    {
      key: 'provider',
      header: t('app.billing.cols.provider'),
      cell: (r) => r.provider,
      width: '110px',
    },
    {
      key: 'amount',
      header: t('app.billing.cols.amount'),
      cell: (r) => (
        <span className="tabular">
          {(Number(r.amount_minor) / 100).toFixed(2)} {r.currency.toUpperCase()}
        </span>
      ),
      width: '120px',
    },
    {
      key: 'credit',
      header: t('app.billing.cols.credit'),
      cell: (r) => (r.credit_amount !== null ? <Money micro={r.credit_amount} /> : '—'),
      width: '110px',
    },
    {
      key: 'status',
      header: t('app.billing.cols.status'),
      cell: (r) => <Pill tone={payTone(r.status)}>{r.status}</Pill>,
      width: '110px',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div style={{ maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <div
          className="panel"
          style={{
            borderRadius: 'var(--r-md)',
            padding: 'var(--s-4)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s-4)',
          }}
        >
          <div>
            <div
              style={{
                fontSize: 'var(--fs-caption)',
                textTransform: 'uppercase',
                letterSpacing: '.06em',
                color: 'var(--faint)',
                marginBottom: 'var(--s-2)',
              }}
            >
              {t('app.billing.provider')}
            </div>
            <SegmentedControl
              ariaLabel={t('app.billing.provider')}
              value={provider}
              onChange={setProvider}
              options={PROVIDERS.map((p) => ({
                value: p,
                label: p.charAt(0).toUpperCase() + p.slice(1),
              }))}
            />
          </div>
          <NumberField
            label={t('app.billing.amount')}
            hint={t('app.billing.amountHint')}
            value={amount}
            onChange={setAmount}
            min={0}
            step={1}
          />
          <TextField label={t('app.billing.currency')} value={currency} onChange={setCurrency} />
          <Button
            variant="cta"
            onClick={() => topup.mutate()}
            loading={topup.isPending}
            disabled={!canSubmit}
          >
            {t('app.billing.submit')}
          </Button>
        </div>

        {intent !== null && (
          <div
            className="panel"
            style={{
              borderRadius: 'var(--r-md)',
              padding: 'var(--s-4)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--s-3)',
            }}
          >
            <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
              {t('app.billing.intentCreated')}
            </div>
            <div
              className="mono"
              style={{
                fontSize: 'var(--fs-caption)',
                color: 'var(--muted)',
                wordBreak: 'break-all',
              }}
            >
              {intent.intent_id}
            </div>
            {intent.redirect_url !== undefined && intent.redirect_url !== '' && (
              <Button href={intent.redirect_url} variant="cta">
                <ArrowSquareOutIcon size={15} /> {t('app.billing.continue')}
              </Button>
            )}
            {intent.qr !== undefined && intent.qr !== '' && (
              <div
                className="mono"
                style={{
                  fontSize: 'var(--fs-caption)',
                  color: 'var(--muted)',
                  wordBreak: 'break-all',
                }}
              >
                {intent.qr}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.billing.history')} />
        <DataTable
          columns={histCols}
          rows={history.data?.rows ?? []}
          rowKey={(r) => r.id}
          loading={history.isLoading}
          empty={t('app.billing.noHistory')}
          pageSize={10}
        />
      </div>
    </div>
  );
}
