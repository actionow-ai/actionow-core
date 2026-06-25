import { ArrowSquareOutIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BalanceCard } from '../../components/data/BalanceCard';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { Money } from '../../components/data/Money';
import { StatusBadge } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { NumberField } from '../../components/ui/NumberField';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { TextField } from '../../components/ui/TextField';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type {
  ConsoleCreateIntentBody,
  ConsoleIntentView,
  ConsolePaymentView,
} from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_VOLATILE } from '../../lib/query';
import { AdminOnlyNote } from './AdminOnlyNote';
import { useTenantRole } from './useTenantRole';

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

/** Bound to the contract enum: a literal here that drifts from the payment-provider
 *  schema fails the `satisfies` check at build, not at runtime. */
type Provider = ConsoleCreateIntentBody['provider'];
const PROVIDERS = ['stripe', 'alipay', 'wechat', 'crypto'] as const satisfies readonly Provider[];

export function AppBilling() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  // RBAC v1: top-up is an admin-only write; a member sees balance + history only.
  const { isTenantAdmin } = useTenantRole();

  const [provider, setProvider] = useState<Provider>('stripe');
  const [amount, setAmount] = useState(0);
  const [currency, setCurrency] = useState('usd');
  const [intent, setIntent] = useState<ConsoleIntentView | null>(null);

  const balance = useQuery({
    queryKey: qk.consoleBalance(),
    queryFn: () => api.balance(),
    staleTime: STALE_VOLATILE,
  });

  const topup = useMutation({
    mutationFn: () =>
      api.topup({
        provider,
        amount_minor: toMinorUnits(amount),
        currency: currency.trim().toLowerCase(),
      }),
    onSuccess: async (r) => {
      // A new intent may settle async (webhook) — refresh balance + history so
      // a completed top-up shows without a manual reload.
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.consolePayments() }),
        qc.invalidateQueries({ queryKey: qk.consoleBalance() }),
      ]);
      setIntent(r);
    },
    onError: mutationError(t),
  });

  const canSubmit = amount > 0 && currency.trim() !== '';

  const history = useInfiniteQuery({
    queryKey: qk.consolePayments(),
    queryFn: ({ pageParam }) => api.listPayments({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: STALE_VOLATILE,
  });
  const historyRows = history.data?.pages.flatMap((p) => p.rows) ?? [];

  // Poll the freshly-created intent until it settles (provider webhook), then
  // refresh balance + history so a completed top-up reflects without a reload.
  const intentId = intent?.intent_id ?? null;
  const intentStatus = useQuery({
    queryKey: qk.consolePaymentIntent(intentId ?? ''),
    queryFn: () => api.getPaymentIntent(intentId ?? ''),
    enabled: intentId !== null,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'succeeded' || s === 'failed' || s === 'expired' ? false : 3000;
    },
  });
  const settledStatus = intentStatus.data?.status;
  useEffect(() => {
    if (settledStatus === 'succeeded') {
      void qc.invalidateQueries({ queryKey: qk.consoleBalance() });
      void qc.invalidateQueries({ queryKey: qk.consolePayments() });
    }
  }, [settledStatus, qc]);

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
      grow: true,
      cell: (r) => r.provider,
    },
    {
      key: 'amount',
      header: t('app.billing.cols.amount'),
      numeric: true,
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
      numeric: true,
      cell: (r) => (r.credit_amount !== null ? <Money micro={r.credit_amount} /> : '—'),
      width: '110px',
    },
    {
      key: 'status',
      header: t('app.billing.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={payTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '110px',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div style={{ maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <BalanceCard
          micro={balance.data?.balance ?? '0'}
          label={t('app.billing.balance')}
          held={balance.data?.held ?? '0'}
          heldLabel={t('app.billing.held')}
        />
        {!isTenantAdmin && <AdminOnlyNote />}
        {isTenantAdmin && (
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
                onChange={(v) => setProvider(v as Provider)}
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
        )}

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
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--s-2)',
              }}
            >
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
                {t('app.billing.intentCreated')}
              </span>
              {settledStatus !== undefined && (
                <StatusBadge
                  tone={payTone(settledStatus)}
                  label={t('status.' + settledStatus, settledStatus)}
                />
              )}
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
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 'var(--s-2)',
                }}
              >
                {/* Scannable QR generated locally (no external service → the
                    payment handle never leaves the browser). */}
                <div
                  style={{ background: '#fff', padding: 'var(--s-3)', borderRadius: 'var(--r-sm)' }}
                >
                  <QRCodeSVG value={intent.qr} size={176} />
                </div>
                <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--faint)' }}>
                  {t('app.billing.scanQr')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <SectionHeader title={t('app.billing.history')} />
        <DataTable
          columns={histCols}
          rows={historyRows}
          rowKey={(r) => r.id}
          loading={history.isLoading}
          error={history.isError}
          onRetry={() => void history.refetch()}
          empty={t('app.billing.noHistory')}
        />
        <LoadMore
          hasNextPage={history.hasNextPage}
          isFetchingNextPage={history.isFetchingNextPage}
          onLoadMore={() => void history.fetchNextPage()}
        />
      </div>
    </div>
  );
}
