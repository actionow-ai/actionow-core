import { PlusIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction, useSetConsoleFilters } from '../../components/console/ConsoleChrome';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { LoadMore } from '../../components/data/LoadMore';
import { Money } from '../../components/data/Money';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { SecretRevealModal } from '../../components/ui/SecretRevealModal';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { GenerateCodesBody, RedemptionCodeView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { useUrlState } from '../../lib/useUrlState';

/** A YYYY-MM-DD date → an ISO-8601 instant (midnight UTC); pass other values through. */
function toIso(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function RedemptionCodesPage() {
  const { t } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();

  const [status, setStatus] = useUrlState('status');
  const filter = status === 'unused' || status === 'redeemed' ? status : undefined;
  const codes = useInfiniteQuery({
    queryKey: qk.redemptionCodes(filter),
    queryFn: ({ pageParam }) =>
      api.listRedemptionCodes({ status: filter, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = codes.data?.pages.flatMap((p) => p.rows) ?? [];

  const [formOpen, setFormOpen] = useState(false);
  const [count, setCount] = useState(10);
  const [creditsPerCode, setCreditsPerCode] = useState(0);
  const [expiresAt, setExpiresAt] = useState('');
  const [minted, setMinted] = useState<string[] | null>(null);

  const generate = useMutation({
    mutationFn: () => {
      const body: GenerateCodesBody = { count, creditsPerCode };
      if (expiresAt.trim() !== '') body.expiresAt = toIso(expiresAt.trim());
      return api.generateCodes(body);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.redemptionCodes() });
      setFormOpen(false);
      setExpiresAt('');
      setMinted(r.codes);
    },
    onError: mutationError(t),
  });

  const canSubmit = count >= 1 && creditsPerCode > 0;

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setFormOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('redemptionCodes.generate')}
      </Button>
    ),
    [t],
  );

  useSetConsoleFilters(
    () => (
      <div style={{ width: 240 }}>
        <SelectField
          inline
          label={t('redemptionCodes.cols.status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'unused', label: t('redemptionCodes.status.unused') },
            { value: 'redeemed', label: t('redemptionCodes.status.redeemed') },
          ]}
          placeholder={t('redemptionCodes.allStatuses')}
        />
      </div>
    ),
    [t, status, setStatus],
  );

  const cols: Column<RedemptionCodeView>[] = [
    {
      key: 'code',
      header: t('redemptionCodes.cols.code'),
      grow: true,
      noClip: true,
      cell: (r) => <code style={{ fontSize: 'var(--fs-sm)' }}>{r.code}</code>,
    },
    {
      key: 'credit',
      header: t('redemptionCodes.cols.creditAmount'),
      numeric: true,
      cell: (r) => <Money micro={r.credit_amount} />,
      width: '120px',
    },
    {
      key: 'status',
      header: t('redemptionCodes.cols.status'),
      noClip: true,
      cell: (r) => (
        <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
      ),
      width: '120px',
    },
    {
      key: 'redeemedBy',
      header: t('redemptionCodes.cols.redeemedBy'),
      width: '200px',
      cell: (r) => r.redeemed_by_tenant ?? '—',
    },
    {
      key: 'expires',
      header: t('redemptionCodes.cols.expiresAt'),
      cell: (r) => (r.expires_at !== null ? new Date(r.expires_at).toLocaleDateString() : '—'),
      width: '120px',
    },
    {
      key: 'created',
      header: t('redemptionCodes.cols.created'),
      cell: (r) => new Date(r.created_at).toLocaleDateString(),
      width: '120px',
    },
  ];

  return (
    <div style={{ height: '100%' }}>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.code}
        loading={codes.isLoading}
        error={codes.isError}
        onRetry={() => void codes.refetch()}
        empty={t('redemptionCodes.empty')}
        searchable
      />
      <LoadMore
        hasNextPage={codes.hasNextPage}
        isFetchingNextPage={codes.isFetchingNextPage}
        onLoadMore={() => void codes.fetchNextPage()}
      />

      <Modal
        open={formOpen}
        title={t('redemptionCodes.generate')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button
            variant="cta"
            onClick={() => generate.mutate()}
            loading={generate.isPending}
            disabled={!canSubmit}
          >
            {t('redemptionCodes.submit')}
          </Button>
        }
      >
        <NumberField
          label={t('redemptionCodes.form.count')}
          value={count}
          onChange={setCount}
          min={1}
          step={1}
        />
        <NumberField
          label={t('redemptionCodes.form.creditPerCode')}
          value={creditsPerCode}
          onChange={setCreditsPerCode}
          min={1}
          step={1}
        />
        <TextField
          label={t('redemptionCodes.form.expiresAt')}
          hint={t('redemptionCodes.form.expiresHint')}
          value={expiresAt}
          onChange={setExpiresAt}
        />
      </Modal>

      <SecretRevealModal
        open={minted !== null}
        title={t('redemptionCodes.minted.title')}
        onClose={() => setMinted(null)}
        value={minted ?? []}
        warn={t('redemptionCodes.minted.warn')}
        copyLabel={t('redemptionCodes.minted.copy')}
        copiedLabel={t('redemptionCodes.minted.copied')}
        doneLabel={t('redemptionCodes.minted.done')}
      />
    </div>
  );
}
