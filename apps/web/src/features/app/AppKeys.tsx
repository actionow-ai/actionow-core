import { ArrowsClockwiseIcon, PlusIcon, ProhibitIcon } from '@phosphor-icons/react';
import { KeyIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSetConsoleAction } from '../../components/console/ConsoleChrome';
import { CardCollection } from '../../components/data/CardCollection';
import { CopyField } from '../../components/data/CopyField';
import { EntityCard } from '../../components/data/EntityCard';
import { StatusBadge, statusTone } from '../../components/data/StatusBadge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Modal } from '../../components/ui/Modal';
import { toast } from '../../components/ui/toast';
import { mutationError } from '../../lib/api/mutationError';
import { qk } from '../../lib/api/queryKeys';
import type { ConsoleApiKeyView } from '../../lib/api/types';
import { useConsoleApi } from '../../lib/api/useConsoleApi';

export function AppKeys() {
  const { t } = useTranslation('console');
  const api = useConsoleApi();
  const qc = useQueryClient();

  const keys = useQuery({ queryKey: qk.consoleApiKeys(), queryFn: () => api.listApiKeys() });
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<ConsoleApiKeyView | undefined>(undefined);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.consoleApiKeys() });

  const mint = useMutation({
    mutationFn: () => api.createApiKey({}),
    onSuccess: async (r) => {
      await invalidate();
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
    () => (
      <Button variant="ghost" onClick={() => mint.mutate()} loading={mint.isPending}>
        <PlusIcon size={14} weight="bold" /> {t('app.keys.mint')}
      </Button>
    ),
    [t, mint.isPending],
  );

  return (
    <>
      <CardCollection
        rows={keys.data?.rows ?? []}
        loading={keys.isLoading}
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
              r.status === 'active' ? (
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
          if (disableTarget) disable.mutate(disableTarget.id);
        }}
        onClose={() => setDisableTarget(undefined)}
      />
    </>
  );
}
