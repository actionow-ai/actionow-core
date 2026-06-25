import { ArrowsClockwiseIcon, KeyIcon, PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { EntityCard } from '../../components/data/EntityCard';
import { LoadMore } from '../../components/data/LoadMore';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { NumberField } from '../../components/ui/NumberField';
import { SelectField } from '../../components/ui/SelectField';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleApiKeyView, ConsoleCreateApiKeyBody } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';
import { STALE_REFERENCE } from '../../lib/query';
import { AdminOnlyNote } from './AdminOnlyNote';
import { useTenantRole } from './useTenantRole';

export function AppKeys() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();
  // RBAC v1: mint/rotate/disable are admin-only writes — a member sees a
  // read-only list (the backend TenantAdminGuard 403s the writes regardless).
  const { isTenantAdmin } = useTenantRole();

  const keys = useInfiniteQuery({
    queryKey: qk.consoleApiKeys(),
    queryFn: ({ pageParam }) => api.listApiKeys({ cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = keys.data?.pages.flatMap((p) => p.rows) ?? [];

  // End-users (subjects) of the tenant — the optional mint scope. Admin-only
  // (the backend 403s a member), so the query is gated off `isTenantAdmin`.
  const subjects = useQuery({
    queryKey: qk.consoleSubjects(),
    queryFn: () => api.listSubjects(),
    enabled: isTenantAdmin,
    staleTime: STALE_REFERENCE,
  });
  const subjectOptions = (subjects.data ?? []).map((s) => ({
    value: s.id,
    label: s.display_name ?? s.external_id ?? s.email ?? s.id.slice(0, 8),
  }));

  const [formOpen, setFormOpen] = useState(false);
  const [allowlist, setAllowlist] = useState('');
  const [rateLimit, setRateLimit] = useState(0);
  const [subjectId, setSubjectId] = useState('');
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<ConsoleApiKeyView | undefined>(undefined);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.consoleApiKeys() });

  // Mint with optional scoping — the card already renders rate_limit/allowlist
  // chips, so without this form those were dead UI (always empty). An optional
  // subject binds the key to one end-user (its calls attributed/isolated there).
  const mint = useMutation({
    mutationFn: () => {
      const body: ConsoleCreateApiKeyBody = {};
      const allow = allowlist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (allow.length > 0) body.resourceAllowlist = allow;
      if (rateLimit > 0) body.rateLimit = rateLimit;
      // Empty = a tenant-level key (no end-user scope).
      if (subjectId !== '') body.subjectId = subjectId;
      return api.createApiKey(body);
    },
    onSuccess: async (r) => {
      await invalidate();
      setFormOpen(false);
      setAllowlist('');
      setRateLimit(0);
      setSubjectId('');
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });
  const rotate = useMutation({
    mutationFn: (id: string) => api.rotateApiKey(id),
    onSuccess: async (r) => {
      await invalidate();
      setPlaintext(r.plaintext);
    },
    onError: mutationError(t),
  });
  const disable = useMutation({
    mutationFn: (id: string) => api.disableApiKey(id),
    onSuccess: async () => {
      await invalidate();
      toast(t('app.keys.disabled'));
      setDisableTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () =>
      isTenantAdmin ? (
        <Button variant="ghost" onClick={() => setFormOpen(true)}>
          <PlusIcon size={14} weight="bold" /> {t('app.keys.mint')}
        </Button>
      ) : null,
    [t, isTenantAdmin],
  );

  return (
    <>
      {!isTenantAdmin && (
        <div style={{ marginBottom: 'var(--s-3)' }}>
          <AdminOnlyNote />
        </div>
      )}
      <CardCollection
        rows={rows}
        loading={keys.isLoading}
        error={keys.isError}
        onRetry={() => void keys.refetch()}
        empty={t('app.keys.empty')}
        renderCard={(r) => (
          <EntityCard
            key={r.id}
            icon={KeyIcon}
            title={<code style={{ fontSize: 'var(--fs-sm)' }}>{r.id}</code>}
            badge={
              <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />
            }
            chips={[
              ...(r.subject_id !== null
                ? [`${t('apiKeys.subject.chip')}: ${r.subject_id.slice(0, 8)}`]
                : []),
              ...(r.rate_limit !== null ? [`${String(r.rate_limit)}/min`] : []),
              ...(r.resource_allowlist.length > 0 ? r.resource_allowlist : []),
            ]}
            meta={[
              {
                label: t('apiKeys.cols.created'),
                value: new Date(r.created_at).toLocaleDateString(),
              },
            ]}
            actions={
              isTenantAdmin && r.status === 'active' ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => rotate.mutate(r.id)}
                    loading={rotate.isPending && rotate.variables === r.id}
                  >
                    <ArrowsClockwiseIcon size={14} /> {t('app.keys.rotate')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDisableTarget(r)}>
                    <ProhibitIcon size={14} /> {t('app.keys.disable')}
                  </Button>
                </>
              ) : undefined
            }
          />
        )}
      />
      <LoadMore
        hasNextPage={keys.hasNextPage}
        isFetchingNextPage={keys.isFetchingNextPage}
        onLoadMore={() => void keys.fetchNextPage()}
      />

      <Modal
        open={formOpen}
        title={t('app.keys.mint')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button variant="cta" onClick={() => mint.mutate()} loading={mint.isPending}>
            {t('apiKeys.submit')}
          </Button>
        }
      >
        <TextField label={t('apiKeys.form.allowlist')} value={allowlist} onChange={setAllowlist} />
        <NumberField
          label={t('apiKeys.form.rateLimit')}
          value={rateLimit}
          onChange={setRateLimit}
          min={0}
        />
        <SelectField
          label={t('apiKeys.subject.label')}
          tooltip={t('apiKeys.subject.tip')}
          value={subjectId}
          onChange={setSubjectId}
          options={subjectOptions}
          placeholder={t('apiKeys.subject.none')}
        />
      </Modal>

      <Modal
        open={plaintext !== null}
        title={t('apiKeys.reveal.title')}
        onClose={() => setPlaintext(null)}
        footer={
          <Button variant="cta" onClick={() => setPlaintext(null)}>
            {t('apiKeys.reveal.done')}
          </Button>
        }
      >
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--run)' }}>
          {t('apiKeys.reveal.warn')}
        </div>
        {plaintext !== null && (
          <CopyField
            value={plaintext}
            copyLabel={t('apiKeys.reveal.copy')}
            copiedLabel={t('apiKeys.reveal.copied')}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={disableTarget !== undefined}
        title={t('app.keys.confirmDisableTitle')}
        message={t('app.keys.confirmDisableMsg', { id: disableTarget?.id ?? '' })}
        confirmLabel={t('app.keys.disable')}
        cancelLabel={t('common.cancel')}
        danger
        loading={disable.isPending}
        onConfirm={() => {
          if (disableTarget !== undefined) disable.mutate(disableTarget.id);
        }}
        onClose={() => setDisableTarget(undefined)}
      />
    </>
  );
}
