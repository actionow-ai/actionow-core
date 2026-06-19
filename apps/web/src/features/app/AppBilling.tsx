import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/Button';
import { NumberField } from '../../components/ui/NumberField';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { mutationError } from '../../lib/api/mutationError';
import type { ConsoleIntentView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';

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

  return (
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
            style={{ fontSize: 'var(--fs-caption)', color: 'var(--muted)', wordBreak: 'break-all' }}
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
  );
}
