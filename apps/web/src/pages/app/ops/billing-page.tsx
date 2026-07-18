import type {
  ConsoleBalanceView,
  ConsoleCreateIntentBody,
  ConsoleIntentView,
  ConsolePaymentView,
  PaymentProviderKind,
  RedeemCodeBody,
} from '@actionow/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Lock, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, formatMicroCredits, toApiStateError } from '@/api/client';
import { useCursorQuery } from '@/api/hooks';
import { DateTimeText } from '@/components/common/date-time-text';
import { DetailList } from '@/components/common/detail-list';
import { FormField } from '@/components/common/form-field';
import { LoadMore } from '@/components/common/load-more';
import { MoneyText } from '@/components/common/money-text';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition, StatCard } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/components/radix/dialog';
import {
  Badge,
  Card,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
  DataTableToolbar,
} from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const PROVIDERS: readonly PaymentProviderKind[] = ['stripe', 'alipay', 'wechat', 'crypto'];

const providerLabelKey: Record<PaymentProviderKind, string> = {
  stripe: 'tenantOps.providerStripe',
  alipay: 'tenantOps.providerAlipay',
  wechat: 'tenantOps.providerWechat',
  crypto: 'tenantOps.providerCrypto',
};

const CURRENCIES = ['usd', 'cny'] as const;

const paymentStatusVariant: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  succeeded: 'success',
  pending: 'warning',
  created: 'warning',
  failed: 'danger',
  expired: 'danger',
  refunded: 'neutral',
};

const paymentStatusKey: Record<string, string> = {
  succeeded: 'tenantOps.statusSucceeded',
  pending: 'tenantOps.statusPending',
  created: 'tenantOps.statusCreated',
  failed: 'tenantOps.statusFailed',
  expired: 'tenantOps.statusExpired',
  refunded: 'tenantOps.statusRefunded',
};

/** `amount_minor` (minor-unit decimal string) → human major-unit amount + code. */
function formatAmountMinor(minor: string, currency: string): string {
  const value = Number(minor);
  const code = currency.toUpperCase();
  if (!Number.isFinite(value)) return `${minor} ${code}`;
  return `${(value / 100).toFixed(2)} ${code}`;
}

export function AppBillingPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const balance = useQuery({
    queryKey: ['console', 'balance'],
    queryFn: () => apiFetch<ConsoleBalanceView>('/console/balance'),
  });
  const payments = useCursorQuery<ConsolePaymentView>({
    key: ['console', 'payments'],
    path: '/console/payments',
    limit: 20,
  });

  const [topupOpen, setTopupOpen] = useState(false);
  const [provider, setProvider] = useState<PaymentProviderKind>('stripe');
  const [currency, setCurrency] = useState<string>('usd');
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | undefined>(undefined);
  const [intent, setIntent] = useState<ConsoleIntentView | null>(null);

  const topup = useMutation({
    mutationFn: (body: ConsoleCreateIntentBody) =>
      apiFetch<ConsoleIntentView>('/console/payments/intents', { method: 'POST', body }),
    onSuccess: (result) => {
      setIntent(result);
      void queryClient.invalidateQueries({ queryKey: ['console', 'payments'] });
    },
  });

  const [redeemOpen, setRedeemOpen] = useState(false);
  const [code, setCode] = useState('');
  const [redeemed, setRedeemed] = useState<{ credited: string; balance: string } | null>(null);

  const redeem = useMutation({
    mutationFn: (body: RedeemCodeBody) =>
      apiFetch<{ credited: string; balance: string }>('/console/redeem', {
        method: 'POST',
        body,
      }),
    onSuccess: (result) => {
      setRedeemed(result);
      void queryClient.invalidateQueries({ queryKey: ['console', 'balance'] });
    },
  });

  const openTopup = () => {
    topup.reset();
    setIntent(null);
    setAmount('');
    setAmountError(undefined);
    setTopupOpen(true);
  };

  const submitTopup = () => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setAmountError(t('tenantOps.amountInvalid'));
      return;
    }
    setAmountError(undefined);
    topup.mutate({ provider, amount_minor: Math.round(parsed * 100), currency });
  };

  const openRedeem = () => {
    redeem.reset();
    setRedeemed(null);
    setCode('');
    setRedeemOpen(true);
  };

  const submitRedeem = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    redeem.mutate({ code: trimmed });
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantOps.billingTitle')}
        description={t('tenantOps.billingDescription')}
        actions={
          <>
            <Button variant="outline" onClick={openRedeem}>
              <Gift />
              {t('tenantOps.redeem')}
            </Button>
            <Button onClick={openTopup}>
              <Wallet />
              {t('tenantOps.topup')}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t('tenantOps.statBalance')}
          detail={t('tenantOps.statBalanceDetail')}
          value={formatMicroCredits(balance.data?.balance)}
          icon={Wallet}
          emphasis
          loading={balance.isLoading}
        />
        <StatCard
          title={t('tenantOps.statHeld')}
          detail={t('tenantOps.statHeldDetail')}
          value={formatMicroCredits(balance.data?.held)}
          icon={Lock}
          loading={balance.isLoading}
        />
      </div>

      {balance.isError ? (
        <ApiErrorNotice
          className="mt-4"
          error={toApiStateError(balance.error)}
          onRetry={() => void balance.refetch()}
        />
      ) : null}

      <Card className="mt-6">
        <DataTableToolbar
          title={t('tenantOps.payments')}
          onRefresh={() => void payments.refetch()}
          refreshing={payments.isRefetching}
        />
        {payments.isLoading ? (
          <div className="p-4">
            <ResourceLoading rows={4} />
          </div>
        ) : payments.isError ? (
          <div className="p-4">
            <ApiErrorNotice
              error={toApiStateError(payments.error)}
              onRetry={() => void payments.refetch()}
            />
          </div>
        ) : payments.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t('tenantOps.paymentsEmpty')}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <DataTable>
                <DataTableHeader>
                  <DataTableRow>
                    <DataTableHead>{t('tenantOps.colProvider')}</DataTableHead>
                    <DataTableHead>{t('tenantOps.colPurpose')}</DataTableHead>
                    <DataTableHead>{t('tenantOps.colAmount')}</DataTableHead>
                    <DataTableHead>{t('tenantOps.colCredits')}</DataTableHead>
                    <DataTableHead>{t('common.status')}</DataTableHead>
                    <DataTableHead>{t('common.createdAt')}</DataTableHead>
                  </DataTableRow>
                </DataTableHeader>
                <DataTableBody>
                  {payments.rows.map((row) => {
                    const statusKey = paymentStatusKey[row.status];
                    return (
                      <DataTableRow key={row.id}>
                        <DataTableCell>
                          {row.provider in providerLabelKey
                            ? t(providerLabelKey[row.provider as PaymentProviderKind])
                            : row.provider}
                        </DataTableCell>
                        <DataTableCell className="font-mono text-xs text-muted-foreground">
                          {row.purpose}
                        </DataTableCell>
                        <DataTableCell className="font-mono tabular-nums">
                          {formatAmountMinor(row.amount_minor, row.currency)}
                        </DataTableCell>
                        <DataTableCell>
                          <MoneyText value={row.credit_amount} />
                        </DataTableCell>
                        <DataTableCell>
                          <Badge variant={paymentStatusVariant[row.status] ?? 'neutral'}>
                            {statusKey ? t(statusKey) : row.status}
                          </Badge>
                        </DataTableCell>
                        <DataTableCell>
                          <DateTimeText value={row.created_at} className="text-muted-foreground" />
                        </DataTableCell>
                      </DataTableRow>
                    );
                  })}
                </DataTableBody>
              </DataTable>
            </div>
            <div className="border-t px-4 pb-3">
              <LoadMore
                count={payments.rows.length}
                hasMore={payments.hasNextPage}
                loading={payments.isFetchingNextPage}
                onLoadMore={() => void payments.fetchNextPage()}
              />
            </div>
          </>
        )}
      </Card>

      <Dialog open={topupOpen} onOpenChange={setTopupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {intent ? t('tenantOps.topupCreated') : t('tenantOps.topupTitle')}
            </DialogTitle>
            <DialogDescription>
              {intent ? t('tenantOps.topupCreatedDescription') : t('tenantOps.topupDescription')}
            </DialogDescription>
          </DialogHeader>
          {intent ? (
            <div className="grid gap-4">
              <DetailList
                items={[
                  {
                    label: t('tenantOps.intentId'),
                    value: <span className="font-mono">{intent.intent_id}</span>,
                  },
                ]}
              />
              {intent.redirect_url ? (
                <Button asChild>
                  <a href={intent.redirect_url} target="_blank" rel="noreferrer">
                    {t('tenantOps.openCheckout')}
                  </a>
                </Button>
              ) : intent.qr ? (
                <div>
                  <p className="text-sm font-medium">{t('tenantOps.qrLabel')}</p>
                  <p className="mt-1.5 rounded-xl bg-surface-subtle p-3 font-mono text-xs break-all">
                    {intent.qr}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t('tenantOps.noCheckoutUrl')}</p>
              )}
            </div>
          ) : (
            <div className="grid gap-4">
              <FormField label={t('tenantOps.provider')}>
                {(id) => (
                  <Select
                    value={provider}
                    onValueChange={(value) => setProvider(value as PaymentProviderKind)}
                  >
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(providerLabelKey[kind])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField
                label={t('tenantOps.amount')}
                hint={t('tenantOps.amountHint')}
                error={amountError}
              >
                {(id) => (
                  <Input
                    id={id}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="decimal"
                    placeholder="10.00"
                  />
                )}
              </FormField>
              <FormField label={t('tenantOps.currency')}>
                {(id) => (
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger id={id}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((codeValue) => (
                        <SelectItem key={codeValue} value={codeValue}>
                          {codeValue.toUpperCase()}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              {topup.isError ? (
                <p className="text-sm text-danger">{toApiStateError(topup.error).message}</p>
              ) : null}
            </div>
          )}
          <DialogFooter>
            {intent ? (
              <Button variant="outline" onClick={() => setTopupOpen(false)}>
                {t('common.close')}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setTopupOpen(false)}
                  disabled={topup.isPending}
                >
                  {t('common.cancel')}
                </Button>
                <Button onClick={submitTopup} disabled={topup.isPending}>
                  {topup.isPending ? t('common.loading') : t('tenantOps.topupSubmit')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={redeemOpen} onOpenChange={setRedeemOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {redeemed ? t('tenantOps.redeemSuccess') : t('tenantOps.redeemTitle')}
            </DialogTitle>
            <DialogDescription>{t('tenantOps.redeemDescription')}</DialogDescription>
          </DialogHeader>
          {redeemed ? (
            <DetailList
              items={[
                { label: t('tenantOps.credited'), value: <MoneyText value={redeemed.credited} /> },
                { label: t('tenantOps.newBalance'), value: <MoneyText value={redeemed.balance} /> },
              ]}
            />
          ) : (
            <div className="grid gap-4">
              <FormField label={t('tenantOps.code')}>
                {(id) => (
                  <Input
                    id={id}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    className="font-mono"
                    autoComplete="off"
                  />
                )}
              </FormField>
              {redeem.isError ? (
                <p className="text-sm text-danger">{toApiStateError(redeem.error).message}</p>
              ) : null}
            </div>
          )}
          <DialogFooter>
            {redeemed ? (
              <Button variant="outline" onClick={() => setRedeemOpen(false)}>
                {t('common.close')}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  onClick={() => setRedeemOpen(false)}
                  disabled={redeem.isPending}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  onClick={submitRedeem}
                  disabled={redeem.isPending || code.trim().length === 0}
                >
                  {redeem.isPending ? t('common.loading') : t('tenantOps.redeemSubmit')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
