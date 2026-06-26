import { TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { useSetConsoleBack } from '../../components/console/ConsoleChrome';
import { DetailPage, DetailRow } from '../../components/console/DetailScaffold';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { AdminTokenView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';
import { STALE_REFERENCE } from '../../lib/query';

const BACK_TO = '/console/tokens';

/**
 * The routed service-token detail page (`/console/tokens/:id`) — the full-page
 * successor to the former list `EntityCard`. The tokens list returns metadata
 * only (no get-by-id endpoint), so the token is resolved from that list by `:id`.
 * Renders name, status, created/expires/created-by, and a revoke action that
 * invalidates the same list the directory table reads, then navigates back.
 */
export function ServiceTokenDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation('console');
  const api = useAdminApi();

  useSetConsoleBack({ to: BACK_TO, label: t('nav.serviceTokens') });

  const tokens = useQuery({
    queryKey: qk.adminTokens(),
    queryFn: () => api.listAdminTokens(),
    staleTime: STALE_REFERENCE,
  });

  const token = (tokens.data ?? []).find((tk) => tk.id === id);

  if (tokens.isLoading || tokens.isError || token === undefined) {
    return (
      <DetailPage
        backTo={BACK_TO}
        backLabel={t('tokens.detail.back')}
        loading={tokens.isLoading}
        error={tokens.isError}
        onRetry={() => void tokens.refetch()}
        notFound={token === undefined}
        notFoundMessage={t('tokens.detail.notFound')}
      />
    );
  }

  return <ServiceTokenDetailBody token={token} />;
}

/** The detail body — the former card content as a page (name, status, created/
 * expires/created-by) plus revoke (→ navigate back on success). */
function ServiceTokenDetailBody({ token }: { token: AdminTokenView }) {
  const { t, i18n } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const revoke = useMutation({
    mutationFn: () => api.revokeAdminToken(token.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.adminTokens() });
      toast(t('tokens.revoked'));
      setConfirmRevoke(false);
      void navigate(BACK_TO);
    },
    onError: mutationError(t),
  });

  return (
    <DetailPage
      backTo={BACK_TO}
      backLabel={t('tokens.detail.back')}
      notFoundMessage={t('tokens.detail.notFound')}
    >
      <h1
        style={{
          fontSize: 'var(--fs-lg)',
          fontWeight: 'var(--fw-medium)',
          margin: 0,
          wordBreak: 'break-all',
        }}
      >
        {token.name}
      </h1>

      <DetailRow label={t('tokens.cols.status')}>
        <StatusBadge
          tone={statusTone(token.status)}
          label={t('status.' + token.status, token.status)}
        />
      </DetailRow>

      <DetailRow label={t('tokens.cols.created')}>
        {new Date(token.created_at).toLocaleString(i18n.language)}
      </DetailRow>

      <DetailRow label={t('tokens.cols.expires')}>
        {token.expires_at !== null
          ? new Date(token.expires_at).toLocaleString(i18n.language)
          : t('tokens.never')}
      </DetailRow>

      <DetailRow label={t('tokens.detail.createdBy')}>{token.created_by}</DetailRow>

      <div>
        <Button variant="ghost" onClick={() => setConfirmRevoke(true)}>
          <TrashIcon size={14} weight="bold" aria-hidden="true" /> {t('tokens.revoke')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        title={t('tokens.revokeConfirm.title')}
        message={t('tokens.revokeConfirm.msg', { name: token.name })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revoke.isPending}
        onConfirm={() => revoke.mutate()}
        onClose={() => setConfirmRevoke(false)}
      />
    </DetailPage>
  );
}
