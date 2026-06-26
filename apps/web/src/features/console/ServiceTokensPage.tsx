import { PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CopyField } from '../../components/data/CopyField';
import type { Column } from '../../components/data/DataTable';
import { DataTable } from '../../components/data/DataTable';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { FIELD_INPUT_BASE } from '../../components/ui/fieldStyles';
import { Modal } from '../../components/ui/Modal';
import { RowAction } from '../../components/ui/RowAction';
import { TextField } from '../../components/ui/TextField';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { AdminTokenView } from '../../lib/api/types';
import { useAdminApi } from '../../lib/api/useAdminApi';

/**
 * Admin SERVICE TOKENS (M2M credentials for the `/admin` API): mint (plaintext
 * `at_…` shown ONCE), list (metadata only), revoke. Distinct from tenant API keys
 * (`ApiKeysPage`) — these authenticate an integration AS an operator. Optional
 * expiry; omitted → never expires.
 */
export function ServiceTokensPage() {
  const { t, i18n } = useTranslation('console');
  const api = useAdminApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const tokens = useQuery({
    queryKey: qk.adminTokens(),
    queryFn: () => api.listAdminTokens(),
  });

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState(''); // datetime-local string; '' = never
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AdminTokenView | undefined>(undefined);

  const create = useMutation({
    mutationFn: () =>
      api.createAdminToken({
        name: name.trim(),
        // datetime-local → full ISO-8601 (the schema requires `.datetime()`).
        expiresAt: expiresAt.trim() === '' ? undefined : new Date(expiresAt).toISOString(),
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.adminTokens() });
      setFormOpen(false);
      setName('');
      setExpiresAt('');
      setPlaintext(r.plaintext); // one-time reveal
    },
    onError: mutationError(t),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeAdminToken(id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.adminTokens() });
      toast(t('tokens.revoked'));
      setRevokeTarget(undefined);
    },
    onError: mutationError(t),
  });

  useSetConsoleAction(
    () => (
      <Button variant="ghost" onClick={() => setFormOpen(true)}>
        <PlusIcon size={14} weight="bold" /> {t('tokens.new')}
      </Button>
    ),
    [t],
  );

  const cols: Column<AdminTokenView>[] = [
    { key: 'name', header: t('tokens.cols.name'), grow: true, cell: (r) => r.name },
    {
      key: 'status',
      header: t('tokens.cols.status'),
      noClip: true,
      width: '148px',
      cell: (r) => <StatusBadge tone={statusTone(r.status)} label={t('status.' + r.status, r.status)} />,
    },
    {
      key: 'created',
      header: t('tokens.cols.created'),
      width: '170px',
      cell: (r) => new Date(r.created_at).toLocaleDateString(i18n.language),
    },
    {
      key: 'expires',
      header: t('tokens.cols.expires'),
      align: 'right',
      width: '180px',
      cell: (r) =>
        r.expires_at !== null ? new Date(r.expires_at).toLocaleString(i18n.language) : t('tokens.never'),
    },
  ];

  return (
    <div style={{ height: '100%' }}>
      <DataTable
        columns={cols}
        rows={tokens.data ?? []}
        rowKey={(r) => r.id}
        loading={tokens.isLoading}
        error={tokens.isError}
        onRetry={() => void tokens.refetch()}
        empty={t('tokens.empty')}
        onRowClick={(r) => void navigate('/console/tokens/' + r.id)}
        rowActions={(r) => (
          <RowAction
            icon={ProhibitIcon}
            label={t('tokens.revoke')}
            danger
            onClick={() => setRevokeTarget(r)}
          />
        )}
      />

      <Modal
        open={formOpen}
        title={t('tokens.new')}
        onClose={() => setFormOpen(false)}
        footer={
          <Button
            variant="cta"
            onClick={() => create.mutate()}
            loading={create.isPending}
            disabled={name.trim() === ''}
          >
            {t('tokens.submit')}
          </Button>
        }
      >
        <TextField label={t('tokens.form.name')} value={name} onChange={setName} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>
            {t('tokens.form.expiresAt')}
          </span>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            style={FIELD_INPUT_BASE}
          />
        </label>
      </Modal>

      {/* One-time reveal of the minted token (never shown again). */}
      <Modal
        open={plaintext !== null}
        title={t('tokens.reveal.title')}
        onClose={() => setPlaintext(null)}
        footer={
          <Button variant="cta" onClick={() => setPlaintext(null)}>
            {t('common.confirm')}
          </Button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          <span style={{ color: 'var(--fail)', fontSize: 'var(--fs-sm)' }}>
            {t('tokens.reveal.warn')}
          </span>
          {plaintext !== null && (
            <CopyField
              value={plaintext}
              copyLabel={t('common.copy')}
              copiedLabel={t('common.copied')}
              failedLabel={t('common.copyFailed')}
            />
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== undefined}
        title={t('tokens.revokeConfirm.title')}
        message={t('tokens.revokeConfirm.msg', { name: revokeTarget?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (revokeTarget !== undefined) revoke.mutate(revokeTarget.id);
        }}
        onClose={() => setRevokeTarget(undefined)}
      />
    </div>
  );
}
