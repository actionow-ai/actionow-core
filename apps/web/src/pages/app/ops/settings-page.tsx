import type { ConsoleChangePasswordBody, ConsoleMeView } from '@actionow/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { apiFetch, toApiStateError } from '@/api/client';
import { DetailList } from '@/components/common/detail-list';
import { FormField } from '@/components/common/form-field';
import { ApiErrorNotice, ResourceLoading } from '@/components/shell/api-state';
import { PageHeader, PageTransition } from '@/components/shell/page';
import { Button } from '@/components/ui/components/buttons/button';
import { Badge, Card } from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';

export function AppSettingsPage() {
  const { t } = useTranslation();

  const me = useQuery({
    queryKey: ['console', 'me'],
    queryFn: () => apiFetch<ConsoleMeView>('/console/me'),
  });

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordError, setNewPasswordError] = useState<string | undefined>(undefined);
  const [changed, setChanged] = useState(false);

  const changePassword = useMutation({
    mutationFn: (body: ConsoleChangePasswordBody) =>
      apiFetch<{ ok: true }>('/console/settings', { method: 'PATCH', body }),
    onSuccess: () => {
      setChanged(true);
      setCurrentPassword('');
      setNewPassword('');
    },
  });

  const submitPassword = () => {
    setChanged(false);
    if (newPassword.length < 8) {
      setNewPasswordError(t('tenantOps.passwordTooShort'));
      return;
    }
    setNewPasswordError(undefined);
    changePassword.mutate({ currentPassword, newPassword });
  };

  return (
    <PageTransition>
      <PageHeader
        title={t('tenantOps.settingsTitle')}
        description={t('tenantOps.settingsDescription')}
      />

      <div className="grid max-w-2xl gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('tenantOps.accountTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('tenantOps.accountDescription')}</p>
          {me.isLoading ? (
            <div className="mt-4">
              <ResourceLoading rows={3} />
            </div>
          ) : me.isError ? (
            <ApiErrorNotice
              className="mt-4"
              error={toApiStateError(me.error)}
              onRetry={() => void me.refetch()}
            />
          ) : me.data ? (
            <DetailList
              className="mt-3"
              items={[
                {
                  label: t('tenantOps.email'),
                  value: (
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      {me.data.email}
                      {me.data.email_verified ? (
                        <Badge variant="success">{t('tenantOps.verified')}</Badge>
                      ) : (
                        <Badge variant="warning">{t('tenantOps.unverified')}</Badge>
                      )}
                    </span>
                  ),
                },
                { label: t('tenantOps.role'), value: me.data.role },
                { label: t('tenantOps.tenantRole'), value: me.data.tenant_role ?? '—' },
                {
                  label: t('tenantOps.tenantId'),
                  value: <span className="font-mono">{me.data.tenant_id ?? '—'}</span>,
                },
                { label: t('common.status'), value: me.data.status },
              ]}
            />
          ) : null}
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold">{t('tenantOps.passwordTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('tenantOps.passwordDescription')}</p>
          <div className="mt-4 grid gap-4">
            <FormField label={t('tenantOps.currentPassword')}>
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                />
              )}
            </FormField>
            <FormField
              label={t('tenantOps.newPassword')}
              hint={t('tenantOps.newPasswordHint')}
              error={newPasswordError}
            >
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              )}
            </FormField>
            {changePassword.isError ? (
              <p className="text-sm text-danger">{toApiStateError(changePassword.error).message}</p>
            ) : null}
            {changed ? (
              <p className="text-sm text-success">{t('tenantOps.passwordChanged')}</p>
            ) : null}
            <div>
              <Button
                onClick={submitPassword}
                disabled={
                  changePassword.isPending ||
                  currentPassword.length === 0 ||
                  newPassword.length === 0
                }
              >
                {changePassword.isPending ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </PageTransition>
  );
}
