import { ArrowLeftIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useSetConsoleBack } from '../../components/console/ConsoleChrome';
import { ErrorState } from '../../components/data/ErrorState';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { RoseLoader } from '../../components/ui/RoseLoader';
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

  useSetConsoleBack({ to: BACK_TO, label: t('serviceTokens') });

  const tokens = useQuery({
    queryKey: qk.adminTokens(),
    queryFn: () => api.listAdminTokens(),
    staleTime: STALE_REFERENCE,
  });

  const token = (tokens.data ?? []).find((tk) => tk.id === id);

  if (tokens.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--s-6)' }}>
        <RoseLoader size={56} />
      </div>
    );
  }
  if (tokens.isError) {
    return (
      <div style={{ padding: 'var(--s-5)' }}>
        <ErrorState onRetry={() => void tokens.refetch()} />
      </div>
    );
  }
  if (token === undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
        <BackLink label={t('tokens.detail.back')} />
        <NotFound message={t('tokens.detail.notFound')} />
      </div>
    );
  }

  return <ServiceTokenDetailBody token={token} />;
}

/** The page's top-of-content back link (mirrors the TopBar back slot). */
function BackLink({ label }: { label: string }) {
  return (
    <Link
      to={BACK_TO}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        fontSize: 'var(--fs-sm)',
        color: 'var(--muted)',
        textDecoration: 'none',
        width: 'fit-content',
      }}
    >
      <ArrowLeftIcon size={14} weight="bold" aria-hidden="true" />
      {label}
    </Link>
  );
}

function NotFound({ message }: { message: string }) {
  return (
    <div
      className="panel"
      style={{
        borderRadius: 'var(--r-md)',
        padding: 'var(--s-5)',
        color: 'var(--muted)',
        fontSize: 'var(--fs-sm)',
        textAlign: 'center',
      }}
    >
      {message}
    </div>
  );
}

/** One label / value row in the token detail header. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
      <span
        style={{
          fontSize: 'var(--fs-caption)',
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--faint)',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 'var(--fs-sm)' }}>{children}</span>
    </div>
  );
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
      <BackLink label={t('tokens.detail.back')} />
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
    </div>
  );
}
